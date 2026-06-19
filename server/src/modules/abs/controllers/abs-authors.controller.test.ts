import type { AbsCatalogService } from '../services/abs-catalog.service';
import { makeAbsUser, thrownStatus } from '../__testing__/abs-test-helpers';
import { AbsAuthorsController } from './abs-authors.controller';

function build() {
  const catalogService = { getAuthor: vi.fn().mockResolvedValue({ id: 'aut_1', name: 'Andy Weir' }) } as unknown as AbsCatalogService;
  return { controller: new AbsAuthorsController(catalogService), catalogService };
}

describe('AbsAuthorsController#getOne', () => {
  it('404s on a malformed author id', async () => {
    const { controller } = build();
    expect(await thrownStatus(() => controller.getOne(makeAbsUser(), 'bogus', {}))).toBe(404);
  });

  it('parses the include csv and delegates to the catalog service', async () => {
    const { controller, catalogService } = build();
    await controller.getOne(makeAbsUser(), 'aut_1', { include: 'items, series' });
    expect(catalogService.getAuthor).toHaveBeenCalledWith(expect.anything(), 1, ['items', 'series']);
  });

  it('passes an empty include list when the param is absent', async () => {
    const { controller, catalogService } = build();
    await controller.getOne(makeAbsUser(), 'aut_1', {});
    expect(catalogService.getAuthor).toHaveBeenCalledWith(expect.anything(), 1, []);
  });
});
