import { Controller, HttpCode, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { LibraryService } from '../../library/library.service';
import { AbsExceptionFilter } from '../abs-exception.filter';
import { encodeAbsId } from '../abs-id.util';
import { AbsAuthGuard, extractAbsToken } from '../auth/abs-auth.guard';
import { toAbsLoginPayload } from '../mappers/abs-user.mapper';
import { AbsProgressService } from '../services/abs-progress.service';

/**
 * `POST /api/authorize` — re-derives the full login payload from a bearer token without
 * re-authenticating (ENDPOINTS.md §24). ABS clients (e.g. Prologue) call this right after connecting
 * to validate a stored token, so it must return the same body shape as `POST /login`. Unlike login it
 * mints no new session: it echoes the presented access token and returns no refresh token (the client
 * already holds those).
 */
@Public()
@UseGuards(AbsAuthGuard)
@UseFilters(AbsExceptionFilter)
@SkipThrottle()
@Controller('api/authorize')
export class AbsAuthorizeController {
  constructor(
    private readonly progressService: AbsProgressService,
    private readonly libraryService: LibraryService,
  ) {}

  @Post()
  @HttpCode(200)
  async authorize(@CurrentUser() user: RequestUser, @Req() req: FastifyRequest): Promise<Record<string, unknown>> {
    const [mediaProgress, accessibleIds] = await Promise.all([
      this.progressService.listMediaProgressForUser(user.id),
      this.libraryService.findAccessibleLibraryIds(user),
    ]);
    return toAbsLoginPayload(user, {
      accessToken: extractAbsToken(req) ?? '',
      refreshToken: null,
      mediaProgress,
      librariesAccessible: user.isSuperuser ? [] : accessibleIds.map((id) => encodeAbsId('library', id)),
      userDefaultLibraryId: accessibleIds.length ? encodeAbsId('library', accessibleIds[0]) : null,
    });
  }
}
