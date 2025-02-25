import { AlbumEntity, AssetEntity, UserEntity } from '@app/infra/entities';
import { Inject, Injectable } from '@nestjs/common';
import { IAssetRepository } from '../asset';
import { AuthUserDto } from '../auth';
import { IJobRepository, JobName } from '../job';
import { IAlbumRepository } from './album.repository';
import { CreateAlbumDto } from './dto/album-create.dto';
import { GetAlbumsDto } from './dto/get-albums.dto';
import { AlbumResponseDto, mapAlbum } from './response-dto';

@Injectable()
export class AlbumService {
  constructor(
    @Inject(IAlbumRepository) private albumRepository: IAlbumRepository,
    @Inject(IAssetRepository) private assetRepository: IAssetRepository,
    @Inject(IJobRepository) private jobRepository: IJobRepository,
  ) {}

  async getAll({ id: ownerId }: AuthUserDto, { assetId, shared }: GetAlbumsDto): Promise<AlbumResponseDto[]> {
    await this.updateInvalidThumbnails();

    let albums: AlbumEntity[];
    if (assetId) {
      albums = await this.albumRepository.getByAssetId(ownerId, assetId);
    } else if (shared === true) {
      albums = await this.albumRepository.getShared(ownerId);
    } else if (shared === false) {
      albums = await this.albumRepository.getNotShared(ownerId);
    } else {
      albums = await this.albumRepository.getOwned(ownerId);
    }

    // Get asset count for each album. Then map the result to an object:
    // { [albumId]: assetCount }
    const albumsAssetCount = await this.albumRepository.getAssetCountForIds(albums.map((album) => album.id));
    const albumsAssetCountObj = albumsAssetCount.reduce((obj: Record<string, number>, { albumId, assetCount }) => {
      obj[albumId] = assetCount;
      return obj;
    }, {});

    return albums.map((album) => {
      return {
        ...album,
        sharedLinks: undefined, // Don't return shared links
        shared: album.sharedLinks?.length > 0 || album.sharedUsers?.length > 0,
        assetCount: albumsAssetCountObj[album.id],
      } as AlbumResponseDto;
    });
  }

  async updateInvalidThumbnails(): Promise<number> {
    const invalidAlbumIds = await this.albumRepository.getInvalidThumbnail();

    for (const albumId of invalidAlbumIds) {
      const newThumbnail = await this.assetRepository.getFirstAssetForAlbumId(albumId);
      await this.albumRepository.save({ id: albumId, albumThumbnailAsset: newThumbnail });
    }

    return invalidAlbumIds.length;
  }

  async create(authUser: AuthUserDto, dto: CreateAlbumDto): Promise<AlbumResponseDto> {
    // TODO: Handle nonexistent sharedWithUserIds and assetIds.
    const album = await this.albumRepository.create({
      ownerId: authUser.id,
      albumName: dto.albumName,
      sharedUsers: dto.sharedWithUserIds?.map((value) => ({ id: value } as UserEntity)) ?? [],
      assets: (dto.assetIds || []).map((id) => ({ id } as AssetEntity)),
      albumThumbnailAssetId: dto.assetIds?.[0] || null,
    });
    await this.jobRepository.queue({ name: JobName.SEARCH_INDEX_ALBUM, data: { ids: [album.id] } });
    return mapAlbum(album);
  }
}
