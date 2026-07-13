import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AuthService } from '../../auth/auth.service';
import type { LibraryService } from '../../library/library.service';
import type { AbsBookmarkService } from '../services/abs-bookmark.service';
import type { AbsCatalogService } from '../services/abs-catalog.service';
import type { AbsProgressService } from '../services/abs-progress.service';
import type { AbsSessionHistoryService } from '../services/abs-session-history.service';
import { makeAbsUser, thrownStatus } from '../__testing__/abs-test-helpers';
import { AbsMeController } from './abs-me.controller';

const noopAuthService = {} as unknown as AuthService;
const noopHistoryService = {} as unknown as AbsSessionHistoryService;

function build(progress: Record<string, unknown>[], accessibleIds: number[]) {
  const progressService = { listMediaProgressForUser: vi.fn().mockResolvedValue(progress) } as unknown as AbsProgressService;
  const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue(accessibleIds) } as unknown as LibraryService;
  const catalogService = {} as unknown as AbsCatalogService;
  const bookmarkService = { listForUser: vi.fn().mockResolvedValue([]) } as unknown as AbsBookmarkService;
  return {
    controller: new AbsMeController(progressService, libraryService, catalogService, bookmarkService, noopAuthService, noopHistoryService),
    progressService,
  };
}

describe('AbsMeController#deleteProgress', () => {
  function build(removed = true) {
    const progressService = { deleteProgress: vi.fn().mockResolvedValue(removed) } as unknown as AbsProgressService;
    const controller = new AbsMeController(
      progressService,
      {} as unknown as LibraryService,
      {} as unknown as AbsCatalogService,
      {} as unknown as AbsBookmarkService,
      noopAuthService,
      noopHistoryService,
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

describe('AbsMeController#removeFromContinueListening', () => {
  const meReq = { headers: { authorization: 'Bearer abs-jwt' } } as unknown as FastifyRequest;

  function build(hidden = true) {
    const progressService = {
      hideFromContinueListening: vi.fn().mockResolvedValue(hidden),
      listMediaProgressForUser: vi.fn().mockResolvedValue([{ id: 'usr_8-li_42', hideFromContinueListening: true }]),
    } as unknown as AbsProgressService;
    const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([3]) } as unknown as LibraryService;
    const bookmarkService = { listForUser: vi.fn().mockResolvedValue([]) } as unknown as AbsBookmarkService;
    const controller = new AbsMeController(
      progressService,
      libraryService,
      {} as unknown as AbsCatalogService,
      bookmarkService,
      noopAuthService,
      noopHistoryService,
    );
    return { controller, progressService };
  }

  it('hides by the composite progress id and responds with the full user JSON, like ABS', async () => {
    const { controller, progressService } = build();
    const user = await controller.removeFromContinueListening(makeAbsUser({ id: 8, isSuperuser: false }), 'usr_8-li_42', meReq);
    expect(progressService.hideFromContinueListening).toHaveBeenCalledWith(8, 42);
    expect(user.id).toBe('usr_8');
    expect(user.mediaProgress).toEqual([{ id: 'usr_8-li_42', hideFromContinueListening: true }]);
  });

  it('also accepts a bare library item id', async () => {
    const { controller, progressService } = build();
    await controller.removeFromContinueListening(makeAbsUser({ id: 8 }), 'li_42', meReq);
    expect(progressService.hideFromContinueListening).toHaveBeenCalledWith(8, 42);
  });

  it('404s when the composite id names a different user', async () => {
    const { controller, progressService } = build();
    await expect(thrownStatus(() => controller.removeFromContinueListening(makeAbsUser({ id: 8 }), 'usr_9-li_42', meReq))).resolves.toBe(404);
    expect(progressService.hideFromContinueListening).not.toHaveBeenCalled();
  });

  it('404s when there is no progress row to hide', async () => {
    const { controller } = build(false);
    await expect(thrownStatus(() => controller.removeFromContinueListening(makeAbsUser({ id: 8 }), 'usr_8-li_42', meReq))).resolves.toBe(404);
  });
});

describe('AbsMeController history/stats endpoints (delegation to AbsSessionHistoryService)', () => {
  function build() {
    const historyService = {
      listeningSessions: vi.fn().mockResolvedValue({ total: 0, numPages: 0, page: 0, itemsPerPage: 10, sessions: [] }),
      itemListeningSessions: vi.fn().mockResolvedValue({ total: 0, numPages: 0, page: 0, itemsPerPage: 10, sessions: [] }),
      listeningStats: vi.fn().mockResolvedValue({ totalTime: 0 }),
      statsForYear: vi.fn().mockResolvedValue({ totalListeningTime: 0 }),
    } as unknown as AbsSessionHistoryService;
    const controller = new AbsMeController(
      {} as unknown as AbsProgressService,
      {} as unknown as LibraryService,
      {} as unknown as AbsCatalogService,
      {} as unknown as AbsBookmarkService,
      noopAuthService,
      historyService,
    );
    return { controller, historyService };
  }

  it('listening-sessions passes the caller and query through', async () => {
    const { controller, historyService } = build();
    const query = { page: '2', itemsPerPage: '25' };
    await controller.listeningSessions(makeAbsUser({ id: 8 }), query);
    expect(historyService.listeningSessions).toHaveBeenCalledWith(expect.objectContaining({ id: 8 }), query);
  });

  it('item listening-sessions passes the raw item id for the service to decode/404', async () => {
    const { controller, historyService } = build();
    await controller.itemListeningSessions(makeAbsUser({ id: 8 }), 'li_42', {});
    expect(historyService.itemListeningSessions).toHaveBeenCalledWith(expect.objectContaining({ id: 8 }), 'li_42', {});
  });

  it('listening-stats delegates for the caller', async () => {
    const { controller, historyService } = build();
    await controller.listeningStats(makeAbsUser({ id: 8 }));
    expect(historyService.listeningStats).toHaveBeenCalledWith(expect.objectContaining({ id: 8 }));
  });

  it('stats/year parses the year and coerces garbage to an empty year', async () => {
    const { controller, historyService } = build();
    await controller.statsForYear(makeAbsUser({ id: 8 }), '2026');
    expect(historyService.statsForYear).toHaveBeenCalledWith(expect.objectContaining({ id: 8 }), 2026);
    await controller.statsForYear(makeAbsUser({ id: 8 }), 'nope');
    expect(historyService.statsForYear).toHaveBeenLastCalledWith(expect.anything(), 0);
  });
});

describe('AbsMeController#me', () => {
  const meReq = { headers: { authorization: 'Bearer abs-jwt' } } as any;

  it('returns the current user with their media progress', async () => {
    const { controller, progressService } = build([{ id: 'mp1' }], [3]);
    const user = await controller.me(makeAbsUser({ id: 8, isSuperuser: false }), meReq);
    expect(user.id).toBe('usr_8');
    expect(user.mediaProgress).toEqual([{ id: 'mp1' }]);
    expect(progressService.listMediaProgressForUser).toHaveBeenCalledWith(8);
  });

  it('echoes the caller bearer as the legacy token (live ABS never sends null there)', async () => {
    const { controller } = build([], [3]);
    const user = await controller.me(makeAbsUser({ id: 8, isSuperuser: false }), meReq);
    expect(user.token).toBe('abs-jwt');
  });

  it('exposes encoded accessible library ids for scoped users', async () => {
    const { controller } = build([], [3, 7]);
    const user = await controller.me(makeAbsUser({ isSuperuser: false }), meReq);
    expect(user.librariesAccessible).toEqual(['lib_3', 'lib_7']);
  });

  it('hides the library list for superusers (empty array means "all")', async () => {
    const { controller } = build([], [3, 7]);
    const user = await controller.me(makeAbsUser({ isSuperuser: true }), meReq);
    expect(user.librariesAccessible).toEqual([]);
  });

  it('includes the user bookmarks in the /me payload', async () => {
    const progressService = { listMediaProgressForUser: vi.fn().mockResolvedValue([]) } as unknown as AbsProgressService;
    const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([]) } as unknown as LibraryService;
    const bookmarks = [{ libraryItemId: 'li_3', title: 'A quote', time: 120, createdAt: 0 }];
    const bookmarkService = { listForUser: vi.fn().mockResolvedValue(bookmarks) } as unknown as AbsBookmarkService;
    const controller = new AbsMeController(
      progressService,
      libraryService,
      {} as unknown as AbsCatalogService,
      bookmarkService,
      noopAuthService,
      noopHistoryService,
    );

    const user = await controller.me(makeAbsUser({ id: 8 }), meReq);
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
      noopAuthService,
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

describe('AbsMeController#changePassword', () => {
  function build() {
    const authService = { changePassword: vi.fn().mockResolvedValue(undefined) } as unknown as AuthService;
    const controller = new AbsMeController(
      {} as unknown as AbsProgressService,
      {} as unknown as LibraryService,
      {} as unknown as AbsCatalogService,
      {} as unknown as AbsBookmarkService,
      authService,
    );
    return { controller, authService };
  }

  const reply = {} as unknown as FastifyReply;
  const req = { ip: '1.2.3.4' } as unknown as FastifyRequest;
  const strong = 'NewPassw0rd';

  it('delegates to AuthService.changePassword and returns 200 (no body)', async () => {
    const { controller, authService } = build();
    await expect(controller.changePassword(makeAbsUser({ id: 8 }), { password: 'old', newPassword: strong }, req, reply)).resolves.toBeUndefined();
    expect(authService.changePassword).toHaveBeenCalledWith(8, { currentPassword: 'old', newPassword: strong }, reply, '1.2.3.4');
  });

  it('403s a demo-restricted account before touching AuthService', async () => {
    const { controller, authService } = build();
    await expect(
      thrownStatus(() =>
        controller.changePassword(makeAbsUser({ permissions: [Permission.DemoRestricted] }), { password: 'old', newPassword: strong }, req, reply),
      ),
    ).resolves.toBe(403);
    expect(authService.changePassword).not.toHaveBeenCalled();
  });

  it('400s when either field is missing or not a string', async () => {
    const { controller } = build();
    await expect(thrownStatus(() => controller.changePassword(makeAbsUser(), { newPassword: strong }, req, reply))).resolves.toBe(400);
    await expect(
      thrownStatus(() => controller.changePassword(makeAbsUser(), { password: 'old', newPassword: 123 as unknown as string }, req, reply)),
    ).resolves.toBe(400);
  });

  it('400s a new password that fails the BookOrbit complexity policy', async () => {
    const { controller, authService } = build();
    await expect(thrownStatus(() => controller.changePassword(makeAbsUser(), { password: 'old', newPassword: 'weak' }, req, reply))).resolves.toBe(
      400,
    );
    expect(authService.changePassword).not.toHaveBeenCalled();
  });

  it('maps a wrong current password (UnauthorizedException) to 400', async () => {
    const { controller, authService } = build();
    (authService.changePassword as ReturnType<typeof vi.fn>).mockRejectedValue(new UnauthorizedException('Current password is incorrect'));
    await expect(thrownStatus(() => controller.changePassword(makeAbsUser(), { password: 'wrong', newPassword: strong }, req, reply))).resolves.toBe(
      400,
    );
  });

  it('maps an OIDC/shared rejection (BadRequestException) to 400', async () => {
    const { controller, authService } = build();
    (authService.changePassword as ReturnType<typeof vi.fn>).mockRejectedValue(
      new BadRequestException('OIDC accounts cannot change their password here'),
    );
    await expect(thrownStatus(() => controller.changePassword(makeAbsUser(), { password: 'old', newPassword: strong }, req, reply))).resolves.toBe(
      400,
    );
  });
});
