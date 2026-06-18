import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { UserService } from '../../user/user.service';
import { AbsTokenService } from './abs-token.service';

/**
 * Authenticates ABS API requests. The JWT arrives either as `Authorization: Bearer <jwt>` or as a
 * `?token=<jwt>` query parameter — the latter is how `<img>`/`<audio>` tags authenticate cover and
 * track requests (REIMPLEMENTATION_GUIDE §2.1).
 *
 * Populates `request.user` with the standard RequestUser so handlers can use `@CurrentUser()`.
 * ABS controllers are marked `@Public()` to bypass BookOrbit's native global guards, so this guard
 * is applied explicitly via `@UseGuards(AbsAuthGuard)`.
 */
@Injectable()
export class AbsAuthGuard implements CanActivate {
  constructor(
    private readonly tokenService: AbsTokenService,
    private readonly userService: UserService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest & { user?: unknown }>();
    const token = extractAbsToken(request);
    if (!token) throw new UnauthorizedException();

    const payload = this.tokenService.verifyAccessToken(token);
    if (!payload) throw new UnauthorizedException();

    const user = await this.userService.findByIdWithPermissions(payload.userId);
    if (!user || !user.active) throw new UnauthorizedException();

    request.user = user;
    return true;
  }
}

/** Pull the ABS JWT from the Authorization header or the `?token=` query param. */
export function extractAbsToken(request: FastifyRequest): string | null {
  const header = request.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim() || null;
  }
  const queryToken = (request.query as Record<string, unknown> | undefined)?.token;
  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return queryToken;
  }
  return null;
}
