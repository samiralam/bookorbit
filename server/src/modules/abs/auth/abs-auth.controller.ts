import { Body, Controller, HttpCode, Post, Req, UseFilters } from '@nestjs/common';
import { compare } from 'bcryptjs';
import type { FastifyRequest } from 'fastify';

import { Public } from '../../../common/decorators/public.decorator';
import { LibraryService } from '../../library/library.service';
import { UserService } from '../../user/user.service';
import { encodeAbsId } from '../abs-id.util';
import { AbsExceptionFilter } from '../abs-exception.filter';
import { AbsHttpException } from '../abs-errors';
import { ABS_INTERNAL_REFRESH_PATH } from '../abs-route-rewrite.util';
import { toAbsLoginPayload } from '../mappers/abs-user.mapper';
import { AbsProgressService } from '../services/abs-progress.service';
import { AbsSessionService } from './abs-session.service';
import { AbsTokenService } from './abs-token.service';

// Constant-time dummy compare target to avoid leaking whether a username exists.
const DUMMY_HASH = '$2a$12$LJ3m4ys3Lk0TSwHBbqP8b.3bFfR1oVDMhPzX8KPrPeuMEJBJJPa.G';

interface AbsLoginBody {
  username?: string;
  password?: string;
}

/**
 * ABS local auth at the router root (REIMPLEMENTATION_GUIDE §2.2–2.4). MVP targets the mobile
 * header flow: tokens are returned in the response body; the refresh token arrives on
 * `x-refresh-token`. (Web cookie flow is out of scope.)
 */
@Public()
@UseFilters(AbsExceptionFilter)
@Controller()
export class AbsAuthController {
  constructor(
    private readonly userService: UserService,
    private readonly sessionService: AbsSessionService,
    private readonly tokenService: AbsTokenService,
    private readonly libraryService: LibraryService,
    private readonly progressService: AbsProgressService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: AbsLoginBody, @Req() req: FastifyRequest): Promise<Record<string, unknown>> {
    if (!body.username || !body.password) throw AbsHttpException.unauthorized();

    const candidate = await this.userService.findByUsername(body.username);
    const now = new Date();
    const isLocked = !!candidate?.lockedUntil && candidate.lockedUntil > now;
    const passwordValid = await compare(body.password, candidate?.passwordHash ?? DUMMY_HASH);
    if (!candidate || !candidate.active || isLocked || !passwordValid) {
      throw AbsHttpException.unauthorized();
    }

    const user = await this.userService.findByIdWithPermissions(candidate.id);
    if (!user) throw AbsHttpException.unauthorized();

    const tokens = await this.sessionService.createSession(user.id, user.username, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // ABS embeds the user's full mediaProgress in every login-shaped payload (`Auth.js`
    // `getUserLoginResponsePayload` → `toOldJSONForBrowser`); clients like Plappa seed their
    // cross-device resume positions from it, so an empty array reads as "no progress anywhere".
    const [accessibleIds, mediaProgress] = await Promise.all([
      this.libraryService.findAccessibleLibraryIds(user),
      this.progressService.listMediaProgressForUser(user.id),
    ]);
    return toAbsLoginPayload(user, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      mediaProgress,
      librariesAccessible: user.isSuperuser ? [] : accessibleIds.map((id) => encodeAbsId('library', id)),
      userDefaultLibraryId: accessibleIds.length ? encodeAbsId('library', accessibleIds[0]) : null,
    });
  }

  // Served at the public path POST /auth/refresh; rewriteAbsUrl maps it to this internal path to
  // avoid colliding with BookOrbit's own `auth/refresh` route (see abs-route-rewrite.util.ts).
  @Post(ABS_INTERNAL_REFRESH_PATH)
  @HttpCode(200)
  async refresh(@Req() req: FastifyRequest): Promise<Record<string, unknown>> {
    const presented = req.headers['x-refresh-token'];
    const token = typeof presented === 'string' ? presented : undefined;
    if (!token) throw AbsHttpException.json(401, { error: 'No refresh token provided' });

    const tokens = await this.sessionService.rotate(token);
    const payload = this.tokenService.verifyRefreshToken(tokens.refreshToken);
    const userId = payload?.userId;
    const user = userId ? await this.userService.findByIdWithPermissions(userId) : null;
    if (!user) throw AbsHttpException.json(401, { error: 'Invalid refresh token' });

    const [accessibleIds, mediaProgress] = await Promise.all([
      this.libraryService.findAccessibleLibraryIds(user),
      this.progressService.listMediaProgressForUser(user.id),
    ]);
    return toAbsLoginPayload(user, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      mediaProgress,
      librariesAccessible: user.isSuperuser ? [] : accessibleIds.map((id) => encodeAbsId('library', id)),
      userDefaultLibraryId: accessibleIds.length ? encodeAbsId('library', accessibleIds[0]) : null,
    });
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: FastifyRequest): Promise<{ redirect_url: null }> {
    const presented = req.headers['x-refresh-token'];
    await this.sessionService.invalidate(typeof presented === 'string' ? presented : undefined);
    return { redirect_url: null };
  }
}
