import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { ZipArchive } from 'archiver';
import { createReadStream } from 'fs';
import { readdir, stat } from 'fs/promises';
import { basename, join } from 'path';
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
import { AbsStreamService } from '../services/abs-stream.service';

interface BatchGetBody {
  libraryItemIds?: string[];
}

/** Build an RFC 6266 `Content-Disposition: attachment` value with an ASCII fallback + UTF-8 form. */
function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]|["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Item detail + cover (REIMPLEMENTATION_GUIDE §5). Cover is unauthenticated (in the ignore list). */
@Public()
@UseFilters(AbsExceptionFilter)
@SkipThrottle()
@Controller('api/items')
export class AbsItemsController {
  private readonly appDataPath: string;

  constructor(
    private readonly catalogService: AbsCatalogService,
    private readonly playbackService: AbsPlaybackService,
    private readonly streamService: AbsStreamService,
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
    const includeProgress = (query.include ?? '').split(',').includes('progress');
    return this.catalogService.getLibraryItem(user, bookId, query.minified === '1', includeProgress);
  }

  /** Start a playback session (direct-play, book). Podcast `/play/:episodeId` is out of scope. */
  @Post(':id/play')
  @HttpCode(200)
  @UseGuards(AbsAuthGuard)
  async play(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: StartSessionBody,
    @Req() req: FastifyRequest,
  ): Promise<Record<string, unknown>> {
    const bookId = decodeAbsId('libraryItem', id);
    if (bookId === null) throw AbsHttpException.notFound();
    return this.playbackService.startSession(user, bookId, body ?? {}, req.ip);
  }

  /**
   * Stream a single item file inline (ENDPOINTS.md §2 — `jwt`). Same resolution as the download
   * variant but without forcing an attachment disposition, and gated only on library access (not
   * `canDownload`) since this is the in-app playback/preview path. Range-aware via the stream service.
   */
  @Get(':id/file/:fileid')
  @UseGuards(AbsAuthGuard)
  async streamFileInline(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('fileid') fileid: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const bookId = decodeAbsId('libraryItem', id);
    const fileId = Number.parseInt(fileid, 10);
    if (bookId === null || !Number.isInteger(fileId)) throw AbsHttpException.notFound();

    const file = await this.catalogService.getItemFile(user, bookId, fileId);
    await this.streamService.streamFile(req, reply, file.absolutePath, file.format);
  }

  /**
   * Download a single item file (ENDPOINTS.md §2 — `jwt+canDownload`). `fileid` is the audio file's
   * `ino`. Streamed with HTTP Range support so download managers can resume. Auth accepts `?token=`
   * since download managers cannot set an Authorization header (REIMPLEMENTATION_GUIDE §2.1).
   */
  @Get(':id/file/:fileid/download')
  @UseGuards(AbsAuthGuard)
  async downloadFile(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('fileid') fileid: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const bookId = decodeAbsId('libraryItem', id);
    const fileId = Number.parseInt(fileid, 10);
    if (bookId === null || !Number.isInteger(fileId)) throw AbsHttpException.notFound();

    const file = await this.catalogService.getDownloadFile(user, bookId, fileId);
    reply.header('Content-Disposition', attachmentDisposition(basename(file.absolutePath)));
    await this.streamService.streamFile(req, reply, file.absolutePath, file.format);
  }

  /** Download a whole item as a zip of its content files (ENDPOINTS.md §2 — `jwt+canDownload`). */
  @Get(':id/download')
  @UseGuards(AbsAuthGuard)
  async downloadItem(@CurrentUser() user: RequestUser, @Param('id') id: string, @Res() reply: FastifyReply): Promise<void> {
    const bookId = decodeAbsId('libraryItem', id);
    if (bookId === null) throw AbsHttpException.notFound();

    const { title, files } = await this.catalogService.getDownloadBundle(user, bookId);

    const archive = new ZipArchive({ zlib: { level: 0 } });
    let aborted = false;
    const abort = () => {
      aborted = true;
      archive.abort();
    };
    reply.raw.on('close', abort);
    reply.raw.on('aborted', abort);
    const failure = new Promise<never>((_, reject) => {
      archive.on('warning', reject);
      archive.on('error', reject);
    });

    reply.raw.setHeader('Content-Type', 'application/zip');
    reply.raw.setHeader('Content-Disposition', attachmentDisposition(`${title}.zip`));
    archive.pipe(reply.raw);

    const seen = new Map<string, number>();
    for (const file of files) {
      let name = basename(file.absolutePath);
      const count = seen.get(name) ?? 0;
      seen.set(name, count + 1);
      // Disambiguate duplicate basenames coming from different source folders.
      if (count > 0) name = `${count}-${name}`;
      archive.file(file.absolutePath, { name });
    }

    try {
      await Promise.race([archive.finalize(), failure]);
    } catch (err) {
      if (!aborted) throw err;
    }
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
