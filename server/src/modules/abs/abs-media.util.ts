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

/** Normalize whatever is stored in bookMetadata.chapters into the ABS chapter shape. */
export function normalizeChapters(raw: unknown, fallbackDuration: number): AbsChapter[] {
  if (!Array.isArray(raw)) return [];
  const chapters: AbsChapter[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as Record<string, unknown>;
    const start = typeof e.start === 'number' ? e.start : 0;
    const end = typeof e.end === 'number' ? e.end : fallbackDuration;
    const title = typeof e.title === 'string' ? e.title : `Chapter ${index + 1}`;
    chapters.push({ id: index, start, end, title });
  });
  return chapters;
}
