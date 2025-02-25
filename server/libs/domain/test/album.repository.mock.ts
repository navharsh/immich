import { IAlbumRepository } from '../src';

export const newAlbumRepositoryMock = (): jest.Mocked<IAlbumRepository> => {
  return {
    getByIds: jest.fn(),
    getByAssetId: jest.fn(),
    getAssetCountForIds: jest.fn(),
    getInvalidThumbnail: jest.fn(),
    getOwned: jest.fn(),
    getShared: jest.fn(),
    getNotShared: jest.fn(),
    deleteAll: jest.fn(),
    getAll: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };
};
