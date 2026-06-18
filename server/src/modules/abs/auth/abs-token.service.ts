import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';

/**
 * ABS access tokens live ~1h and refresh tokens ~30d (REIMPLEMENTATION_GUIDE §2.1). These are
 * fixed by the wire contract and intentionally independent of BookOrbit's own JWT lifetimes.
 */
export const ABS_ACCESS_TOKEN_EXPIRY_SECONDS = 60 * 60; // 1h
export const ABS_REFRESH_TOKEN_EXPIRY_SECONDS = 60 * 60 * 24 * 30; // 30d

export type AbsTokenType = 'access' | 'refresh';

export interface AbsTokenPayload {
  userId: number;
  username: string;
  jti: string;
  type: AbsTokenType;
  iat?: number;
  exp?: number;
}

/**
 * Mints and verifies the `{ userId, username, jti, type, exp }` HS256 JWTs that ABS clients carry.
 * Signed with BookOrbit's `JWT_SECRET` so a single secret governs the deployment.
 */
@Injectable()
export class AbsTokenService {
  private readonly secret: string;

  constructor(
    private readonly jwtService: JwtService,
    config: ConfigService,
  ) {
    this.secret = config.get<string>('auth.jwtSecret') ?? 'change-me-in-production';
  }

  signAccessToken(userId: number, username: string): string {
    return this.sign(userId, username, 'access', ABS_ACCESS_TOKEN_EXPIRY_SECONDS);
  }

  /** Returns the refresh JWT and the absolute expiry used to stamp the session row. */
  signRefreshToken(userId: number, username: string): { token: string; expiresAt: Date } {
    const token = this.sign(userId, username, 'refresh', ABS_REFRESH_TOKEN_EXPIRY_SECONDS);
    const expiresAt = new Date(Date.now() + ABS_REFRESH_TOKEN_EXPIRY_SECONDS * 1000);
    return { token, expiresAt };
  }

  /** Verify signature + expiry; returns null on any failure so callers map to the right status. */
  verifyAccessToken(token: string): AbsTokenPayload | null {
    const payload = this.verify(token);
    return payload && payload.type === 'access' ? payload : null;
  }

  verifyRefreshToken(token: string): AbsTokenPayload | null {
    const payload = this.verify(token);
    return payload && payload.type === 'refresh' ? payload : null;
  }

  private sign(userId: number, username: string, type: AbsTokenType, expiresInSeconds: number): string {
    return this.jwtService.sign(
      { userId, username, type },
      { secret: this.secret, algorithm: 'HS256', expiresIn: expiresInSeconds, jwtid: randomUUID() },
    );
  }

  private verify(token: string): AbsTokenPayload | null {
    try {
      return this.jwtService.verify<AbsTokenPayload>(token, { secret: this.secret, algorithms: ['HS256'] });
    } catch {
      return null;
    }
  }
}
