import type { FastifyRequest } from 'fastify';

import type { RequestUser } from '../../../common/types/request-user';
import type { LibraryService } from '../../library/library.service';
import type { AbsProgressService } from '../services/abs-progress.service';
import { AbsAuthorizeController } from './abs-authorize.controller';

function makeUser(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 1,
    username: 'admin',
    name: 'admin',
    email: null,
    active: true,
    isSuperuser: true,
    isDefaultPassword: false,
    tokenVersion: 0,
    settings: {},
    avatarUrl: null,
    provisioningMethod: 'local',
    permissions: [],
    contentFilters: { rules: [] } as unknown as RequestUser['contentFilters'],
    ...overrides,
  };
}

function makeRequest(token: string | undefined): FastifyRequest {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    query: {},
  } as unknown as FastifyRequest;
}

function build(progress: Record<string, unknown>[], accessibleIds: number[]) {
  const progressService = {
    listMediaProgressForUser: vi.fn().mockResolvedValue(progress),
  } as unknown as AbsProgressService;
  const libraryService = {
    findAccessibleLibraryIds: vi.fn().mockResolvedValue(accessibleIds),
  } as unknown as LibraryService;
  return { controller: new AbsAuthorizeController(progressService, libraryService), progressService, libraryService };
}

describe('AbsAuthorizeController', () => {
  it('returns the full login payload echoing the presented access token', async () => {
    const { controller } = build([{ id: 'usr_1-li_3' }], [3]);

    const payload = await controller.authorize(makeUser(), makeRequest('echo-token'));
    const user = payload.user as Record<string, unknown>;

    // Same shape as POST /login (REIMPLEMENTATION_GUIDE §2.2).
    expect(payload.Source).toBe('bookorbit');
    expect(payload.serverSettings).toBeDefined();
    expect(payload.ereaderDevices).toEqual([]);
    // Echoes the bearer token rather than minting a new one; no new refresh token is issued.
    expect(user.accessToken).toBe('echo-token');
    expect(user.token).toBe('echo-token');
    expect(user.refreshToken).toBeNull();
    expect(user.mediaProgress).toEqual([{ id: 'usr_1-li_3' }]);
  });

  it('uses the first accessible library as the default and hides the list for superusers', async () => {
    const { controller } = build([], [3, 7]);

    const payload = await controller.authorize(makeUser({ isSuperuser: true }), makeRequest('t'));
    const user = payload.user as Record<string, unknown>;

    expect(payload.userDefaultLibraryId).toBe('lib_3');
    expect(user.librariesAccessible).toEqual([]); // superuser => "all"
  });

  it('exposes encoded accessible library ids for non-superusers', async () => {
    const { controller } = build([], [3, 7]);

    const payload = await controller.authorize(makeUser({ isSuperuser: false }), makeRequest('t'));
    const user = payload.user as Record<string, unknown>;

    expect(payload.userDefaultLibraryId).toBe('lib_3');
    expect(user.librariesAccessible).toEqual(['lib_3', 'lib_7']);
  });

  it('returns a null default library when none are accessible', async () => {
    const { controller } = build([], []);

    const payload = await controller.authorize(makeUser({ isSuperuser: false }), makeRequest('t'));

    expect(payload.userDefaultLibraryId).toBeNull();
  });
});
