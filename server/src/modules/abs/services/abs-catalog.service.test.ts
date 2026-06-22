import { Permission } from '@bookorbit/types';

import type { LibraryService } from '../../library/library.service';
import type { AbsAudioFileRow, AbsItemRow, AbsReadRepository } from '../abs-read.repository';
import { makeAbsUser, thrownStatus } from '../__testing__/abs-test-helpers';
import { AbsCatalogService, parseAbsSort } from './abs-catalog.service';
import type { AbsProgressService } from './abs-progress.service';

function item(overrides: Partial<AbsItemRow> = {}): AbsItemRow {
  return {
    id: 3,
    libraryId: 5,
    status: 'ready',
    addedAt: new Date(),
    updatedAt: new Date(),
    title: 'The Hobbit',
    subtitle: null,
    description: null,
    publishedYear: null,
    publisher: null,
    language: 'en',
    isbn13: null,
    isbn10: null,
    seriesName: null,
    seriesIndex: null,
    durationSeconds: null,
    chapters: [],
    ...overrides,
  };
}

function audioFile(overrides: Partial<AbsAudioFileRow> = {}): AbsAudioFileRow {
  return { id: 7, bookId: 3, format: 'm4b', sortOrder: 0, durationSeconds: 100, sizeBytes: 1000, absolutePath: '/audio/hobbit.m4b', ...overrides };
}

interface BuildOpts {
  listItems?: { rows: AbsItemRow[]; total: number };
  findItem?: AbsItemRow | null;
  findItemsByIds?: AbsItemRow[];
  accessibleIds?: number[];
  findBookFileById?: AbsAudioFileRow | null;
  libraryIdForBook?: number | null;
  audioFilesByBookId?: AbsAudioFileRow[];
  authorsInLibrary?: { id: number; name: string; description: string | null; numBooks: number }[];
  findAuthor?: { id: number; name: string; description: string | null } | null;
  bookIdsForAuthor?: number[];
  libraryIdForAuthor?: number | null;
}

function build(opts: BuildOpts = {}) {
  const readRepo = {
    listItems: vi.fn().mockResolvedValue(opts.listItems ?? { rows: [], total: 0 }),
    findItem: vi.fn().mockResolvedValue(opts.findItem === undefined ? item() : opts.findItem),
    findItemsByIds: vi.fn().mockResolvedValue(opts.findItemsByIds ?? []),
    authorsByBookIds: vi.fn().mockResolvedValue([]),
    narratorsByBookIds: vi.fn().mockResolvedValue([]),
    seriesByBookIds: vi.fn().mockResolvedValue([]),
    audioFilesByBookIds: vi.fn().mockResolvedValue([]),
    findBookFileById: vi.fn().mockResolvedValue(opts.findBookFileById === undefined ? audioFile() : opts.findBookFileById),
    libraryIdForBook: vi.fn().mockResolvedValue(opts.libraryIdForBook === undefined ? 5 : opts.libraryIdForBook),
    audioFilesByBookId: vi.fn().mockResolvedValue(opts.audioFilesByBookId ?? [audioFile()]),
    authorsInLibrary: vi.fn().mockResolvedValue(opts.authorsInLibrary ?? []),
    findAuthor: vi.fn().mockResolvedValue(opts.findAuthor === undefined ? { id: 1, name: 'Andy Weir', description: null } : opts.findAuthor),
    bookIdsForAuthor: vi.fn().mockResolvedValue(opts.bookIdsForAuthor ?? []),
    libraryIdForAuthor: vi.fn().mockResolvedValue(opts.libraryIdForAuthor === undefined ? 5 : opts.libraryIdForAuthor),
  } as unknown as AbsReadRepository;
  const progressService = {
    listMediaProgressForUser: vi.fn().mockResolvedValue([]),
    getMediaProgress: vi.fn().mockResolvedValue(null),
  } as unknown as AbsProgressService;
  const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue(opts.accessibleIds ?? [5]) } as unknown as LibraryService;
  return { service: new AbsCatalogService(readRepo, progressService, libraryService), readRepo };
}

describe('parseAbsSort', () => {
  it('maps ABS sort strings to repository columns, defaulting to addedAt', () => {
    expect(parseAbsSort(undefined)).toBe('addedAt');
    expect(parseAbsSort('media.metadata.title')).toBe('title');
    expect(parseAbsSort('media.metadata.publishedYear')).toBe('publishedYear');
    expect(parseAbsSort('unknown.field')).toBe('addedAt');
  });
});

