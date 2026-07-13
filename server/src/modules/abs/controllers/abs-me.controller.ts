import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Permission } from '@bookorbit/types';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { AuthService } from '../../auth/auth.service';
import { LibraryService } from '../../library/library.service';
import { AbsExceptionFilter } from '../abs-exception.filter';
import { AbsHttpException } from '../abs-errors';
import { ABS_ID_PREFIX, decodeAbsId, encodeAbsId } from '../abs-id.util';
import { AbsAuthGuard, extractAbsToken } from '../auth/abs-auth.guard';
import { toAbsUser } from '../mappers/abs-user.mapper';
import { AbsBookmarkService } from '../services/abs-bookmark.service';
import { AbsCatalogService } from '../services/abs-catalog.service';
import { AbsProgressService, type AbsProgressBody } from '../services/abs-progress.service';
import { AbsSessionHistoryService } from '../services/abs-session-history.service';

interface BookmarkBody {
  time?: number;
  title?: string;
}

interface ChangePasswordBody {
  password?: string;
  newPassword?: string;
}

/**
 * BookOrbit's native password policy (mirrors `auth/dto/change-password.dto.ts`): at least 8 chars
 * with an upper, a lower, and a digit. ABS upstream accepts any password, but we keep the platform
 * invariant so the ABS route isn't a weak-password side door.
 */
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_COMPLEXITY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/;

/** Current-user endpoint + progress upserts (REIMPLEMENTATION_GUIDE §3, §7.1). */
@Public()
@UseGuards(AbsAuthGuard)
@UseFilters(AbsExceptionFilter)
@SkipThrottle()
@Controller('api/me')
export class AbsMeController {
  constructor(
    private readonly progressService: AbsProgressService,
    private readonly libraryService: LibraryService,
    private readonly catalogService: AbsCatalogService,
    private readonly bookmarkService: AbsBookmarkService,
    private readonly authService: AuthService,
    private readonly sessionHistoryService: AbsSessionHistoryService,
  ) {}

  @Get()
  async me(@CurrentUser() user: RequestUser, @Req() req: FastifyRequest): Promise<Record<string, unknown>> {
    const [mediaProgress, bookmarks, accessibleIds] = await Promise.all([
      this.progressService.listMediaProgressForUser(user.id),
      this.bookmarkService.listForUser(user.id),
      this.libraryService.findAccessibleLibraryIds(user),
    ]);
    return toAbsUser(user, {
      mediaProgress,
      bookmarks,
      librariesAccessible: user.isSuperuser ? [] : accessibleIds.map((id) => encodeAbsId('library', id)),
      // Live ABS always sends a token string on /api/me; echo the caller's bearer so the legacy
      // `token` field is never null (a null fails non-optional String decodes in strict clients).
      legacyToken: extractAbsToken(req) ?? undefined,
    });
  }

  /** Continue-listening shelf. */
  @Get('items-in-progress')
  async itemsInProgress(@CurrentUser() user: RequestUser): Promise<Record<string, unknown>> {
    const libraryItems = await this.catalogService.itemsInProgress(user);
    return { libraryItems };
  }

  /** Paginated listening history from the persisted session log (REIMPLEMENTATION_GUIDE §7/§8). */
  @Get('listening-sessions')
  async listeningSessions(@CurrentUser() user: RequestUser, @Query() query: Record<string, string>): Promise<Record<string, unknown>> {
    return this.sessionHistoryService.listeningSessions(user, query ?? {});
  }

  /**
   * "Remove from Continue Listening" (ABS `MeController.removeItemFromContinueListening`). Marks the
   * progress row hidden and, like ABS, responds with the full `/api/me` user JSON. 404 when the id is
   * malformed, names another user, or there is no progress row. Declared before `progress/:id/:episodeId?`
   * so the static tail segment wins the route match.
   */
  @Get('progress/:id/remove-from-continue-listening')
  async removeFromContinueListening(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Req() req: FastifyRequest,
  ): Promise<Record<string, unknown>> {
    const bookId = this.resolveProgressBookId(user, id);
    if (bookId === null) throw AbsHttpException.notFound();
    const hidden = await this.progressService.hideFromContinueListening(user.id, bookId);
    if (!hidden) throw AbsHttpException.notFound();
    return this.me(user, req);
  }

