import type { LibraryService } from '../../library/library.service';
import type { AbsItemRow, AbsReadRepository } from '../abs-read.repository';
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

interface BuildOpts {
  listItems?: { rows: AbsItemRow[]; total: number };
  findItem?: AbsItemRow | null;
  findItemsByIds?: AbsItemRow[];
  accessibleIds?: number[];
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
