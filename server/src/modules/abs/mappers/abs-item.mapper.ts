import { ABS_MEDIA_TYPE_BOOK, ABS_SERVER_VERSION } from '../abs.constants';
import { encodeAbsId } from '../abs-id.util';
import { audioMimeType, normalizeChapters, type AbsChapter } from '../abs-media.util';
import type { AbsAudioFileRow, AbsItemRow } from '../abs-read.repository';
import { toLastFirst } from './abs-author.mapper';

export interface AbsItemRelations {
  authors: { id: number; name: string }[];
  narrators: { name: string }[];
  series: { id: number; name: string; sequence: number | null }[];
  audioFiles: AbsAudioFileRow[];
}

function toEpochMs(value: Date | string | null | undefined): number {
  if (!value) return 0;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * ABS metadata block. The minified shape (`Book.oldMetadataToJSONMinified`) carries ONLY the
 * flattened name strings — real ABS never emits the `authors`/`narrators`/`series` arrays there.
 * Sending them as a "harmless superset" breaks strict Codable clients (Prologue): an optional
 * `authors` property decoded with decodeIfPresent is skipped when the key is absent (real ABS) but
 * THROWS when present with fewer keys than the client's Author model requires — dropping the whole
 * item page. The expanded shape (`oldMetadataToJSONExpanded`) has arrays AND flattened strings.
 */
function buildMetadata(item: AbsItemRow, rel: AbsItemRelations, minified: boolean): Record<string, unknown> {
  const authorName = rel.authors.map((a) => a.name).join(', ');
  const flattened = {
    title: item.title ?? '',
    titleIgnorePrefix: item.title ?? '',
    subtitle: item.subtitle ?? null,
    authorName,
    authorNameLF: rel.authors.map((a) => toLastFirst(a.name)).join(', '),
    narratorName: rel.narrators.map((n) => n.name).join(', '),
    seriesName: rel.series.map((s) => (s.sequence != null ? `${s.name} #${s.sequence}` : s.name)).join(', '),
  };
  const shared = {
    genres: [],
    publishedYear: item.publishedYear != null ? String(item.publishedYear) : null,
    publishedDate: null,
    publisher: item.publisher ?? null,
    description: item.description ?? null,
    isbn: item.isbn13 ?? item.isbn10 ?? null,
    asin: null,
    language: item.language ?? null,
    explicit: false,
    abridged: false,
  };
  if (minified) return { ...flattened, ...shared };
  return {
    ...flattened,
    authors: rel.authors.map((a) => ({ id: encodeAbsId('author', a.id), name: a.name })),
    narrators: rel.narrators.map((n) => n.name),
    series: rel.series.map((s) => ({ id: encodeAbsId('series', s.id), name: s.name, sequence: s.sequence != null ? String(s.sequence) : null })),
    ...shared,
    descriptionPlain: item.description != null ? item.description.replace(/<[^>]*>/g, '') : null,
  };
}

/**
 * Book-level context for file-shaped objects. Real ABS files always carry probe/tag data and real
 * timestamps; clients surface these directly (e.g. a download-queue row titled by `tagTitle`), so
 * emitting empty tags or zero times degrades UI even though it decodes.
 */
interface AbsFileContext {
  title: string;
  authorName: string;
  addedAtMs: number;
  updatedAtMs: number;
}

/** ABS FileMetadata block, shared by audioFiles, tracks, and libraryFiles. */
function toAbsFileMetadata(file: AbsAudioFileRow, ctx: AbsFileContext): Record<string, unknown> {
  return {
    filename: basename(file.absolutePath),
    ext: file.format ? `.${file.format.toLowerCase()}` : '',
    path: file.absolutePath,
    relPath: basename(file.absolutePath),
    size: file.sizeBytes ?? 0,
    mtimeMs: ctx.updatedAtMs,
    ctimeMs: ctx.updatedAtMs,
    birthtimeMs: ctx.addedAtMs,
  };
}

function toAbsAudioFile(file: AbsAudioFileRow, index: number, ctx: AbsFileContext): Record<string, unknown> {
  return {
    // ABS AudioFile.index is 1-based (first file is index 1).
    index: index + 1,
    ino: String(file.id),
    metadata: toAbsFileMetadata(file, ctx),
    addedAt: ctx.addedAtMs,
    updatedAt: ctx.updatedAtMs,
    trackNumFromMeta: index + 1,
    discNumFromMeta: null,
    trackNumFromFilename: null,
    discNumFromFilename: null,
    manuallyVerified: false,
    exclude: false,
    error: null,
    format: file.format ?? '',
    duration: file.durationSeconds ?? 0,
    bitRate: 0,
    language: null,
    codec: file.format ?? '',
    timeBase: '1/1000',
    channels: 2,
    channelLayout: 'stereo',
    chapters: [],
    embeddedCoverArt: null,
    metaTags: {
      tagAlbum: ctx.title,
      tagArtist: ctx.authorName,
      tagTitle: ctx.title,
    },
    mimeType: audioMimeType(file.format),
  };
}

/**
 * Build a direct-play AudioTrack list (playMethod=0). `startOffset` is cumulative so the client can
 * seek across the whole book; `contentUrl` points at the open-session track endpoint, which streams
 * raw bytes with HTTP Range support (REIMPLEMENTATION_GUIDE §5.2, §5.4).
 */
export function buildDirectPlayTracks(sessionId: string, audioFiles: AbsAudioFileRow[]): Record<string, unknown>[] {
  let startOffset = 0;
  return audioFiles.map((file, index) => {
    const duration = file.durationSeconds ?? 0;
    const track = {
      index,
      startOffset,
      duration,
      title: basename(file.absolutePath),
      contentUrl: `/public/session/${sessionId}/track/${index}`,
      mimeType: audioMimeType(file.format),
      codec: file.format ?? '',
      metadata: {
        filename: basename(file.absolutePath),
        ext: file.format ? `.${file.format.toLowerCase()}` : '',
        path: file.absolutePath,
        relPath: basename(file.absolutePath),
        size: file.sizeBytes ?? 0,
      },
    };
    startOffset += duration;
    return track;
  });
}

/**
 * Build the single synthetic AudioTrack for a transcode session (playMethod=2). `contentUrl` is the
 * HLS playlist under `/hls/:streamId`; the client plays the whole book as one stream
 * (REIMPLEMENTATION_GUIDE §5.2).
 */
export function buildTranscodeTrack(streamId: string, duration: number): Record<string, unknown> {
  return {
    index: 0,
    startOffset: 0,
    duration,
    title: `${streamId}.m3u8`,
    contentUrl: `/hls/${streamId}/output.m3u8`,
    mimeType: 'application/vnd.apple.mpegurl',
    codec: 'aac',
    metadata: null,
  };
}

export interface ToAbsLibraryItemOptions {
  minified?: boolean;
  /**
   * ABS MediaProgress for the current user. Pass a value (or explicit null) to emit the
   * userMediaProgress key — ABS emits `userMediaProgress: null` on `?include=progress` when the
   * user has none, and omits the key entirely without the include. Leave undefined to omit.
   */
  mediaProgress?: Record<string, unknown> | null;
}

/** Map a BookOrbit book to an ABS LibraryItem (expanded by default, minified on request). */
export function toAbsLibraryItem(item: AbsItemRow, rel: AbsItemRelations, opts: ToAbsLibraryItemOptions = {}): Record<string, unknown> {
  const libraryItemId = encodeAbsId('libraryItem', item.id);
  const bookAbsId = encodeAbsId('book', item.id);
  const duration = rel.audioFiles.reduce((sum, f) => sum + (f.durationSeconds ?? 0), 0);
  const size = rel.audioFiles.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
  const numTracks = rel.audioFiles.length;
  const metadata = buildMetadata(item, rel, opts.minified ?? false);
  const coverPath = `/metadata/items/${item.id}/cover`;
  const chapters = buildItemChapters(item.chapters, duration);
  const fileCtx: AbsFileContext = {
    title: item.title ?? '',
    authorName: rel.authors.map((a) => a.name).join(', '),
    addedAtMs: toEpochMs(item.addedAt),
    updatedAtMs: toEpochMs(item.updatedAt),
  };

  // Minified media is EXACTLY ABS `Book.toOldJSONMinified`: no libraryItemId, no part counts
  // (`ebookFormat` is omitted for audiobooks, matching ABS's undefined-key behavior). Expanded
  // media is EXACTLY `Book.toOldJSONExpanded`: audioFiles + chapters + ebookFile + tracks, and no
  // numTracks/numAudioFiles counts. Prologue reads the book's playable contents from `tracks` —
  // without it the detail screen shows "Unable to load book contents" and play is disabled.
  const media: Record<string, unknown> = opts.minified
    ? {
        id: bookAbsId,
        metadata,
        coverPath,
        tags: [],
        numTracks,
        numAudioFiles: numTracks,
        numChapters: chapters.length,
        duration,
        size,
      }
    : {
        id: bookAbsId,
        libraryItemId,
        metadata,
        coverPath,
        tags: [],
        audioFiles: rel.audioFiles.map((f, i) => toAbsAudioFile(f, i, fileCtx)),
        chapters,
        ebookFile: null,
        duration,
        size,
        tracks: buildItemTracks(libraryItemId, rel.audioFiles, fileCtx),
      };

  const result: Record<string, unknown> = {
    id: libraryItemId,
    ino: String(item.id),
    // ABS always emits oldLibraryItemId (null when absent). Swift's `decode(String?.self, forKey:)`
    // throws on a MISSING key even though it accepts an explicit null, so omitting it makes strict
    // clients (Prologue) silently drop every item — empty grid, no cover fetches. Always send it.
    oldLibraryItemId: null,
    libraryId: encodeAbsId('library', item.libraryId),
    folderId: '',
    path: '',
    relPath: '',
    isFile: false,
    mtimeMs: toEpochMs(item.updatedAt),
    ctimeMs: toEpochMs(item.updatedAt),
    birthtimeMs: toEpochMs(item.addedAt),
    addedAt: toEpochMs(item.addedAt),
    updatedAt: toEpochMs(item.updatedAt),
    isMissing: item.status === 'missing',
    isInvalid: false,
    mediaType: ABS_MEDIA_TYPE_BOOK,
    media,
  };

  if (opts.minified) {
    // LibraryItem.toOldJSONMinified: numFiles + size, no scan info or file list.
    result.numFiles = numTracks;
    result.size = size;
  } else {
    // LibraryItem.toOldJSONExpanded: lastScan/scanVersion + full libraryFiles list.
    result.lastScan = toEpochMs(item.updatedAt);
    result.scanVersion = ABS_SERVER_VERSION;
    result.libraryFiles = rel.audioFiles.map((f) => ({
      ino: String(f.id),
      metadata: toAbsFileMetadata(f, fileCtx),
      isSupplementary: null,
      addedAt: fileCtx.addedAtMs,
      updatedAt: fileCtx.updatedAtMs,
      fileType: 'audio',
    }));
    result.size = size;
  }

  if (opts.mediaProgress !== undefined) result.userMediaProgress = opts.mediaProgress;
  return result;
}

/**
 * ABS `Book.getTracklist`: each track is the AudioFile JSON plus title/startOffset/contentUrl,
 * with contentUrl pointing at the inline file-stream route (`GET /api/items/:id/file/:ino`).
 */
function buildItemTracks(libraryItemAbsId: string, audioFiles: AbsAudioFileRow[], ctx: AbsFileContext): Record<string, unknown>[] {
  let startOffset = 0;
  return audioFiles.map((file, index) => {
    const track = {
      ...toAbsAudioFile(file, index, ctx),
      title: basename(file.absolutePath),
      startOffset,
      contentUrl: `/api/items/${libraryItemAbsId}/file/${file.id}`,
    };
    startOffset += file.durationSeconds ?? 0;
    return track;
  });
}

function buildItemChapters(raw: unknown, duration: number): AbsChapter[] {
  return normalizeChapters(raw, duration);
}
