import { Controller, Get, Param, Res, UseFilters } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { createReadStream } from 'fs';
import type { FastifyReply } from 'fastify';

import { Public } from '../../../common/decorators/public.decorator';
import { AbsExceptionFilter } from '../abs-exception.filter';
import { AbsHttpException } from '../abs-errors';
import { HLS_PLAYLIST_FILE, isHlsFile } from '../abs-transcode.util';
import { AbsTranscodeService } from '../services/abs-transcode.service';

const PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
const SEGMENT_CONTENT_TYPE = 'video/mp2t';

/**
 * HLS playlist/segment streaming for transcode sessions (REIMPLEMENTATION_GUIDE §5.3). Like the
 * direct-track endpoint, authorization is by the opaque stream id baked into the URL, so the route is
 * unauthenticated. Seeking outside the transcoded window yields a `404` plus a `stream_reset` socket
 * event; the client restarts playback at the new offset.
 */
@Public()
@UseFilters(AbsExceptionFilter)
@SkipThrottle()
@Controller('hls')
export class AbsHlsController {
  constructor(private readonly transcodeService: AbsTranscodeService) {}

  @Get(':stream/:file')
  async streamFile(@Param('stream') streamId: string, @Param('file') file: string, @Res() reply: FastifyReply): Promise<void> {
    // Reject anything but our two filename shapes — this also blocks path traversal.
    if (!isHlsFile(file)) throw AbsHttpException.bare(400);

    if (file === HLS_PLAYLIST_FILE) {
      const playlist = this.transcodeService.playlist(streamId);
      if (playlist === null) throw AbsHttpException.notFound();
      reply.header('Content-Type', PLAYLIST_CONTENT_TYPE);
      reply.status(200).send(playlist);
      return;
    }

    const { action, filePath } = await this.transcodeService.resolveSegment(streamId, file);
    if (action !== 'serve' || !filePath) throw AbsHttpException.notFound();

    reply.header('Content-Type', SEGMENT_CONTENT_TYPE);
    reply.status(200).send(createReadStream(filePath));
  }
}
