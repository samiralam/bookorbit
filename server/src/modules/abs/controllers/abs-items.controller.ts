import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream } from 'fs';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { bookCoverDirPath, findPreferredBookCoverFileName } from '../../../common/book-cover-storage';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { imageContentTypeFromPath } from '../../../common/image-content-type';
import type { RequestUser } from '../../../common/types/request-user';
import { AbsExceptionFilter } from '../abs-exception.filter';
import { AbsHttpException } from '../abs-errors';
import { decodeAbsId } from '../abs-id.util';
import { AbsAuthGuard } from '../auth/abs-auth.guard';
import { AbsCatalogService } from '../services/abs-catalog.service';
import { AbsPlaybackService, type StartSessionBody } from '../services/abs-playback.service';

interface BatchGetBody {
  libraryItemIds?: string[];
}

/** Item detail + cover (REIMPLEMENTATION_GUIDE §5). Cover is unauthenticated (in the ignore list). */
@Public()
@UseFilters(AbsExceptionFilter)
@Controller('api/items')
export class AbsItemsController {
  private readonly appDataPath: string;

  constructor(
    private readonly catalogService: AbsCatalogService,
    private readonly playbackService: AbsPlaybackService,
    config: ConfigService,
  ) {
    this.appDataPath = config.get<string>('storage.appDataPath')!;
  }

  /** Fetch many items by id (access-filtered). */
  @Post('batch/get')
  @HttpCode(200)
  @UseGuards(AbsAuthGuard)
  async batchGet(@CurrentUser() user: RequestUser, @Body() body: BatchGetBody): Promise<Record<string, unknown>> {
    const bookIds = (body?.libraryItemIds ?? []).map((id) => decodeAbsId('libraryItem', id)).filter((id): id is number => id !== null);
    const libraryItems = await this.catalogService.getLibraryItemsBatch(user, bookIds);
    return { libraryItems };
  }

  @Get(':id')
  @UseGuards(AbsAuthGuard)
  async getItem(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query() query: Record<string, string>): Promise<Record<string, unknown>> {
    const bookId = decodeAbsId('libraryItem', id);
    if (bookId === null) throw AbsHttpException.notFound();
    return this.catalogService.getLibraryItem(user, bookId, query.minified === '1');
  }

  /** Start a playback session (direct-play, book). Podcast `/play/:episodeId` is out of scope. */
  @Post(':id/play')
  @HttpCode(200)
  @UseGuards(AbsAuthGuard)
  async play(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() body: StartSessionBody): Promise<Record<string, unknown>> {
    const bookId = decodeAbsId('libraryItem', id);
    if (bookId === null) throw AbsHttpException.notFound();
    return this.playbackService.startSession(user, bookId, body ?? {});
  }

  /** Unauthenticated cover image (token optional). Serves the stored cover with ETag caching. */
  @Get(':id/cover')
  async cover(@Param('id') id: string, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const bookId = decodeAbsId('libraryItem', id);
    if (bookId === null) throw AbsHttpException.notFound();

    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    const dir = bookCoverDirPath(this.appDataPath, bookId);
    try {
      const files = await readdir(dir);
      const cover = findPreferredBookCoverFileName(files);
      if (!cover) throw AbsHttpException.notFound();
      const coverPath = join(dir, cover);
      const { mtimeMs } = await stat(coverPath);
      const etag = `"${Math.floor(mtimeMs)}"`;
      if (req.headers['if-none-match'] === etag) {
        reply.status(304).send();
        return;
      }
      reply.header('Cache-Control', 'no-cache');
      reply.header('ETag', etag);
      reply.type(imageContentTypeFromPath(coverPath));
      reply.send(createReadStream(coverPath));
    } catch (err) {
      if (err instanceof AbsHttpException) throw err;
      throw AbsHttpException.notFound();
    }
  }
}