describe('AbsCatalogService#listLibraryItems', () => {
  const query = { limit: 10, page: 1, sort: 'addedAt' as const, desc: true, minified: false };

  it('404s when a scoped user cannot access the library', async () => {
    const { service } = build({ accessibleIds: [99] });
    expect(await thrownStatus(() => service.listLibraryItems(makeAbsUser({ isSuperuser: false }), 5, query))).toBe(404);
  });

  it('returns the ABS browse envelope with computed offset', async () => {
    const { service } = build({ listItems: { rows: [item()], total: 1 } });
    const result = await service.listLibraryItems(makeAbsUser(), 5, query);
    expect(result).toMatchObject({ total: 1, limit: 10, page: 1, offset: 10, mediaType: 'book', sortDesc: true });
    expect((result.results as unknown[]).length).toBe(1);
  });

  it('uses offset 0 when limit is 0 (no-limit browse)', async () => {
    const { service, readRepo } = build();
    await service.listLibraryItems(makeAbsUser(), 5, { ...query, limit: 0, page: 3 });
    expect(readRepo.listItems).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }));
  });

  it('always emits minified item media regardless of the query minified flag (matches ABS getLibraryItems)', async () => {
    const { service } = build({ listItems: { rows: [item()], total: 1 } });
    const result = await service.listLibraryItems(makeAbsUser(), 5, { ...query, minified: false });
    const media = (result.results as Array<{ media: Record<string, unknown> }>)[0].media;
    // Minified Book shape carries these counts; the expanded shape Prologue cannot decode does not.
    expect(media).toHaveProperty('numAudioFiles');
    expect(media).toHaveProperty('numChapters');
    expect(media).not.toHaveProperty('audioFiles');
  });
});

describe('AbsCatalogService#getLibraryItem', () => {
  it('404s when the item is missing', async () => {
    const { service } = build({ findItem: null });
    expect(await thrownStatus(() => service.getLibraryItem(makeAbsUser(), 3))).toBe(404);
  });

  it('404s when the item is still processing', async () => {
    const { service } = build({ findItem: item({ status: 'processing' }) });
    expect(await thrownStatus(() => service.getLibraryItem(makeAbsUser(), 3))).toBe(404);
  });

  it('maps an accessible item', async () => {
    const { service } = build({ findItem: item() });
    const result = await service.getLibraryItem(makeAbsUser(), 3);
    expect(result.id).toBe('li_3');
  });
});

describe('AbsCatalogService#getLibraryItemsBatch', () => {
  it('filters out processing and inaccessible items', async () => {
    const items = [item({ id: 3, libraryId: 5 }), item({ id: 4, libraryId: 5, status: 'processing' }), item({ id: 5, libraryId: 99 })];
    const { service } = build({ findItemsByIds: items, accessibleIds: [5] });
    const result = await service.getLibraryItemsBatch(makeAbsUser({ isSuperuser: false }), [3, 4, 5]);
    expect(result.map((r) => r.id)).toEqual(['li_3']);
  });

  it('returns all non-processing items for a superuser', async () => {
    const items = [item({ id: 3, libraryId: 5 }), item({ id: 5, libraryId: 99 })];
    const { service } = build({ findItemsByIds: items });
    const result = await service.getLibraryItemsBatch(makeAbsUser({ isSuperuser: true }), [3, 5]);
    expect(result.map((r) => r.id)).toEqual(['li_3', 'li_5']);
  });
});

describe('AbsCatalogService#listAuthors', () => {
  it('404s when a scoped user cannot access the library', async () => {
    const { service } = build({ accessibleIds: [99] });
    expect(await thrownStatus(() => service.listAuthors(makeAbsUser({ isSuperuser: false }), 5))).toBe(404);
  });

  it('returns the bare { authors } envelope for a non-paginated request, each carrying libraryId', async () => {
    const { service } = build({
      authorsInLibrary: [{ id: 1, name: 'Andy Weir', description: 'bio', numBooks: 2 }],
    });
    const result = await service.listAuthors(makeAbsUser(), 5);
    expect(result).toEqual({ authors: [expect.objectContaining({ id: 'aut_1', name: 'Andy Weir', numBooks: 2, libraryId: 'lib_5' })] });
  });

  // Regression: ABS returns the paginated { results } envelope when limit+page are present, and each
  // author carries a non-optional libraryId. Prologue sends limit=50&page=0, reads `.results`, and
  // strict-decodes the Author objects — a missing libraryId (or a bare { authors }) blanks the library.
  it('returns a paginated { results } envelope with libraryId-bearing authors when limit+page supplied', async () => {
    const { service } = build({
      authorsInLibrary: [
        { id: 1, name: 'Andy Weir', description: null, numBooks: 2 },
        { id: 2, name: 'Brandon Sanderson', description: null, numBooks: 3 },
      ],
    });
    const result = await service.listAuthors(makeAbsUser(), 5, { limit: '50', page: '0' });
    expect(result.authors).toBeUndefined();
    expect(result.total).toBe(2);
    expect(result.limit).toBe(50);
    expect(result.page).toBe(0);
    expect(result.results).toEqual([
      expect.objectContaining({ id: 'aut_1', name: 'Andy Weir', lastFirst: 'Weir, Andy', libraryId: 'lib_5' }),
      expect.objectContaining({ id: 'aut_2', name: 'Brandon Sanderson', lastFirst: 'Sanderson, Brandon', libraryId: 'lib_5' }),
    ]);
  });

  it('slices the paginated results by limit and page', async () => {
    const { service } = build({
      authorsInLibrary: [
        { id: 1, name: 'A A', description: null, numBooks: 1 },
        { id: 2, name: 'B B', description: null, numBooks: 1 },
        { id: 3, name: 'C C', description: null, numBooks: 1 },
      ],
    });
    const result = await service.listAuthors(makeAbsUser(), 5, { limit: '2', page: '1' });
    expect(result.total).toBe(3);
    expect((result.results as unknown[]).length).toBe(1);
    expect(result.results).toEqual([expect.objectContaining({ id: 'aut_3' })]);
  });
});

