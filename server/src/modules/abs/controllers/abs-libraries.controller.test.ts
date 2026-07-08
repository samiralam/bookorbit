import type { LibraryService } from '../../library/library.service';
import type { AbsCatalogService } from '../services/abs-catalog.service';
import { makeAbsUser, thrownStatus } from '../__testing__/abs-test-helpers';
import { AbsLibrariesController } from './abs-libraries.controller';

interface BuildOpts {
  libraries?: { id: number; name: string }[];
  accessibleIds?: number[];
  findOne?: unknown;
}

function build(opts: BuildOpts = {}) {
  const libraryService = {
    findAll: vi.fn().mockResolvedValue(opts.libraries ?? []),
    findAccessibleLibraryIds: vi.fn().mockResolvedValue(opts.accessibleIds ?? []),
    findOne: vi.fn().mockResolvedValue(opts.findOne ?? null),
  } as unknown as LibraryService;
  const catalogService = {
    listLibraryItems: vi.fn().mockResolvedValue({ results: [], total: 0 }),
    listAuthors: vi.fn().mockResolvedValue({ authors: [] }),
  } as unknown as AbsCatalogService;
  return { controller: new AbsLibrariesController(libraryService, catalogService), libraryService, catalogService };
}

describe('AbsLibrariesController#list', () => {
  it('returns mapped libraries under a { libraries } envelope', async () => {
    const { controller } = build({ libraries: [{ id: 1, name: 'Audiobooks' }] });
    const result = await controller.list(makeAbsUser());
    const libraries = result.libraries as Record<string, unknown>[];
    expect(libraries).toHaveLength(1);
    expect(libraries[0].id).toBe('lib_1');
  });
});

describe('AbsLibrariesController#getOne', () => {
  it('404s on a malformed library id', async () => {
    const { controller } = build();
    expect(await thrownStatus(() => controller.getOne(makeAbsUser(), 'bogus'))).toBe(404);
  });

  it('404s when a scoped user cannot access the library (no existence leak)', async () => {
    const { controller } = build({ accessibleIds: [9] });
    expect(await thrownStatus(() => controller.getOne(makeAbsUser({ isSuperuser: false }), 'lib_2'))).toBe(404);
  });

  it('404s when the library does not exist', async () => {
    const { controller } = build({ accessibleIds: [2], findOne: null });
    expect(await thrownStatus(() => controller.getOne(makeAbsUser({ isSuperuser: false }), 'lib_2'))).toBe(404);
  });

  it('returns the mapped library for an accessible id', async () => {
    const { controller } = build({ accessibleIds: [2], findOne: { id: 2, name: 'Audiobooks' } });
    const lib = await controller.getOne(makeAbsUser({ isSuperuser: false }), 'lib_2');
    expect(lib.id).toBe('lib_2');
  });
});

describe('AbsLibrariesController#items', () => {
  it('404s on a malformed library id', async () => {
    const { controller } = build();
    expect(await thrownStatus(() => controller.items(makeAbsUser(), 'bogus', {}))).toBe(404);
  });

  it('parses pagination/sort flags and delegates to the catalog service', async () => {
    const { controller, catalogService } = build();
    await controller.items(makeAbsUser(), 'lib_5', { limit: '25', page: '2', sort: 'media.metadata.title', desc: '1', minified: '1' });
    expect(catalogService.listLibraryItems).toHaveBeenCalledWith(expect.anything(), 5, {
      limit: 25,
      page: 2,
      sort: 'title',
      rawSort: 'media.metadata.title',
      desc: true,
      minified: true,
      filter: undefined,
    });
  });

  it('defaults to limit 0 (no limit), page 0, addedAt sort, ascending', async () => {
    const { controller, catalogService } = build();
    await controller.items(makeAbsUser(), 'lib_5', {});
    expect(catalogService.listLibraryItems).toHaveBeenCalledWith(expect.anything(), 5, {
      limit: 0,
      page: 0,
      sort: 'addedAt',
      desc: false,
      minified: false,
    });
  });
});

describe('AbsLibrariesController#authors', () => {
  it('404s on a malformed library id', async () => {
    const { controller } = build();
    expect(await thrownStatus(() => controller.authors(makeAbsUser(), 'bogus', {}))).toBe(404);
  });

  it('delegates to the catalog service with the decoded library id and query', async () => {
    const { controller, catalogService } = build();
    const result = await controller.authors(makeAbsUser(), 'lib_5', { limit: '50', page: '0' });
    expect(catalogService.listAuthors).toHaveBeenCalledWith(expect.anything(), 5, { limit: '50', page: '0' });
    expect(result).toEqual({ authors: [] });
  });
});
