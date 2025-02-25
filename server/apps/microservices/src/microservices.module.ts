import { DomainModule } from '@app/domain';
import { InfraModule } from '@app/infra';
import { ExifEntity } from '@app/infra/entities';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  BackgroundTaskProcessor,
  ClipEncodingProcessor,
  FacialRecognitionProcessor,
  ObjectTaggingProcessor,
  SearchIndexProcessor,
  StorageTemplateMigrationProcessor,
  ThumbnailGeneratorProcessor,
  VideoTranscodeProcessor,
} from './processors';
import { MetadataExtractionProcessor, SidecarProcessor } from './processors/metadata-extraction.processor';

@Module({
  imports: [
    //
    DomainModule.register({ imports: [InfraModule] }),
    TypeOrmModule.forFeature([ExifEntity]),
  ],
  providers: [
    ThumbnailGeneratorProcessor,
    MetadataExtractionProcessor,
    VideoTranscodeProcessor,
    ObjectTaggingProcessor,
    ClipEncodingProcessor,
    StorageTemplateMigrationProcessor,
    BackgroundTaskProcessor,
    SearchIndexProcessor,
    FacialRecognitionProcessor,
    SidecarProcessor,
  ],
})
export class MicroservicesModule {}
