/** Force correct audio MIME types — Express/Fastify guess wrong for .m4b (REIMPLEMENTATION_GUIDE §5.4). */
const MIME_BY_FORMAT: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4b: 'audio/mp4',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
};

export function audioMimeType(format: string | null | undefined): string {
  if (!format) return 'audio/mpeg';
  return MIME_BY_FORMAT[format.toLowerCase()] ?? 'audio/mpeg';
}

export interface AbsChapter {
  id: number;
  start: number;
  end: number;
  title: string;
}

/**
 * Normalize whatever is stored in bookMetadata.chapters into the ABS chapter shape.
 *
 * Stored chapters are `AudiobookChapter` ({ title, startMs }) — only a start offset in
 * milliseconds. ABS chapters need start/end in seconds, so we convert startMs and derive
 * each chapter's end from the next chapter's start (the last chapter ends at the book
 * duration). A legacy `start`/`end` (seconds) shape is still honored if present.
 */
export function normalizeChapters(raw: unknown, fallbackDuration: number): AbsChapter[] {
  if (!Array.isArray(raw)) return [];
  const parsed: { start: number; end: number | null; title: string }[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as Record<string, unknown>;
    const start = typeof e.startMs === 'number' ? e.startMs / 1000 : typeof e.start === 'number' ? e.start : 0;
    const end = typeof e.end === 'number' ? e.end : null;
    const title = typeof e.title === 'string' ? e.title : `Chapter ${index + 1}`;
    parsed.push({ start, end, title });
  });
  return parsed.map((chapter, index) => ({
    id: index,
    start: chapter.start,
    end: chapter.end ?? (index + 1 < parsed.length ? parsed[index + 1].start : fallbackDuration),
    title: chapter.title,
  }));
}
