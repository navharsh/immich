import {
  AssetCore,
  IAssetJob,
  IAssetRepository,
  IBaseJob,
  IGeocodingRepository,
  IJobRepository,
  JobName,
  JOBS_ASSET_PAGINATION_SIZE,
  QueueName,
  usePagination,
  WithoutProperty,
  WithProperty,
} from '@app/domain';
import { AssetEntity, AssetType, ExifEntity } from '@app/infra/entities';
import { Process, Processor } from '@nestjs/bull';
import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import tz_lookup from '@photostructure/tz-lookup';
import { Job } from 'bull';
import { ExifDateTime, exiftool, Tags } from 'exiftool-vendored';
import ffmpeg, { FfprobeData } from 'fluent-ffmpeg';
import { Duration } from 'luxon';
import fs from 'node:fs';
import sharp from 'sharp';
import { Repository } from 'typeorm/repository/Repository';
import { promisify } from 'util';

const ffprobe = promisify<string, FfprobeData>(ffmpeg.ffprobe);

interface ImmichTags extends Tags {
  ContentIdentifier?: string;
}

@Processor(QueueName.METADATA_EXTRACTION)
export class MetadataExtractionProcessor {
  private logger = new Logger(MetadataExtractionProcessor.name);
  private assetCore: AssetCore;
  private reverseGeocodingEnabled: boolean;

  constructor(
    @Inject(IAssetRepository) private assetRepository: IAssetRepository,
    @Inject(IJobRepository) private jobRepository: IJobRepository,
    @Inject(IGeocodingRepository) private geocodingRepository: IGeocodingRepository,
    @InjectRepository(ExifEntity) private exifRepository: Repository<ExifEntity>,

    configService: ConfigService,
  ) {
    this.assetCore = new AssetCore(assetRepository, jobRepository);
    this.reverseGeocodingEnabled = !configService.get('DISABLE_REVERSE_GEOCODING');
  }

  async init(deleteCache = false) {
    this.logger.warn(`Reverse geocoding is ${this.reverseGeocodingEnabled ? 'enabled' : 'disabled'}`);
    if (!this.reverseGeocodingEnabled) {
      return;
    }

    try {
      if (deleteCache) {
        await this.geocodingRepository.deleteCache();
      }
      this.logger.log('Initializing Reverse Geocoding');

      await this.jobRepository.pause(QueueName.METADATA_EXTRACTION);
      await this.geocodingRepository.init();
      await this.jobRepository.resume(QueueName.METADATA_EXTRACTION);

      this.logger.log('Reverse Geocoding Initialized');
    } catch (error: any) {
      this.logger.error(`Unable to initialize reverse geocoding: ${error}`, error?.stack);
    }
  }

  @Process(JobName.QUEUE_METADATA_EXTRACTION)
  async handleQueueMetadataExtraction(job: Job<IBaseJob>) {
    try {
      const { force } = job.data;
      const assetPagination = usePagination(JOBS_ASSET_PAGINATION_SIZE, (pagination) => {
        return force
          ? this.assetRepository.getAll(pagination)
          : this.assetRepository.getWithout(pagination, WithoutProperty.EXIF);
      });

      for await (const assets of assetPagination) {
        for (const asset of assets) {
          const name = asset.type === AssetType.VIDEO ? JobName.EXTRACT_VIDEO_METADATA : JobName.EXIF_EXTRACTION;
          await this.jobRepository.queue({ name, data: { asset } });
        }
      }
    } catch (error: any) {
      this.logger.error(`Unable to queue metadata extraction`, error?.stack);
    }
  }