  /** Read one MediaProgress; 404 when there is none. Episode segment is ignored (no podcasts). */
  @Get('progress/:id/:episodeId?')
  async getProgress(@CurrentUser() user: RequestUser, @Param('id') id: string): Promise<Record<string, unknown>> {
    const bookId = decodeAbsId('libraryItem', id);
    if (bookId === null) throw AbsHttpException.notFound();
    const progress = await this.progressService.getMediaProgressByBook(user.id, bookId);
    if (!progress) throw AbsHttpException.notFound();
    return progress;
  }

  /** Stateless upsert of one MediaProgress. */
  @Patch('progress/:libraryItemId/:episodeId?')
  @HttpCode(200)
  async updateProgress(
    @CurrentUser() user: RequestUser,
    @Param('libraryItemId') libraryItemId: string,
    @Body() body: AbsProgressBody,
  ): Promise<Record<string, unknown>> {
    const bookId = decodeAbsId('libraryItem', libraryItemId);
    if (bookId === null) throw AbsHttpException.notFound();
    const progress = await this.progressService.upsertFromBody(user.id, bookId, body ?? {});
    if (!progress) throw AbsHttpException.notFound();
    return progress;
  }

  /** Batch upsert; each entry carries its own `libraryItemId`. Best-effort, returns 200. */
  @Patch('progress/batch/update')
  @HttpCode(200)
  async batchUpdateProgress(@CurrentUser() user: RequestUser, @Body() body: Array<AbsProgressBody & { libraryItemId?: string }>): Promise<void> {
    if (!Array.isArray(body)) return;
    for (const entry of body) {
      const bookId = entry.libraryItemId ? decodeAbsId('libraryItem', entry.libraryItemId) : null;
      if (bookId === null) continue;
      await this.progressService.upsertFromBody(user.id, bookId, entry);
    }
  }

  /**
   * Delete a MediaProgress. ABS addresses it by the composite progress id (`usr_<u>-li_<b>`, as built
   * in `AbsProgressService#toMediaProgress`); we also accept a bare `li_<b>`. The user segment, when
   * present, must match the caller so one user can't clear another's progress. 404 when nothing exists.
   */
  @Delete('progress/:id')
  @HttpCode(200)
  async deleteProgress(@CurrentUser() user: RequestUser, @Param('id') id: string): Promise<void> {
    const bookId = this.resolveProgressBookId(user, id);
    if (bookId === null) throw AbsHttpException.notFound();
    const removed = await this.progressService.deleteProgress(user.id, bookId);
    if (!removed) throw AbsHttpException.notFound();
  }

  /**
   * Change the caller's password (ABS `MeController.updatePassword`). Body is `{ password, newPassword }`.
   * Delegates to BookOrbit's `AuthService.changePassword` for the single source of truth (hashing,
   * audit event, web-session revocation, OIDC/shared blocking), then maps failures onto ABS's wire
   * shapes: demo accounts → 403 bare, bad input / wrong current password → 400 text, success → 200.
   * The ABS access token survives the change (it carries no `tokenVersion`), so the client stays in.
   */
  @Patch('password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() user: RequestUser,
    @Body() body: ChangePasswordBody,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    if (user.permissions.includes(Permission.DemoRestricted)) throw AbsHttpException.forbidden();

    const { password, newPassword } = body ?? {};
    if (typeof password !== 'string' || typeof newPassword !== 'string') {
      throw AbsHttpException.text(400, 'Missing or invalid password or new password');
    }
    if (newPassword.length < PASSWORD_MIN_LENGTH || !PASSWORD_COMPLEXITY.test(newPassword)) {
      throw AbsHttpException.text(
        400,
        'Invalid new password - must be at least 8 characters with an uppercase letter, a lowercase letter, and a digit',
      );
    }

    try {
      await this.authService.changePassword(user.id, { currentPassword: password, newPassword }, reply, req.ip);
    } catch (err) {
      if (err instanceof UnauthorizedException) throw AbsHttpException.text(400, 'Invalid password');
      if (err instanceof BadRequestException) throw AbsHttpException.text(400, err.message);
      throw err;
    }
  }

