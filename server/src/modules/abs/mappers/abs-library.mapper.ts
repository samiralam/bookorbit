import { ABS_MEDIA_TYPE_BOOK, ABS_SERVER_VERSION } from '../abs.constants';
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

/** ABS settings.coverAspectRatio (constants.BookCoverAspectRatio): 0 = standard 1.6:1, 1 = square. */
function coverAspectRatioFlag(ratio: string | null | undefined): number {
  return ratio === '1/1' || ratio === '1' ? 1 : 0;
}

/**
 * ABS library icons are a fixed lowercase set (web client's icon picker); clients may decode the
 * value as an enum, so an unknown value like BookOrbit's "Mic" can fail the whole libraries decode.
 */
const ABS_LIBRARY_ICONS = new Set([
  'database',
  'audiobookshelf',
  'books-1',
  'books-2',
  'book-1',
  'microphone-1',
  'microphone-3',
  'radio',
  'podcast',
  'rss',
  'headphones',
  'music',
  'file-picture',
  'rocket',
  'power',
  'star',
  'heart',
]);

function toAbsIcon(icon: string | null | undefined): string {
  if (!icon) return 'database';
  const lower = icon.toLowerCase();
  if (ABS_LIBRARY_ICONS.has(lower)) return lower;
  if (lower === 'mic' || lower === 'microphone') return 'microphone-1';
  if (lower.startsWith('book')) return 'book-1';
  return 'database';
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
    // ABS display order is 1-based; BookOrbit's starts at 0.
    displayOrder: (library.displayOrder ?? 0) + 1,
    icon: toAbsIcon(library.icon),
    mediaType: ABS_MEDIA_TYPE_BOOK,
    provider: 'google',
    // Full LibrarySettings field set as emitted by live ABS 2.35.1 — strict clients may decode
    // this object with non-optional keys. Values are ABS defaults where BookOrbit has no concept.
    settings: {
      coverAspectRatio: coverAspectRatioFlag(library.coverAspectRatio),
      disableWatcher: true,
      skipMatchingMediaWithAsin: false,
      skipMatchingMediaWithIsbn: false,
      autoScanCronExpression: null,
      audiobooksOnly: false,
      epubsAllowScriptedContent: false,
      hideSingleBookSeries: false,
      onlyShowLaterBooksInContinueSeries: false,
      metadataPrecedence: ['folderStructure', 'audioMetatags', 'nfoFile', 'txtFiles', 'opfFile', 'absMetadata'],
      markAsFinishedPercentComplete: null,
      markAsFinishedTimeRemaining: 10,
    },
    // ABS Library.toOldJSON always carries these; a null lastScan can read as "never scanned" to
    // strict clients. BookOrbit has no scan concept, so mirror updatedAt as the effective last scan.
    lastScan: toEpochMs(library.updatedAt) || null,
    lastScanVersion: ABS_SERVER_VERSION,
    createdAt: toEpochMs(library.createdAt),
    lastUpdate: toEpochMs(library.updatedAt),
  };
}
