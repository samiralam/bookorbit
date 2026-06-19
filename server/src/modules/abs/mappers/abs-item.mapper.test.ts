import type { AbsAudioFileRow, AbsItemRow } from '../abs-read.repository';
import { buildDirectPlayTracks, toAbsLibraryItem, type AbsItemRelations } from './abs-item.mapper';

function makeItem(overrides: Partial<AbsItemRow> = {}): AbsItemRow {
  return {
    id: 3,
    libraryId: 5,
    status: 'ready',
    addedAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-02-01T00:00:00Z'),
    title: 'The Hobbit',
    subtitle: null,
    description: 'A tale',
    publishedYear: 1937,
    publisher: 'Allen & Unwin',
    language: 'en',
    isbn13: '9780000000001',
    isbn10: null,
    seriesName: null,
    seriesIndex: null,
    durationSeconds: null,
    chapters: [{ start: 0, end: 60, title: 'One' }],
    ...overrides,
  };
}

function file(id: number, durationSeconds: number, sizeBytes: number): AbsAudioFileRow {
  return { id, bookId: 3, format: 'mp3', sortOrder: id, durationSeconds, sizeBytes, absolutePath: `/books/3/${id}.mp3` };
}

const relations: AbsItemRelations = {
  authors: [{ id: 1, name: 'Tolkien' }],
  narrators: [{ name: 'Rob Inglis' }],
  series: [{ id: 2, name: 'Middle Earth', sequence: 1 }],
  audioFiles: [file(10, 100, 1000), file(11, 200, 2000)],
};

describe('toAbsLibraryItem', () => {
  it('builds an expanded item with audio files, chapters, and summed duration/size', () => {
    const item = toAbsLibraryItem(makeItem(), relations);
    expect(item.id).toBe('li_3');
    expect(item.ino).toBe('3');
    expect(item.libraryId).toBe('lib_5');
    expect(item.mediaType).toBe('book');

    const media = item.media as Record<string, unknown>;
    expect(media.id).toBe('bk_3');
    expect(media.duration).toBe(300); // 100 + 200
    expect(media.size).toBe(3000);
    expect(media.numTracks).toBe(2);
    expect(Array.isArray(media.audioFiles)).toBe(true);
    expect((media.audioFiles as unknown[]).length).toBe(2);
    expect(media.chapters).toEqual([{ id: 0, start: 0, end: 60, title: 'One' }]);

    const metadata = media.metadata as Record<string, unknown>;
    expect(metadata.title).toBe('The Hobbit');
    expect(metadata.authorName).toBe('Tolkien');
    expect(metadata.narratorName).toBe('Rob Inglis');
    expect(metadata.seriesName).toBe('Middle Earth #1');
    expect(metadata.isbn).toBe('9780000000001');
  });

  it('omits audioFiles in minified mode but keeps counts/duration', () => {
    const item = toAbsLibraryItem(makeItem(), relations, { minified: true });
    const media = item.media as Record<string, unknown>;
    expect(media.audioFiles).toBeUndefined();
    expect(media.numTracks).toBe(2);
    expect(media.duration).toBe(300);
  });

  it('attaches userMediaProgress only when supplied', () => {
    const withProgress = toAbsLibraryItem(makeItem(), relations, { mediaProgress: { progress: 0.5 } });
    expect(withProgress.userMediaProgress).toEqual({ progress: 0.5 });
    const without = toAbsLibraryItem(makeItem(), relations);
    expect(without.userMediaProgress).toBeUndefined();
  });

  it('flags missing items via isMissing', () => {
    expect(toAbsLibraryItem(makeItem({ status: 'missing' }), relations).isMissing).toBe(true);
    expect(toAbsLibraryItem(makeItem({ status: 'ready' }), relations).isMissing).toBe(false);
  });
});

describe('buildDirectPlayTracks', () => {
  it('produces one track per file with cumulative startOffset and open-session contentUrls', () => {
    const tracks = buildDirectPlayTracks('sess-1', relations.audioFiles);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({
      index: 0,
      startOffset: 0,
      duration: 100,
      contentUrl: '/public/session/sess-1/track/0',
      mimeType: 'audio/mpeg',
    });
    expect(tracks[1]).toMatchObject({ index: 1, startOffset: 100, duration: 200, contentUrl: '/public/session/sess-1/track/1' });
  });

  it('returns an empty list when there are no audio files', () => {
    expect(buildDirectPlayTracks('sess-1', [])).toEqual([]);
  });
});
