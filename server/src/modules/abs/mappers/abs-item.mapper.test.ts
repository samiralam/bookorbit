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
    // ABS always emits oldLibraryItemId (null); omitting the key makes Swift's decode(String?.self)
    // throw on absence, so strict clients (Prologue) silently drop every item. Must be present.
    expect('oldLibraryItemId' in item).toBe(true);
    expect(item.oldLibraryItemId).toBeNull();

    const media = item.media as Record<string, unknown>;
    expect(media.id).toBe('bk_3');
    expect(media.duration).toBe(300); // 100 + 200
    expect(media.size).toBe(3000);
    expect(Array.isArray(media.audioFiles)).toBe(true);
    expect((media.audioFiles as unknown[]).length).toBe(2);
    expect(media.chapters).toEqual([{ id: 0, start: 0, end: 60, title: 'One' }]);

    // Book.toOldJSONExpanded carries tracks (Prologue's "book contents") — audio-file JSON plus
    // title/startOffset/contentUrl — and no numTracks count.
    expect(media.numTracks).toBeUndefined();
    const tracks = media.tracks as Record<string, unknown>[];
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({ index: 1, startOffset: 0, duration: 100, contentUrl: '/api/items/li_3/file/10', title: '10.mp3' });
    expect(tracks[1]).toMatchObject({ index: 2, startOffset: 100, duration: 200, contentUrl: '/api/items/li_3/file/11' });

    // LibraryItem.toOldJSONExpanded: scan info + full libraryFiles, no numFiles count.
    expect(item.numFiles).toBeUndefined();
    expect(item.lastScan).toBeDefined();
    expect(item.scanVersion).toBeDefined();
    const libraryFiles = item.libraryFiles as Record<string, unknown>[];
    expect(libraryFiles).toHaveLength(2);
    expect(libraryFiles[0]).toMatchObject({ ino: '10', fileType: 'audio', isSupplementary: null });
    expect((libraryFiles[0].metadata as Record<string, unknown>).filename).toBe('10.mp3');

    // Real ABS files always carry probe tags; clients surface tagTitle/tagArtist directly (e.g.
    // Prologue's download queue), so audio files get the book's title/author, never empty tags.
    const audioFile = (media.audioFiles as Record<string, unknown>[])[0];
    expect(audioFile.metaTags).toEqual({ tagAlbum: 'The Hobbit', tagArtist: 'Tolkien', tagTitle: 'The Hobbit' });
    expect(audioFile.invalid).toBeUndefined();
    expect(audioFile.addedAt).toBe(new Date('2024-01-01T00:00:00Z').getTime());

    const metadata = media.metadata as Record<string, unknown>;
    expect(metadata.title).toBe('The Hobbit');
    expect(metadata.authorName).toBe('Tolkien');
    expect(metadata.narratorName).toBe('Rob Inglis');
    expect(metadata.seriesName).toBe('Middle Earth #1');
    expect(metadata.isbn).toBe('9780000000001');
  });

  it('minified media/metadata carry exactly the ABS toOldJSONMinified key sets', () => {
    const item = toAbsLibraryItem(makeItem(), relations, { minified: true });
    const media = item.media as Record<string, unknown>;
    // Book.toOldJSONMinified: no audioFiles, no libraryItemId, no part counts (extra keys break
    // strict Codable clients whose optional properties decode stricter shapes than we send).
    expect(Object.keys(media).sort()).toEqual([
      'coverPath',
      'duration',
      'id',
      'metadata',
      'numAudioFiles',
      'numChapters',
      'numTracks',
      'size',
      'tags',
    ]);
    expect(media.numTracks).toBe(2);
    expect(media.duration).toBe(300);
    // oldMetadataToJSONMinified: flattened name strings only — never authors/narrators/series arrays.
    const metadata = media.metadata as Record<string, unknown>;
    expect(metadata.authors).toBeUndefined();
    expect(metadata.narrators).toBeUndefined();
    expect(metadata.series).toBeUndefined();
    expect(metadata.authorName).toBeDefined();
    expect(metadata.narratorName).toBeDefined();
    expect(metadata.seriesName).toBeDefined();
  });

  it('formats authorNameLF as "Last, First" joined across authors', () => {
    const rel = {
      ...relations,
      authors: [
        { id: 1, name: 'Adrian Tchaikovsky' },
        { id: 2, name: 'Dennis E. Taylor' },
      ],
    };
    const item = toAbsLibraryItem(makeItem(), rel, { minified: true });
    const metadata = (item.media as Record<string, unknown>).metadata as Record<string, unknown>;
    expect(metadata.authorName).toBe('Adrian Tchaikovsky, Dennis E. Taylor');
    expect(metadata.authorNameLF).toBe('Tchaikovsky, Adrian, Taylor, Dennis E.');
  });

  it('attaches userMediaProgress when supplied, including explicit null (ABS include=progress)', () => {
    const withProgress = toAbsLibraryItem(makeItem(), relations, { mediaProgress: { progress: 0.5 } });
    expect(withProgress.userMediaProgress).toEqual({ progress: 0.5 });
    // ?include=progress with no progress row: ABS emits the key with an explicit null.
    const withNull = toAbsLibraryItem(makeItem(), relations, { mediaProgress: null });
    expect('userMediaProgress' in withNull).toBe(true);
    expect(withNull.userMediaProgress).toBeNull();
    const without = toAbsLibraryItem(makeItem(), relations);
    expect('userMediaProgress' in without).toBe(false);
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
