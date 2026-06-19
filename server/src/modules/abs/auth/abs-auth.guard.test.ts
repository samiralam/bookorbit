import { UnauthorizedException } from '@nestjs/common';

import type { UserService } from '../../user/user.service';
import { makeAbsUser, makeRequest } from '../__testing__/abs-test-helpers';
import { AbsAuthGuard, extractAbsToken } from './abs-auth.guard';
import type { AbsTokenService } from './abs-token.service';

function makeContext(request: unknown) {
  return { switchToHttp: () => ({ getRequest: () => request }) } as any;
}

describe('extractAbsToken', () => {
  it('reads a Bearer token from the Authorization header', () => {
    expect(extractAbsToken(makeRequest({ headers: { authorization: 'Bearer abc.def' } }))).toBe('abc.def');
  });

  it('reads the ?token= query param (how <img>/<audio> tags authenticate)', () => {
    expect(extractAbsToken(makeRequest({ query: { token: 'qtok' } }))).toBe('qtok');
  });

  it('returns null when no token is present or the bearer is empty', () => {
    expect(extractAbsToken(makeRequest())).toBeNull();
    expect(extractAbsToken(makeRequest({ headers: { authorization: 'Bearer ' } }))).toBeNull();
  });
});

describe('AbsAuthGuard', () => {
  function build(opts: { payload?: { userId: number; username: string } | null; user?: unknown }) {
    const tokenService = { verifyAccessToken: vi.fn().mockReturnValue(opts.payload ?? null) } as unknown as AbsTokenService;
    const userService = { findByIdWithPermissions: vi.fn().mockResolvedValue(opts.user ?? null) } as unknown as UserService;
    return { guard: new AbsAuthGuard(tokenService, userService), tokenService, userService };
  }

  it('rejects a request with no token', async () => {
    const { guard } = build({});
    await expect(guard.canActivate(makeContext(makeRequest()))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an invalid/expired token', async () => {
    const { guard } = build({ payload: null });
    const ctx = makeContext(makeRequest({ headers: { authorization: 'Bearer bad' } }));
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when the user is missing or inactive', async () => {
    const { guard } = build({ payload: { userId: 1, username: 'a' }, user: makeAbsUser({ active: false }) });
    const ctx = makeContext(makeRequest({ headers: { authorization: 'Bearer ok' } }));
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('attaches request.user and allows a valid token', async () => {
    const user = makeAbsUser({ id: 42 });
    const { guard } = build({ payload: { userId: 42, username: 'admin' }, user });
    const request = makeRequest({ headers: { authorization: 'Bearer ok' } });
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    expect(request.user).toBe(user);
  });
});
