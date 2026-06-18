import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, or } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../../db';
import * as schema from '../../../db/schema';
import { AbsHttpException } from '../abs-errors';
import { AbsTokenService } from './abs-token.service';

/** ABS honors the previous refresh token for 1 minute after rotation (REIMPLEMENTATION_GUIDE §2.3). */
export const ABS_REFRESH_GRACE_MS = 60_000;

export interface AbsTokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AbsSessionContext {
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Server-side session store for the ABS refresh flow. Implements rotation with a 1-minute grace
 * window backed by `abs_sessions` rows, so aggressively- or concurrently-refreshing mobile clients
 * are not spuriously logged out. Mirrors ABS `TokenManager.rotateTokensForSession`.
 */
@Injectable()
export class AbsSessionService {
  private readonly logger = new Logger(AbsSessionService.name);

  constructor(
    private readonly tokenService: AbsTokenService,
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /** Mint a fresh access+refresh pair and persist a new session row (login). */
  async createSession(userId: number, username: string, ctx: AbsSessionContext): Promise<AbsTokenPair> {
    const accessToken = this.tokenService.signAccessToken(userId, username);
    const { token: refreshToken, expiresAt } = this.tokenService.signRefreshToken(userId, username);
    await this.db.insert(schema.absSessions).values({
      userId,
      refreshToken,
      expiresAt,
      ipAddress: ctx.ipAddress?.slice(0, 64),
      userAgent: ctx.userAgent?.slice(0, 512),
    });
    return { accessToken, refreshToken };
  }

  /**
   * Rotate tokens for the session matching `presentedToken`, honoring the grace window.
   * Throws `AbsHttpException` (401, `{ error }`) on any failure, matching the ABS auth-route shape.
   */
  async rotate(presentedToken: string): Promise<AbsTokenPair> {
    const payload = this.tokenService.verifyRefreshToken(presentedToken);
    if (!payload) throw AbsHttpException.json(401, { error: 'Invalid refresh token' });

    const session = await this.db.query.absSessions.findFirst({
      where: or(eq(schema.absSessions.refreshToken, presentedToken), eq(schema.absSessions.lastRefreshToken, presentedToken)),
    });
    if (!session) throw AbsHttpException.json(401, { error: 'Invalid refresh token' });

    // Case A: the previous token, still inside the grace window — reissue without re-rotating.
    if (session.lastRefreshToken === presentedToken && session.refreshToken !== presentedToken) {
      const graceOk = session.lastRefreshTokenExpiresAt && session.lastRefreshTokenExpiresAt.getTime() > Date.now();
      if (graceOk) {
        const accessToken = this.tokenService.signAccessToken(payload.userId, payload.username);
        return { accessToken, refreshToken: session.refreshToken };
      }
      throw AbsHttpException.json(401, { error: 'Invalid refresh token' });
    }

    // Case B: the current token. Enforce DB expiry, then rotate.
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.db.delete(schema.absSessions).where(eq(schema.absSessions.id, session.id));
      throw AbsHttpException.json(401, { error: 'Refresh token expired' });
    }

    const accessToken = this.tokenService.signAccessToken(payload.userId, payload.username);
    const { token: newRefreshToken, expiresAt } = this.tokenService.signRefreshToken(payload.userId, payload.username);

    // Optimistic concurrency: only rotate if the current token is still the one we read.
    const result = await this.db
      .update(schema.absSessions)
      .set({
        refreshToken: newRefreshToken,
        lastRefreshToken: presentedToken,
        lastRefreshTokenExpiresAt: new Date(Date.now() + ABS_REFRESH_GRACE_MS),
        expiresAt,
      })
      .where(and(eq(schema.absSessions.id, session.id), eq(schema.absSessions.refreshToken, presentedToken)));

    if ((result.rowCount ?? 0) === 0) {
      // Lost the race to a concurrent refresh; re-read and return the now-current refresh token
      // with a fresh access token instead of forcing a logout.
      const current = await this.db.query.absSessions.findFirst({ where: eq(schema.absSessions.id, session.id) });
      if (!current) throw AbsHttpException.json(401, { error: 'Invalid refresh token' });
      this.logger.log(`[abs.refresh] userId=${payload.userId} reason="rotation-race" - reissued from current session token`);
      return { accessToken, refreshToken: current.refreshToken };
    }

    return { accessToken, refreshToken: newRefreshToken };
  }

  /** Destroy the session matching the presented refresh token (logout). Best-effort. */
  async invalidate(presentedToken: string | undefined | null): Promise<void> {
    if (!presentedToken) return;
    await this.db
      .delete(schema.absSessions)
      .where(or(eq(schema.absSessions.refreshToken, presentedToken), eq(schema.absSessions.lastRefreshToken, presentedToken)));
  }
}
