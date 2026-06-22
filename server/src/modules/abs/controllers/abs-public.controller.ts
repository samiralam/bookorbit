import { Controller, Get, Param, Req, Res, UseFilters } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { Public } from '../../../common/decorators/public.decorator';
import { AbsExceptionFilter } from '../abs-exception.filter';
import { AbsHttpException } from '../abs-errors';
import { AbsPlaybackService } from '../services/abs-playback.service';
import { AbsStreamService } from '../services/abs-stream.service';

/**
 * Direct-track byte streaming for an open session (REIMPLEMENTATION_GUIDE §5.4). Authorized by the
 * opaque open-session id rather than a JWT, so this route is unauthenticated.
 */
@Public()
@UseFilters(AbsExceptionFilter)
@SkipThrottle()
@Controller('public/session')
export class AbsPublicController {
  constructor(
    private readonly playbackService: AbsPlaybackService,
    private readonly streamService: AbsStreamService,
  ) {}

  @Get(':id/track/:index')
  async track(@Param('id') id: string, @Param('index') index: string, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const trackIndex = Number.parseInt(index, 10);
    if (!Number.isInteger(trackIndex) || trackIndex < 0) throw AbsHttpException.notFound();

    const file = this.playbackService.trackFile(id, trackIndex);
    if (!file) throw AbsHttpException.notFound();

    await this.streamService.streamFile(req, reply, file.absolutePath, file.format);
  }
}
