import { ABS_MEDIA_TYPE_BOOK } from '../abs.constants';
import { encodeAbsId } from '../abs-id.util';
import { audioMimeType, normalizeChapters, type AbsChapter } from '../abs-media.util';
import type { AbsAudioFileRow, AbsItemRow } from '../abs-read.repository';

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

/** ABS metadata block shared by expanded and minified item shapes. */
function buildMetadata(item: AbsItemRow, rel: AbsItemRelations): Record<string, unknown> {
  const authorName = rel.authors.map((a) => a.name).join(', ');
  return {
    title: item.title ?? '',
    titleIgnorePrefix: item.title ?? '',
    subtitle: item.subtitle ?? null,
    authorName,
    authorNameLF: authorName,
    narratorName: rel.narrators.map((n) => n.name).join(', '),
    seriesName: rel.series.map((s) => (s.sequence != null ? `${s.name} #${s.sequence}` : s.name)).join(', '),
    authors: rel.authors.map((a) => ({ id: encodeAbsId('author', a.id), name: a.name })),
    narrators: rel.narrators.map((n) => n.name),
    series: rel.series.map((s) => ({ id: encodeAbsId('series', s.id), name: s.name, sequence: s.sequence != null ? String(s.sequence) : null })),
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
}

function toAbsAudioFile(file: AbsAudioFileRow, index: number): Record<string, unknown> {
  const ext = file.format ? `.${file.format.toLowerCase()}` : '';
  return {
    index,
    ino: String(file.id),
    metadata: {
      filename: basename(file.absolutePath),
      ext,
      path: file.absolutePath,
      relPath: basename(file.absolutePath),
      size: file.sizeBytes ?? 0,
      mtimeMs: 0,
      ctimeMs: 0,
      birthtimeMs: 0,
    },
    addedAt: 0,
    updatedAt: 0,
    trackNumFromMeta: index + 1,
    discNumFromMeta: null,
    trackNumFromFilename: null,
    discNumFromFilename: null,
    manuallyVerified: false,
    invalid: false,
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
    metaTags: {},
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
  /** ABS MediaProgress for the current user, attached as userMediaProgress when present. */
  mediaProgress?: Record<string, unknown> | null;
}

/** Map a BookOrbit book to an ABS LibraryItem (expanded by default, minified on request). */
export function toAbsLibraryItem(item: AbsItemRow, rel: AbsItemRelations, opts: ToAbsLibraryItemOptions = {}): Record<string, unknown> {
  const libraryItemId = encodeAbsId('libraryItem', item.id);
  const bookAbsId = encodeAbsId('book', item.id);
  const duration = rel.audioFiles.reduce((sum, f) => sum + (f.durationSeconds ?? 0), 0);
  const size = rel.audioFiles.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
  const numTracks = rel.audioFiles.length;
  const metadata = buildMetadata(item, rel);
  const coverPath = `/metadata/items/${item.id}/cover`;
  const chapters = buildItemChapters(item.chapters, duration);

  const media: Record<string, unknown> = opts.minified
    ? {
        id: bookAbsId,
        libraryItemId,
        metadata,
        coverPath,
        tags: [],
        numTracks,
        numAudioFiles: numTracks,
        numChapters: chapters.length,
        // ABS always emits these counts (0 here); strict Codable clients (e.g. Prologue) decode the
        // whole minified media object and drop the entire item list if a required key is absent.
        numMissingParts: 0,
        numInvalidAudioFiles: 0,
        duration,
        size,
      }
    : {
        id: bookAbsId,
        libraryItemId,
        metadata,
        coverPath,
        tags: [],
        audioFiles: rel.audioFiles.map((f, i) => toAbsAudioFile(f, i)),
        chapters,
        duration,
        size,
        numTracks,
        ebookFile: null,
      };

  const result: Record<string, unknown> = {
    id: libraryItemId,
    ino: String(item.id),
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
    numFiles: numTracks,
    size,
  };

  if (opts.mediaProgress) result.userMediaProgress = opts.mediaProgress;
  return result;
}

function buildItemChapters(raw: unknown, duration: number): AbsChapter[] {
  return normalizeChapters(raw, duration);
}