  @Process(JobName.EXIF_EXTRACTION)
  async extractExifInfo(job: Job<IAssetJob>) {
    let asset = job.data.asset;

    try {
      const mediaExifData = await exiftool.read<ImmichTags>(asset.originalPath).catch((error: any) => {
        this.logger.warn(
          `The exifData parsing failed due to ${error} for asset ${asset.id} at ${asset.originalPath}`,
          error?.stack,
        );
        return null;
      });
      const sidecarExifData = asset.sidecarPath
        ? await exiftool.read<ImmichTags>(asset.sidecarPath).catch((error: any) => {
            this.logger.warn(
              `The exifData parsing failed due to ${error} for asset ${asset.id} at ${asset.originalPath}`,
              error?.stack,
            );
            return null;
          })
        : {};

      const exifToDate = (exifDate: string | ExifDateTime | undefined) => {
        if (!exifDate) return null;

        if (typeof exifDate === 'string') {
          return new Date(exifDate);
        }

        return exifDate.toDate();
      };

      const exifTimeZone = (exifDate: string | ExifDateTime | undefined) => {
        if (!exifDate) return null;

        if (typeof exifDate === 'string') {
          return null;
        }

        return exifDate.zone ?? null;
      };

      const getExifProperty = <T extends keyof ImmichTags>(...properties: T[]): any | null => {
        for (const property of properties) {
          const value = sidecarExifData?.[property] ?? mediaExifData?.[property];
          if (value !== null && value !== undefined) {
            return value;
          }
        }

        return null;
      };

      const timeZone = exifTimeZone(getExifProperty('DateTimeOriginal', 'CreateDate') ?? asset.fileCreatedAt);
      const fileCreatedAt = exifToDate(getExifProperty('DateTimeOriginal', 'CreateDate') ?? asset.fileCreatedAt);
      const fileModifiedAt = exifToDate(getExifProperty('ModifyDate') ?? asset.fileModifiedAt);
      const fileStats = fs.statSync(asset.originalPath);
      const fileSizeInBytes = fileStats.size;

      const newExif = new ExifEntity();
      newExif.assetId = asset.id;
      newExif.fileSizeInByte = fileSizeInBytes;
      newExif.make = getExifProperty('Make');
      newExif.model = getExifProperty('Model');
      newExif.exifImageHeight = getExifProperty('ExifImageHeight', 'ImageHeight');
      newExif.exifImageWidth = getExifProperty('ExifImageWidth', 'ImageWidth');
      newExif.exposureTime = getExifProperty('ExposureTime');
      newExif.orientation = getExifProperty('Orientation')?.toString();
      newExif.dateTimeOriginal = fileCreatedAt;
      newExif.modifyDate = fileModifiedAt;
      newExif.timeZone = timeZone;
      newExif.lensModel = getExifProperty('LensModel');
      newExif.fNumber = getExifProperty('FNumber');
      const focalLength = getExifProperty('FocalLength');
      newExif.focalLength = focalLength ? parseFloat(focalLength) : null;
      // This is unusual - exifData.ISO should return a number, but experienced that sidecar XMP
      // files MAY return an array of numbers instead.
      const iso = getExifProperty('ISO');
      newExif.iso = Array.isArray(iso) ? iso[0] : iso || null;
      newExif.latitude = getExifProperty('GPSLatitude');
      newExif.longitude = getExifProperty('GPSLongitude');
      newExif.livePhotoCID = getExifProperty('MediaGroupUUID');

      if (newExif.livePhotoCID && !asset.livePhotoVideoId) {
        const motionAsset = await this.assetCore.findLivePhotoMatch({
          livePhotoCID: newExif.livePhotoCID,
          otherAssetId: asset.id,
          ownerId: asset.ownerId,
          type: AssetType.VIDEO,
        });
        if (motionAsset) {
          await this.assetCore.save({ id: asset.id, livePhotoVideoId: motionAsset.id });
          await this.assetCore.save({ id: motionAsset.id, isVisible: false });
        }
      }

      await this.applyReverseGeocoding(asset, newExif);

      /**
       * IF the EXIF doesn't contain the width and height of the image,
       * We will use Sharpjs to get the information.
       */
      if (!newExif.exifImageHeight || !newExif.exifImageWidth || !newExif.orientation) {
        const metadata = await sharp(asset.originalPath).metadata();

        if (newExif.exifImageHeight === null) {
          newExif.exifImageHeight = metadata.height || null;
        }

        if (newExif.exifImageWidth === null) {
          newExif.exifImageWidth = metadata.width || null;
        }

        if (newExif.orientation === null) {
          newExif.orientation = metadata.orientation !== undefined ? `${metadata.orientation}` : null;
        }
      }

      await this.exifRepository.upsert(newExif, { conflictPaths: ['assetId'] });
      asset = await this.assetCore.save({ id: asset.id, fileCreatedAt: fileCreatedAt?.toISOString() });
      await this.jobRepository.queue({ name: JobName.STORAGE_TEMPLATE_MIGRATION_SINGLE, data: { asset } });
    } catch (error: any) {
      this.logger.error(
        `Error extracting EXIF ${error} for assetId ${asset.id} at ${asset.originalPath}`,
        error?.stack,
      );
    }
  }