  /** Per-item listening history; 404s on garbage/unknown ids (episode segment ignored — no podcasts). */
  @Get('item/listening-sessions/:libraryItemId/:episodeId?')
  async itemListeningSessions(
    @CurrentUser() user: RequestUser,
    @Param('libraryItemId') libraryItemId: string,
    @Query() query: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    return this.sessionHistoryService.itemListeningSessions(user, libraryItemId, query ?? {});
  }

  /** Aggregate listening stats over the persisted session log. */
  @Get('listening-stats')
  async listeningStats(@CurrentUser() user: RequestUser): Promise<Record<string, unknown>> {
    return this.sessionHistoryService.listeningStats(user);
  }

  /** Year-in-review stats. Bad years behave like empty years (ABS returns zeroed stats too). */
  @Get('stats/year/:year')
  async statsForYear(@CurrentUser() user: RequestUser, @Param('year') year: string): Promise<Record<string, unknown>> {
    const parsedYear = Number.parseInt(year, 10);
    return this.sessionHistoryService.statsForYear(user, Number.isFinite(parsedYear) ? parsedYear : 0);
  }

  /** Create (or rename in place) an audio bookmark at `{ time, title }`. */
  @Post('item/:id/bookmark')
  async createBookmark(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() body: BookmarkBody): Promise<Record<string, unknown>> {
    const bookId = decodeAbsId('libraryItem', id);
    if (bookId === null || typeof body?.time !== 'number') throw AbsHttpException.notFound();
    return this.bookmarkService.create(user.id, bookId, body.time, body.title ?? '');
  }

  /** Rename the bookmark at `{ time }`. */
  @Patch('item/:id/bookmark')
  async updateBookmark(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() body: BookmarkBody): Promise<Record<string, unknown>> {
    const bookId = decodeAbsId('libraryItem', id);
    if (bookId === null || typeof body?.time !== 'number') throw AbsHttpException.notFound();
    const updated = await this.bookmarkService.update(user.id, bookId, body.time, body.title ?? '');
    if (!updated) throw AbsHttpException.notFound();
    return updated;
  }

  /** Remove the bookmark at `:time`. */
  @Delete('item/:id/bookmark/:time')
  @HttpCode(200)
  async deleteBookmark(@CurrentUser() user: RequestUser, @Param('id') id: string, @Param('time') time: string): Promise<void> {
    const bookId = decodeAbsId('libraryItem', id);
    const seconds = Number.parseFloat(time);
    if (bookId === null || !Number.isFinite(seconds)) throw AbsHttpException.notFound();
    const removed = await this.bookmarkService.remove(user.id, bookId, seconds);
    if (!removed) throw AbsHttpException.notFound();
  }

  /**
   * Resolve the book id targeted by a delete-progress request. Accepts the composite progress id
   * `usr_<u>-li_<b>` or a bare `li_<b>`. Returns null (→ 404) on malformed input or when the user
   * segment names someone other than the caller.
   */
  private resolveProgressBookId(user: RequestUser, rawId: string): number | null {
    const segments = rawId.split('-');
    const userSegment = segments.find((seg) => seg.startsWith(`${ABS_ID_PREFIX.user}_`));
    if (userSegment !== undefined && decodeAbsId('user', userSegment) !== user.id) return null;
    const itemSegment = segments.find((seg) => seg.startsWith(`${ABS_ID_PREFIX.libraryItem}_`)) ?? rawId;
    return decodeAbsId('libraryItem', itemSegment);
  }
}
