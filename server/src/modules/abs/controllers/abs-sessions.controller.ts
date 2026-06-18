import { Body, Controller, Get, HttpCode, Param, Post, UseFilters, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { AbsExceptionFilter } from '../abs-exception.filter';
import { AbsAuthGuard } from '../auth/abs-auth.guard';
import { AbsPlaybackService, type SyncBody } from '../services/abs-playback.service';

/** Open playback-session sync/close lifecycle (REIMPLEMENTATION_GUIDE §7.2). */
@Public()
@UseGuards(AbsAuthGuard)
@UseFilters(AbsExceptionFilter)
@Controller('api/session')
export class AbsSessionsController {
  constructor(private readonly playbackService: AbsPlaybackService) {}

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