  @Process({ name: JobName.EXTRACT_VIDEO_METADATA, concurrency: 2 })
  async extractVideoMetadata(job: Job<IAssetJob>) {
    let asset = job.data.asset;

    if (!asset.isVisible) {
      return;
    }

    try {
      const data = await ffprobe(asset.originalPath);
      const durationString = this.extractDuration(data.format.duration || asset.duration);
      let fileCreatedAt = asset.fileCreatedAt;

      const videoTags = data.format.tags;
      if (videoTags) {
        if (videoTags['com.apple.quicktime.creationdate']) {
          fileCreatedAt = String(videoTags['com.apple.quicktime.creationdate']);
        } else if (videoTags['creation_time']) {
          fileCreatedAt = String(videoTags['creation_time']);
        }
      }

      const exifData = await exiftool.read<ImmichTags>(asset.sidecarPath || asset.originalPath).catch((error: any) => {
        this.logger.warn(
          `The exifData parsing failed due to ${error} for asset ${asset.id} at ${asset.originalPath}`,
          error?.stack,
        );
        return null;
      });

      const newExif = new ExifEntity();
      newExif.assetId = asset.id;
      newExif.fileSizeInByte = data.format.size || null;
      newExif.dateTimeOriginal = fileCreatedAt ? new Date(fileCreatedAt) : null;
      newExif.modifyDate = null;
      newExif.timeZone = null;
      newExif.latitude = null;
      newExif.longitude = null;
      newExif.city = null;
      newExif.state = null;
      newExif.country = null;
      newExif.fps = null;
      newExif.livePhotoCID = exifData?.ContentIdentifier || null;

      if (newExif.livePhotoCID) {
        const photoAsset = await this.assetCore.findLivePhotoMatch({
          livePhotoCID: newExif.livePhotoCID,
          ownerId: asset.ownerId,
          otherAssetId: asset.id,
          type: AssetType.IMAGE,
        });
        if (photoAsset) {
          await this.assetCore.save({ id: photoAsset.id, livePhotoVideoId: asset.id });
          await this.assetCore.save({ id: asset.id, isVisible: false });
        }
      }

      if (videoTags && videoTags['location']) {
        const location = videoTags['location'] as string;
        const locationRegex = /([+-][0-9]+\.[0-9]+)([+-][0-9]+\.[0-9]+)\/$/;
        const match = location.match(locationRegex);

        if (match?.length === 3) {
          newExif.latitude = parseFloat(match[1]);
          newExif.longitude = parseFloat(match[2]);
        }
      } else if (videoTags && videoTags['com.apple.quicktime.location.ISO6709']) {
        const location = videoTags['com.apple.quicktime.location.ISO6709'] as string;
        const locationRegex = /([+-][0-9]+\.[0-9]+)([+-][0-9]+\.[0-9]+)([+-][0-9]+\.[0-9]+)\/$/;
        const match = location.match(locationRegex);

        if (match?.length === 4) {
          newExif.latitude = parseFloat(match[1]);
          newExif.longitude = parseFloat(match[2]);
        }
      }

      if (newExif.longitude && newExif.latitude) {
        try {
          newExif.timeZone = tz_lookup(newExif.latitude, newExif.longitude);
        } catch (error: any) {
          this.logger.warn(`Error while calculating timezone from gps coordinates: ${error}`, error?.stack);
        }
      }

      await this.applyReverseGeocoding(asset, newExif);

      for (const stream of data.streams) {
        if (stream.codec_type === 'video') {
          newExif.exifImageWidth = stream.width || null;
          newExif.exifImageHeight = stream.height || null;

          if (typeof stream.rotation === 'string') {
            newExif.orientation = stream.rotation;
          } else if (typeof stream.rotation === 'number') {
            newExif.orientation = `${stream.rotation}`;
          } else {
            newExif.orientation = null;
          }

          if (stream.r_frame_rate) {
            const fpsParts = stream.r_frame_rate.split('/');

            if (fpsParts.length === 2) {
              newExif.fps = Math.round(parseInt(fpsParts[0]) / parseInt(fpsParts[1]));
            }
          }
        }
      }

      await this.exifRepository.upsert(newExif, { conflictPaths: ['assetId'] });
      asset = await this.assetCore.save({ id: asset.id, duration: durationString, fileCreatedAt });
      await this.jobRepository.queue({ name: JobName.STORAGE_TEMPLATE_MIGRATION_SINGLE, data: { asset } });
    } catch (error: any) {
      this.logger.error(
        `Error in video metadata extraction due to ${error} for asset ${asset.id} at ${asset.originalPath}`,
        error?.stack,
      );
    }
  }

