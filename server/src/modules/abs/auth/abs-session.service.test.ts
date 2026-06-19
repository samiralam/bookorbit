import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as schema from '../../../db/schema';
import { thrownStatus } from '../__testing__/abs-test-helpers';
import { ABS_REFRESH_GRACE_MS, AbsSessionService } from './abs-session.service';
import { AbsTokenService } from './abs-token.service';

type Db = NodePgDatabase<typeof schema>;

function makeTokenService(): AbsTokenService {
  const config = { get: (k: string) => (k === 'auth.jwtSecret' ? 'session-secret-12345' : undefined) } as unknown as ConfigService;
  return new AbsTokenService(new JwtService({}), config);
}

describe('AbsSessionService#createSession', () => {
  it('persists a session row and returns the minted token pair', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const db = { insert: vi.fn(() => ({ values })) } as unknown as Db;
    const service = new AbsSessionService(makeTokenService(), db);

    const tokens = await service.createSession(7, 'alice', { ipAddress: '1.2.3.4', userAgent: 'app' });
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, refreshToken: tokens.refreshToken }));
  });
});

describe('AbsSessionService#rotate', () => {
  const tokenService = makeTokenService();

  function mintRefresh(userId = 7, username = 'alice'): string {
    return tokenService.signRefreshToken(userId, username).token;
  }

  it('rejects an invalid refresh token with 401', async () => {
    const db = {} as unknown as Db;
    const service = new AbsSessionService(tokenService, db);
    expect(await thrownStatus(() => service.rotate('not-a-jwt'))).toBe(401);
  });

  it('rejects a well-formed token with no matching session with 401', async () => {
    const db = { query: { absSessions: { findFirst: vi.fn().mockResolvedValue(undefined) } } } as unknown as Db;
    const service = new AbsSessionService(tokenService, db);
    expect(await thrownStatus(() => service.rotate(mintRefresh()))).toBe(401);
  });

  it('rotates the current token, issuing a brand-new refresh token', async () => {
    const presented = mintRefresh();
    const session = { id: 1, refreshToken: presented, lastRefreshToken: null, expiresAt: new Date(Date.now() + 1_000_000) };
    const where = vi.fn().mockResolvedValue({ rowCount: 1 });
    const db = {
      query: { absSessions: { findFirst: vi.fn().mockResolvedValue(session) } },
      update: vi.fn(() => ({ set: () => ({ where }) })),
    } as unknown as Db;
    const service = new AbsSessionService(tokenService, db);

    const tokens = await service.rotate(presented);
    expect(tokens.refreshToken).not.toBe(presented); // rotated
    expect(tokenService.verifyRefreshToken(tokens.refreshToken)).toMatchObject({ userId: 7 });
    expect(where).toHaveBeenCalledTimes(1);
  });

  it('reissues without re-rotating when the previous token is presented inside the grace window', async () => {
    const previous = mintRefresh();
    const session = {
      id: 1,
      refreshToken: 'current-token',
      lastRefreshToken: previous,
      lastRefreshTokenExpiresAt: new Date(Date.now() + ABS_REFRESH_GRACE_MS),
      expiresAt: new Date(Date.now() + 1_000_000),
    };
    const update = vi.fn();
    const db = { query: { absSessions: { findFirst: vi.fn().mockResolvedValue(session) } }, update } as unknown as Db;
    const service = new AbsSessionService(tokenService, db);

    const tokens = await service.rotate(previous);
    expect(tokens.refreshToken).toBe('current-token'); // the now-current token, not a new one
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects the previous token once the grace window has elapsed', async () => {
    const previous = mintRefresh();
    const session = {
      id: 1,
      refreshToken: 'current-token',
      lastRefreshToken: previous,
      lastRefreshTokenExpiresAt: new Date(Date.now() - 1),
      expiresAt: new Date(Date.now() + 1_000_000),
    };
    const db = { query: { absSessions: { findFirst: vi.fn().mockResolvedValue(session) } } } as unknown as Db;
    const service = new AbsSessionService(tokenService, db);
    expect(await thrownStatus(() => service.rotate(previous))).toBe(401);
  });

  it('destroys an expired session and returns 401', async () => {
    const presented = mintRefresh();
    const session = { id: 1, refreshToken: presented, lastRefreshToken: null, expiresAt: new Date(Date.now() - 1) };
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const db = {
      query: { absSessions: { findFirst: vi.fn().mockResolvedValue(session) } },
      delete: vi.fn(() => ({ where: deleteWhere })),
    } as unknown as Db;
    const service = new AbsSessionService(tokenService, db);

    expect(await thrownStatus(() => service.rotate(presented))).toBe(401);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it('on a lost rotation race (0 rows updated) re-reads and returns the now-current refresh token', async () => {
    const presented = mintRefresh();
    const session = { id: 1, refreshToken: presented, lastRefreshToken: null, expiresAt: new Date(Date.now() + 1_000_000) };
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce({ ...session, refreshToken: 'winner-token' });
    const db = {
      query: { absSessions: { findFirst } },
      update: vi.fn(() => ({ set: () => ({ where: vi.fn().mockResolvedValue({ rowCount: 0 }) }) })),
    } as unknown as Db;
    const service = new AbsSessionService(tokenService, db);

    const tokens = await service.rotate(presented);
    expect(tokens.refreshToken).toBe('winner-token');
  });
});

describe('AbsSessionService#invalidate', () => {
  it('is a no-op when no token is supplied', async () => {
    const del = vi.fn();
    const service = new AbsSessionService(makeTokenService(), { delete: del } as unknown as Db);
    await service.invalidate(undefined);
    expect(del).not.toHaveBeenCalled();
  });

  it('deletes the session matching the presented token', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const db = { delete: vi.fn(() => ({ where })) } as unknown as Db;
    await new AbsSessionService(makeTokenService(), db).invalidate('ref');
    expect(where).toHaveBeenCalledTimes(1);
  });
});
