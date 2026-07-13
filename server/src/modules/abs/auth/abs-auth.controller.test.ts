import { hash } from 'bcryptjs';

import type { LibraryService } from '../../library/library.service';
import type { UserService } from '../../user/user.service';
import { makeAbsUser, makeRequest, thrownStatus } from '../__testing__/abs-test-helpers';
import type { AbsProgressService } from '../services/abs-progress.service';
import { AbsAuthController } from './abs-auth.controller';
import type { AbsSessionService } from './abs-session.service';
import type { AbsTokenService } from './abs-token.service';

const PASSWORD = 'correct horse';
let PASSWORD_HASH: string;

beforeAll(async () => {
  PASSWORD_HASH = await hash(PASSWORD, 4); // low cost: tests don't need production strength
});

interface BuildOpts {
  candidate?: Record<string, unknown> | null;
  user?: ReturnType<typeof makeAbsUser> | null;
  accessibleIds?: number[];
  mediaProgress?: Record<string, unknown>[];
}

function build(opts: BuildOpts = {}) {
  const userService = {
    findByUsername: vi.fn().mockResolvedValue(opts.candidate ?? null),
    findByIdWithPermissions: vi.fn().mockResolvedValue(opts.user ?? null),
  } as unknown as UserService;
  const sessionService = {
    createSession: vi.fn().mockResolvedValue({ accessToken: 'acc', refreshToken: 'ref' }),
    rotate: vi.fn().mockResolvedValue({ accessToken: 'acc2', refreshToken: 'ref2' }),
    invalidate: vi.fn().mockResolvedValue(undefined),
  } as unknown as AbsSessionService;
  const tokenService = {
    verifyRefreshToken: vi.fn().mockReturnValue({ userId: 1, username: 'admin' }),
  } as unknown as AbsTokenService;
  const libraryService = {
    findAccessibleLibraryIds: vi.fn().mockResolvedValue(opts.accessibleIds ?? []),
  } as unknown as LibraryService;
  const progressService = {
    listMediaProgressForUser: vi.fn().mockResolvedValue(opts.mediaProgress ?? []),
  } as unknown as AbsProgressService;
  return {
    controller: new AbsAuthController(userService, sessionService, tokenService, libraryService, progressService),
    userService,
    sessionService,
    tokenService,
    progressService,
  };
}

describe('AbsAuthController#login', () => {
  it('returns the login payload with tokens in the body on valid credentials (mobile flow)', async () => {
    const candidate = { id: 1, active: true, lockedUntil: null, passwordHash: PASSWORD_HASH };
    const { controller, sessionService } = build({ candidate, user: makeAbsUser({ id: 1, isSuperuser: false }), accessibleIds: [4, 9] });

    const payload = await controller.login({ username: 'admin', password: PASSWORD }, makeRequest({ headers: { 'user-agent': 'app' } }));
    const user = payload.user as Record<string, unknown>;
    expect(user.accessToken).toBe('acc');
    expect(user.refreshToken).toBe('ref');
    expect(payload.userDefaultLibraryId).toBe('lib_4');
    expect(user.librariesAccessible).toEqual(['lib_4', 'lib_9']);
    expect(sessionService.createSession).toHaveBeenCalledTimes(1);
  });

  it("embeds the user's mediaProgress in the login payload (clients seed resume positions from it)", async () => {
    const candidate = { id: 1, active: true, lockedUntil: null, passwordHash: PASSWORD_HASH };
    const progress = [{ libraryItemId: 'li_9', currentTime: 120 }];
    const { controller, progressService } = build({ candidate, user: makeAbsUser({ id: 1, isSuperuser: false }), mediaProgress: progress });

    const payload = await controller.login({ username: 'admin', password: PASSWORD }, makeRequest());
    expect((payload.user as Record<string, unknown>).mediaProgress).toEqual(progress);
    expect(progressService.listMediaProgressForUser).toHaveBeenCalledWith(1);
  });

  it('rejects missing credentials with 401', async () => {
    const { controller } = build();
    expect(await thrownStatus(() => controller.login({ username: 'admin' }, makeRequest()))).toBe(401);
  });

  it('rejects an unknown user with 401', async () => {
    const { controller } = build({ candidate: null });
    expect(await thrownStatus(() => controller.login({ username: 'ghost', password: PASSWORD }, makeRequest()))).toBe(401);
  });

  it('rejects a wrong password with 401', async () => {
    const candidate = { id: 1, active: true, lockedUntil: null, passwordHash: PASSWORD_HASH };
    const { controller } = build({ candidate, user: makeAbsUser() });
    expect(await thrownStatus(() => controller.login({ username: 'admin', password: 'wrong' }, makeRequest()))).toBe(401);
  });

  it('rejects an inactive account with 401', async () => {
    const candidate = { id: 1, active: false, lockedUntil: null, passwordHash: PASSWORD_HASH };
    const { controller } = build({ candidate, user: makeAbsUser() });
    expect(await thrownStatus(() => controller.login({ username: 'admin', password: PASSWORD }, makeRequest()))).toBe(401);
  });

  it('rejects a locked account with 401', async () => {
    const candidate = { id: 1, active: true, lockedUntil: new Date(Date.now() + 60_000), passwordHash: PASSWORD_HASH };
    const { controller } = build({ candidate, user: makeAbsUser() });
    expect(await thrownStatus(() => controller.login({ username: 'admin', password: PASSWORD }, makeRequest()))).toBe(401);
  });
});

describe('AbsAuthController#refresh', () => {
  it('rotates tokens when a refresh token is presented on x-refresh-token', async () => {
    const { controller, sessionService } = build({ user: makeAbsUser({ id: 1 }) });
    const payload = await controller.refresh(makeRequest({ headers: { 'x-refresh-token': 'old-ref' } }));
    const user = payload.user as Record<string, unknown>;
    expect(sessionService.rotate).toHaveBeenCalledWith('old-ref');
    expect(user.accessToken).toBe('acc2');
    expect(user.refreshToken).toBe('ref2');
  });

  it("embeds the user's mediaProgress in the refresh payload", async () => {
    const progress = [{ libraryItemId: 'li_9', currentTime: 120 }];
    const { controller, progressService } = build({ user: makeAbsUser({ id: 1 }), mediaProgress: progress });
    const payload = await controller.refresh(makeRequest({ headers: { 'x-refresh-token': 'old-ref' } }));
    expect((payload.user as Record<string, unknown>).mediaProgress).toEqual(progress);
    expect(progressService.listMediaProgressForUser).toHaveBeenCalledWith(1);
  });

  it('returns 401 JSON when no refresh token header is present', async () => {
    const { controller } = build();
    expect(await thrownStatus(() => controller.refresh(makeRequest()))).toBe(401);
  });
});

describe('AbsAuthController#logout', () => {
  it('invalidates the presented refresh token and returns a null redirect_url', async () => {
    const { controller, sessionService } = build();
    const result = await controller.logout(makeRequest({ headers: { 'x-refresh-token': 'ref' } }));
    expect(result).toEqual({ redirect_url: null });
    expect(sessionService.invalidate).toHaveBeenCalledWith('ref');
  });
});
