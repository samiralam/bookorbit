import { audioMimeType, normalizeChapters } from './abs-media.util';

describe('audioMimeType', () => {
  it('forces correct mime types per audio format', () => {
    expect(audioMimeType('mp3')).toBe('audio/mpeg');
    expect(audioMimeType('m4b')).toBe('audio/mp4'); // Express/Fastify guess wrong here
    expect(audioMimeType('M4A')).toBe('audio/mp4'); // case-insensitive
    expect(audioMimeType('flac')).toBe('audio/flac');
    expect(audioMimeType('opus')).toBe('audio/opus');
  });

  it('falls back to audio/mpeg for unknown or missing formats', () => {
    expect(audioMimeType('wav')).toBe('audio/mpeg');
    expect(audioMimeType(null)).toBe('audio/mpeg');
    expect(audioMimeType(undefined)).toBe('audio/mpeg');
  });
});

describe('normalizeChapters', () => {
  it('converts stored startMs offsets to seconds and derives chapter ends', () => {
    const chapters = normalizeChapters(
      [
        { title: 'Intro', startMs: 0 },
        { title: 'Chapter 1', startMs: 100_000 },
      ],
      250,
    );
    // end is derived from the next chapter's start; the last ends at the book duration
    expect(chapters).toEqual([
      { id: 0, start: 0, end: 100, title: 'Intro' },
      { id: 1, start: 100, end: 250, title: 'Chapter 1' },
    ]);
  });

  it('honors a legacy start/end (seconds) shape when present', () => {
    const chapters = normalizeChapters(
      [
        { start: 0, end: 100, title: 'Intro' },
        { start: 100, end: 250, title: 'Chapter 1' },
      ],
      250,
    );
    expect(chapters).toEqual([
      { id: 0, start: 0, end: 100, title: 'Intro' },
      { id: 1, start: 100, end: 250, title: 'Chapter 1' },
    ]);
  });

  it('defaults missing fields (end -> next start / fallbackDuration, title -> "Chapter N")', () => {
    const chapters = normalizeChapters([{ startMs: 5000 }], 999);
    expect(chapters).toEqual([{ id: 0, start: 5, end: 999, title: 'Chapter 1' }]);
  });

  it('returns an empty array for non-array / malformed input', () => {
    expect(normalizeChapters(null, 100)).toEqual([]);
    expect(normalizeChapters(undefined, 100)).toEqual([]);
    expect(normalizeChapters('nope', 100)).toEqual([]);
    expect(normalizeChapters([null, 42, 'x'], 100)).toEqual([]);
  });
});
