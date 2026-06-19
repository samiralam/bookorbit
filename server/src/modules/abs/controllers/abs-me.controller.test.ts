import type { LibraryService } from '../../library/library.service';
import type { AbsBookmarkService } from '../services/abs-bookmark.service';
import type { AbsCatalogService } from '../services/abs-catalog.service';
import type { AbsProgressService } from '../services/abs-progress.service';
import { makeAbsUser } from '../__testing__/abs-test-helpers';
import { AbsMeController } from './abs-me.controller';

function build(progress: Record<string, unknown>[], accessibleIds: number[]) {
  const progressService = { listMediaProgressForUser: vi.fn().mockResolvedValue(progress) } as unknown as AbsProgressService;
  const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue(accessibleIds) } as unknown as LibraryService;
  const catalogService = {} as unknown as AbsCatalogService;
  const bookmarkService = { listForUser: vi.fn().mockResolvedValue([]) } as unknown as AbsBookmarkService;
  return { controller: new AbsMeController(progressService, libraryService, catalogService, bookmarkService), progressService };
}

describe('AbsMeController#me', () => {
  it('returns the current user with their media progress', async () => {
    const { controller, progressService } = build([{ id: 'mp1' }], [3]);
    const user = await controller.me(makeAbsUser({ id: 8, isSuperuser: false }));
    expect(user.id).toBe('usr_8');
    expect(user.mediaProgress).toEqual([{ id: 'mp1' }]);
    expect(progressService.listMediaProgressForUser).toHaveBeenCalledWith(8);
  });

  it('exposes encoded accessible library ids for scoped users', async () => {
    const { controller } = build([], [3, 7]);
    const user = await controller.me(makeAbsUser({ isSuperuser: false }));
    expect(user.librariesAccessible).toEqual(['lib_3', 'lib_7']);
  });

  it('hides the library list for superusers (empty array means "all")', async () => {
    const { controller } = build([], [3, 7]);
    const user = await controller.me(makeAbsUser({ isSuperuser: true }));
    expect(user.librariesAccessible).toEqual([]);
  });

  it('includes the user bookmarks in the /me payload', async () => {
    const progressService = { listMediaProgressForUser: vi.fn().mockResolvedValue([]) } as unknown as AbsProgressService;
    const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([]) } as unknown as LibraryService;
    const bookmarks = [{ libraryItemId: 'li_3', title: 'A quote', time: 120, createdAt: 0 }];
    const bookmarkService = { listForUser: vi.fn().mockResolvedValue(bookmarks) } as unknown as AbsBookmarkService;
    const controller = new AbsMeController(progressService, libraryService, {} as unknown as AbsCatalogService, bookmarkService);

    const user = await controller.me(makeAbsUser({ id: 8 }));
    expect(user.bookmarks).toEqual(bookmarks);
  });
});

describe('AbsMeController bookmarks', () => {
  function build() {
    const bookmarkService = {
      create: vi.fn().mockResolvedValue({ libraryItemId: 'li_3', title: 'T', time: 90, createdAt: 0 }),
      update: vi.fn().mockResolvedValue({ libraryItemId: 'li_3', title: 'New', time: 90, createdAt: 0 }),
      remove: vi.fn().mockResolvedValue(true),
    } as unknown as AbsBookmarkService;
    const controller = new AbsMeController(
      {} as unknown as AbsProgressService,
      {} as unknown as LibraryService,
      {} as unknown as AbsCatalogService,
      bookmarkService,
    );
    return { controller, bookmarkService };
  }

  it('creates a bookmark, decoding the library item id and forwarding time/title', async () => {
    const { controller, bookmarkService } = build();
    const result = await controller.createBookmark(makeAbsUser({ id: 8 }), 'li_3', { time: 90, title: 'T' });
    expect(bookmarkService.create).toHaveBeenCalledWith(8, 3, 90, 'T');
    expect(result.libraryItemId).toBe('li_3');
  });

  it('rejects a bookmark create with no time (404)', async () => {
    const { controller } = build();
    await expect(controller.createBookmark(makeAbsUser(), 'li_3', {})).rejects.toMatchObject({});
  });

  it('rejects a bad library item id (404)', async () => {
    const { controller } = build();
    await expect(controller.createBookmark(makeAbsUser(), 'not-an-id', { time: 1 })).rejects.toMatchObject({});
  });

  it('deletes the bookmark at :time', async () => {
    const { controller, bookmarkService } = build();
    await controller.deleteBookmark(makeAbsUser({ id: 8 }), 'li_3', '90');
    expect(bookmarkService.remove).toHaveBeenCalledWith(8, 3, 90);
  });

  it('404s deleting a bookmark that does not exist', async () => {
    const { controller, bookmarkService } = build();
    (bookmarkService.remove as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await expect(controller.deleteBookmark(makeAbsUser(), 'li_3', '90')).rejects.toMatchObject({});
  });
});
