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

describe('AbsMeController#listeningSessions', () => {
  it('returns an empty ABS history page echoing pagination params', () => {
    const { controller } = build([], []);
    expect(controller.listeningSessions({ page: '2', itemsPerPage: '25' })).toEqual({
      total: 0,
      numPages: 0,
      page: 2,
      itemsPerPage: 25,
      sessions: [],
    });
  });

  it('defaults to page 0 / itemsPerPage 10 when params are missing or invalid', () => {
    const { controller } = build([], []);
    expect(controller.listeningSessions({})).toMatchObject({ page: 0, itemsPerPage: 10, sessions: [] });
  });
});

describe('AbsMeController#deleteProgress', () => {
  function build(removed = true) {
    const progressService = { deleteProgress: vi.fn().mockResolvedValue(removed) } as unknown as AbsProgressService;
    const controller = new AbsMeController(
      progressService,
      {} as unknown as LibraryService,
      {} as unknown as AbsCatalogService,
      {} as unknown as AbsBookmarkService,
    );
    return { controller, progressService };
  }

  it('deletes by the composite progress id, decoding the library item half', async () => {
    const { controller, progressService } = build();
    await controller.deleteProgress(makeAbsUser({ id: 8 }), 'usr_8-li_42');
    expect(progressService.deleteProgress).toHaveBeenCalledWith(8, 42);
  });

  it('also accepts a bare library item id', async () => {
    const { controller, progressService } = build();
    await controller.deleteProgress(makeAbsUser({ id: 8 }), 'li_42');
    expect(progressService.deleteProgress).toHaveBeenCalledWith(8, 42);
  });

  it('404s when the composite id names a different user', async () => {
    const { controller, progressService } = build();
    await expect(controller.deleteProgress(makeAbsUser({ id: 8 }), 'usr_9-li_42')).rejects.toMatchObject({});
    expect(progressService.deleteProgress).not.toHaveBeenCalled();
  });

  it('404s on a malformed id', async () => {
    const { controller } = build();
    await expect(controller.deleteProgress(makeAbsUser({ id: 8 }), 'not-an-id')).rejects.toMatchObject({});
  });

  it('404s when there was no progress to remove', async () => {
    const { controller } = build(false);
    await expect(controller.deleteProgress(makeAbsUser({ id: 8 }), 'usr_8-li_42')).rejects.toMatchObject({});
  });
});

describe('AbsMeController stub stats endpoints', () => {
  function build() {
    return new AbsMeController(
      {} as unknown as AbsProgressService,
      {} as unknown as LibraryService,
      {} as unknown as AbsCatalogService,
      {} as unknown as AbsBookmarkService,
    );
  }

  it('returns an empty per-item listening-sessions page echoing pagination params', () => {
    expect(build().itemListeningSessions('li_42', { page: '2', itemsPerPage: '25' })).toEqual({
      total: 0,
      numPages: 0,
      page: 2,
      itemsPerPage: 25,
      sessions: [],
    });
  });

  it('404s per-item listening-sessions on a malformed library item id', () => {
    expect(() => build().itemListeningSessions('nope', {})).toThrow();
  });

  it('returns zeroed listening stats', () => {
    expect(build().listeningStats()).toMatchObject({ totalTime: 0, items: {}, recentSessions: [] });
  });

  it('returns zeroed year stats with array buckets', () => {
    expect(build().statsForYear()).toMatchObject({
      totalListeningTime: 0,
      topAuthors: [],
      longestAudiobookFinished: null,
      finishedBooksWithCovers: [],
    });
  });
});

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