  private async applyReverseGeocoding(asset: AssetEntity, newExif: ExifEntity) {
    const { latitude, longitude } = newExif;
    if (this.reverseGeocodingEnabled && longitude && latitude) {
      try {
        const { country, state, city } = await this.geocodingRepository.reverseGeocode({ latitude, longitude });
        newExif.country = country;
        newExif.state = state;
        newExif.city = city;
      } catch (error: any) {
        this.logger.warn(
          `Unable to run reverse geocoding due to ${error} for asset ${asset.id} at ${asset.originalPath}`,
          error?.stack,
        );
      }
    }
  }

  private extractDuration(duration: number | string | null) {
    const videoDurationInSecond = Number(duration);
    if (!videoDurationInSecond) {
      return null;
    }

    return Duration.fromObject({ seconds: videoDurationInSecond }).toFormat('hh:mm:ss.SSS');
  }
}

@Processor(QueueName.SIDECAR)
export class SidecarProcessor {
  private logger = new Logger(SidecarProcessor.name);
  private assetCore: AssetCore;

  constructor(
    @Inject(IAssetRepository) private assetRepository: IAssetRepository,
    @Inject(IJobRepository) private jobRepository: IJobRepository,
  ) {
    this.assetCore = new AssetCore(assetRepository, jobRepository);
  }

  @Process(JobName.QUEUE_SIDECAR)
  async handleQueueSidecar(job: Job<IBaseJob>) {
    try {
      const { force } = job.data;
      const assetPagination = usePagination(JOBS_ASSET_PAGINATION_SIZE, (pagination) => {
        return force
          ? this.assetRepository.getWith(pagination, WithProperty.SIDECAR)
          : this.assetRepository.getWithout(pagination, WithoutProperty.SIDECAR);
      });

      for await (const assets of assetPagination) {
        for (const asset of assets) {
          const name = force ? JobName.SIDECAR_SYNC : JobName.SIDECAR_DISCOVERY;
          await this.jobRepository.queue({ name, data: { asset } });
        }
      }
    } catch (error: any) {
      this.logger.error(`Unable to queue sidecar scanning`, error?.stack);
    }
  }

  @Process(JobName.SIDECAR_SYNC)
  async handleSidecarSync(job: Job<IAssetJob>) {
    const { asset } = job.data;
    if (!asset.isVisible) {
      return;
    }

    try {
      const name = asset.type === AssetType.VIDEO ? JobName.EXTRACT_VIDEO_METADATA : JobName.EXIF_EXTRACTION;
      await this.jobRepository.queue({ name, data: { asset } });
    } catch (error: any) {
      this.logger.error(`Unable to queue metadata extraction`, error?.stack);
    }
  }

  @Process(JobName.SIDECAR_DISCOVERY)
  async handleSidecarDiscovery(job: Job<IAssetJob>) {
    let { asset } = job.data;
    if (!asset.isVisible) {
      return;
    }

    if (asset.sidecarPath) {
      return;
    }

    try {
      await fs.promises.access(`${asset.originalPath}.xmp`, fs.constants.W_OK);

      try {
        asset = await this.assetCore.save({ id: asset.id, sidecarPath: `${asset.originalPath}.xmp` });
        // TODO: optimize to only queue assets with recent xmp changes
        const name = asset.type === AssetType.VIDEO ? JobName.EXTRACT_VIDEO_METADATA : JobName.EXIF_EXTRACTION;
        await this.jobRepository.queue({ name, data: { asset } });
      } catch (error: any) {
        this.logger.error(`Unable to sync sidecar`, error?.stack);
      }
    } catch (error: any) {
      if (error.code == 'EACCES') {
        this.logger.error(`Unable to queue metadata extraction, file is not writable`, error?.stack);
      }

      return;
    }
  }
}