describe('AbsCatalogService#getAuthor', () => {
  it('404s when the author does not exist', async () => {
    const { service } = build({ findAuthor: null });
    expect(await thrownStatus(() => service.getAuthor(makeAbsUser(), 1, []))).toBe(404);
  });

  it('returns the bare author when items are not requested', async () => {
    const { service, readRepo } = build();
    const result = await service.getAuthor(makeAbsUser(), 1, []);
    expect(result).toMatchObject({ id: 'aut_1', name: 'Andy Weir' });
    expect(result.libraryItems).toBeUndefined();
    expect(readRepo.bookIdsForAuthor).not.toHaveBeenCalled();
  });

  it('eager-loads access-filtered items and recomputes numBooks when include=items', async () => {
    const { service } = build({
      bookIdsForAuthor: [3, 5],
      findItemsByIds: [item({ id: 3, libraryId: 5 }), item({ id: 5, libraryId: 99 })],
      accessibleIds: [5],
    });
    const result = await service.getAuthor(makeAbsUser({ isSuperuser: false }), 1, ['items']);
    const items = result.libraryItems as { id: string }[];
    expect(items.map((i) => i.id)).toEqual(['li_3']);
    expect(result.numBooks).toBe(1);
  });
});

describe('AbsCatalogService#getDownloadFile', () => {
  const downloader = makeAbsUser({ isSuperuser: false, permissions: [Permission.LibraryDownload] });

  it('returns the file for an authorized downloader', async () => {
    const { service } = build();
    const file = await service.getDownloadFile(downloader, 3, 7);
    expect(file.absolutePath).toBe('/audio/hobbit.m4b');
  });

  it('404s when the file does not exist', async () => {
    const { service } = build({ findBookFileById: null });
    expect(await thrownStatus(() => service.getDownloadFile(downloader, 3, 7))).toBe(404);
  });

  it('404s when the file belongs to a different book', async () => {
    const { service } = build({ findBookFileById: audioFile({ bookId: 99 }) });
    expect(await thrownStatus(() => service.getDownloadFile(downloader, 3, 7))).toBe(404);
  });

  it('404s when the user cannot access the library', async () => {
    const { service } = build({ accessibleIds: [99] });
    expect(await thrownStatus(() => service.getDownloadFile(downloader, 3, 7))).toBe(404);
  });

  it('403s when the user lacks the download permission', async () => {
    const { service } = build();
    expect(await thrownStatus(() => service.getDownloadFile(makeAbsUser({ isSuperuser: false, permissions: [] }), 3, 7))).toBe(403);
  });
});

describe('AbsCatalogService#getItemFile', () => {
  it('returns the file without requiring the download permission', async () => {
    const { service } = build();
    const file = await service.getItemFile(makeAbsUser({ isSuperuser: false, permissions: [] }), 3, 7);
    expect(file.absolutePath).toBe('/audio/hobbit.m4b');
  });

  it('404s when the file does not exist', async () => {
    const { service } = build({ findBookFileById: null });
    expect(await thrownStatus(() => service.getItemFile(makeAbsUser(), 3, 7))).toBe(404);
  });

  it('404s when the file belongs to a different book', async () => {
    const { service } = build({ findBookFileById: audioFile({ bookId: 99 }) });
    expect(await thrownStatus(() => service.getItemFile(makeAbsUser(), 3, 7))).toBe(404);
  });

  it('404s when the user cannot access the library', async () => {
    const { service } = build({ accessibleIds: [99] });
    expect(await thrownStatus(() => service.getItemFile(makeAbsUser({ isSuperuser: false }), 3, 7))).toBe(404);
  });
});

describe('AbsCatalogService#getDownloadBundle', () => {
  const downloader = makeAbsUser({ isSuperuser: false, permissions: [Permission.LibraryDownload] });

  it('returns the title and content files for an authorized downloader', async () => {
    const { service } = build();
    const bundle = await service.getDownloadBundle(downloader, 3);
    expect(bundle.title).toBe('The Hobbit');
    expect(bundle.files).toHaveLength(1);
  });

  it('404s when the item has no content files', async () => {
    const { service } = build({ audioFilesByBookId: [] });
    expect(await thrownStatus(() => service.getDownloadBundle(downloader, 3))).toBe(404);
  });

  it('403s when the user lacks the download permission', async () => {
    const { service } = build();
    expect(await thrownStatus(() => service.getDownloadBundle(makeAbsUser({ isSuperuser: false, permissions: [] }), 3))).toBe(403);
  });
});
