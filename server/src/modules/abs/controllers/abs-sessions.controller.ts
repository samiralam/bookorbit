import { Body, Controller, Get, HttpCode, Param, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { AbsExceptionFilter } from '../abs-exception.filter';
import { AbsHttpException } from '../abs-errors';
import { AbsAuthGuard } from '../auth/abs-auth.guard';
import { AbsPlaybackService, type LocalSessionBody, type SyncBody } from '../services/abs-playback.service';

/** Open playback-session sync/close lifecycle + offline reconciliation (REIMPLEMENTATION_GUIDE §7). */
@Public()
@UseGuards(AbsAuthGuard)
@UseFilters(AbsExceptionFilter)
@SkipThrottle()
@Controller('api/session')
export class AbsSessionsController {
  constructor(private readonly playbackService: AbsPlaybackService) {}

  /**
   * Sync one offline-recorded session (newest-updatedAt-wins). ABS responds with a bare
   * `sendStatus(200)` ("OK") on success and a 500 text on failure — no result JSON here.
   */
  @Post('local')
  @HttpCode(200)
  async syncLocal(@CurrentUser() user: RequestUser, @Body() body: LocalSessionBody, @Req() req: FastifyRequest): Promise<string> {
    const result = await this.playbackService.syncLocalSession(user, body ?? {}, { ipAddress: req.ip });
    if (result.success !== true) {
      throw AbsHttpException.text(500, typeof result.error === 'string' ? result.error : 'Failed to sync local session');
    }
    return 'OK';
  }

  /** Sync many offline-recorded sessions ⇒ `{ results: [...] }`. */
  @Post('local-all')
  @HttpCode(200)
  async syncLocalAll(
    @CurrentUser() user: RequestUser,
    @Body() body: { sessions?: LocalSessionBody[]; deviceInfo?: Record<string, unknown> },
    @Req() req: FastifyRequest,
  ): Promise<Record<string, unknown>> {
    return this.playbackService.syncLocalSessions(user, body?.sessions ?? [], { deviceInfo: body?.deviceInfo, ipAddress: req.ip });
  }

  @Get(':id')
  getSession(@CurrentUser() user: RequestUser, @Param('id') id: string): Record<string, unknown> {
    return this.playbackService.getSession(id, user);
  }

  @Post(':id/sync')
  @HttpCode(200)
  async sync(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() body: SyncBody): Promise<void> {
    await this.playbackService.sync(id, user, body ?? {});
  }

  @Post(':id/close')
  @HttpCode(200)
  async close(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() body: SyncBody): Promise<void> {
    await this.playbackService.close(id, user, body);
  }
}
