import { ABS_MEDIA_TYPE_BOOK } from '../abs.constants';
import { encodeAbsId } from '../abs-id.util';

interface LibraryFolderLike {
  id: number;
  path: string;
  createdAt?: Date | string | null;
}

interface LibraryLike {
  id: number;
  name: string;
  icon?: string | null;
  displayOrder?: number | null;
  coverAspectRatio?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  folders?: LibraryFolderLike[];
}

function toEpochMs(value: Date | string | null | undefined): number {
  if (!value) return 0;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** ABS settings.coverAspectRatio: 0 = square, 1 = standard (book). */
function coverAspectRatioFlag(ratio: string | null | undefined): number {
  return ratio === '1/1' || ratio === '1' ? 0 : 1;
}

/** Map a BookOrbit library (as returned by LibraryService.findAll/findOne) to the ABS Library shape. */
export function toAbsLibrary(library: LibraryLike): Record<string, unknown> {
  const libraryAbsId = encodeAbsId('library', library.id);
  return {
    id: libraryAbsId,
    name: library.name,
    folders: (library.folders ?? []).map((folder) => ({
      id: String(folder.id),
      fullPath: folder.path,
      libraryId: libraryAbsId,
      addedAt: toEpochMs(folder.createdAt),
    })),
    displayOrder: library.displayOrder ?? 1,
    icon: library.icon ?? 'database',
    mediaType: ABS_MEDIA_TYPE_BOOK,
    provider: 'google',
    settings: {
      coverAspectRatio: coverAspectRatioFlag(library.coverAspectRatio),
      disableWatcher: true,
      skipMatchingMediaWithAsin: false,
      skipMatchingMediaWithIsbn: false,
      autoScanCronExpression: null,
    },
    createdAt: toEpochMs(library.createdAt),
    lastUpdate: toEpochMs(library.updatedAt),
  };
}
