import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../../db';
import * as schema from '../../../db/schema';
import { encodeAbsId } from '../abs-id.util';
import { AbsReadRepository, type AbsAudioFileRow } from '../abs-read.repository';

const DEFAULT_FINISH_PERCENT = 98;

export interface AbsProgressInput {
  /** Absolute position across the whole book, in seconds. */
  currentTime: number;
  /** Total book duration in seconds (falls back to summed file durations). */
  duration?: number;
  /** Explicit finished flag (e.g. "mark as finished" from the client). */
  isFinished?: boolean;
  /** Explicit hide-from-continue flag; when absent, an existing hide resets once the position moves. */
  hideFromContinueListening?: boolean;
}

/** Raw PATCH /me/progress body — `progress` (0..1) is accepted as an alternative to `currentTime`. */
export interface AbsProgressBody {
  currentTime?: number;
  duration?: number;
  progress?: number;
  isFinished?: boolean;
  hideFromContinueListening?: boolean;
}

/**
 * Bridges BookOrbit's per-file `audiobook_progress` (currentFileId + positionSeconds + percentage)
 * and ABS's per-item `MediaProgress` (absolute currentTime / duration / progress 0..1 / isFinished).
 * Auto-finish uses the owning library's `markAsFinishedPercentComplete` (REIMPLEMENTATION_GUIDE §3.2).
 */
@Injectable()
export class AbsProgressService {
  constructor(
    private readonly readRepo: AbsReadRepository,
    @Inject(DB) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /** Total duration from the ordered audio files (seconds). */
  static totalDuration(audioFiles: AbsAudioFileRow[]): number {
    return audioFiles.reduce((sum, f) => sum + (f.durationSeconds ?? 0), 0);
  }

  /** Absolute position = sum of durations before currentFile + positionSeconds. */
  static absoluteCurrentTime(audioFiles: AbsAudioFileRow[], currentFileId: number, positionSeconds: number): number {
    let preceding = 0;
    for (const file of audioFiles) {
      if (file.id === currentFileId) break;
      preceding += file.durationSeconds ?? 0;
    }
    return preceding + positionSeconds;
  }

  /** Inverse: map an absolute position back to a (file, offset-within-file). */
  static resolveFileAndOffset(audioFiles: AbsAudioFileRow[], currentTime: number): { fileId: number; positionSeconds: number } | null {
    if (audioFiles.length === 0) return null;
    let consumed = 0;
    for (const file of audioFiles) {
      const dur = file.durationSeconds ?? 0;
      if (currentTime < consumed + dur || dur === 0) {
        return { fileId: file.id, positionSeconds: Math.max(0, currentTime - consumed) };
      }
      consumed += dur;
    }
    // Past the end: pin to the last file's end.
    const last = audioFiles[audioFiles.length - 1];
    return { fileId: last.id, positionSeconds: last.durationSeconds ?? 0 };
  }

  private async finishPercentForLibrary(libraryId: number): Promise<number> {
    const [lib] = await this.db
      .select({ markAsFinishedPercentComplete: schema.libraries.markAsFinishedPercentComplete })
      .from(schema.libraries)
      .where(eq(schema.libraries.id, libraryId))
      .limit(1);
    return lib?.markAsFinishedPercentComplete ?? DEFAULT_FINISH_PERCENT;
  }

  /** Build the ABS MediaProgress object for one book, or null if there's no progress row. */
  async getMediaProgress(userId: number, bookId: number, libraryId: number): Promise<Record<string, unknown> | null> {
    const [row] = await this.db
      .select()
      .from(schema.audiobookProgress)
      .where(and(eq(schema.audiobookProgress.userId, userId), eq(schema.audiobookProgress.bookId, bookId)))
      .limit(1);
    if (!row) return null;

    const audioFiles = await this.readRepo.audioFilesByBookId(bookId);
    const finishPercent = await this.finishPercentForLibrary(libraryId);
    return this.toMediaProgress(bookId, row, audioFiles, finishPercent);
  }

  /** All of a user's audiobook progress, mapped to ABS MediaProgress (for /api/me and login). */
  async listMediaProgressForUser(userId: number): Promise<Record<string, unknown>[]> {
    const rows = await this.db.select().from(schema.audiobookProgress).where(eq(schema.audiobookProgress.userId, userId));
    if (rows.length === 0) return [];

    const bookIds = rows.map((r) => r.bookId);
    const [audioFiles, items] = await Promise.all([this.readRepo.audioFilesByBookIds(bookIds), this.readRepo.findItemsByIds(bookIds)]);
    const filesByBook = groupBy(audioFiles, (f) => f.bookId);
    const libraryByBook = new Map(items.map((i) => [i.id, i.libraryId]));

    const finishPercentByLibrary = new Map<number, number>();
    const result: Record<string, unknown>[] = [];
    for (const row of rows) {
      const libraryId = libraryByBook.get(row.bookId);
      if (libraryId === undefined) continue;
      if (!finishPercentByLibrary.has(libraryId)) finishPercentByLibrary.set(libraryId, await this.finishPercentForLibrary(libraryId));
      result.push(this.toMediaProgress(row.bookId, row, filesByBook.get(row.bookId) ?? [], finishPercentByLibrary.get(libraryId)!));
    }
    return result;
  }

  private toMediaProgress(
    bookId: number,
    row: schema.AudiobookProgress,
    audioFiles: AbsAudioFileRow[],
    finishPercent: number,
  ): Record<string, unknown> {
    const duration = AbsProgressService.totalDuration(audioFiles);
    const currentTime = AbsProgressService.absoluteCurrentTime(audioFiles, row.currentFileId, row.positionSeconds);
    const isFinished = row.percentage >= finishPercent;
    const progress = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
    const updatedMs = row.updatedAt.getTime();
    const libraryItemId = encodeAbsId('libraryItem', bookId);
    return {
      id: `${encodeAbsId('user', row.userId)}-${libraryItemId}`,
      // ABS MediaProgress always carries the owning user's id (verified against a live 2.35.1
      // /api/me capture); strict clients may require it.
      userId: encodeAbsId('user', row.userId),
      libraryItemId,
      episodeId: null,
      mediaItemId: encodeAbsId('book', bookId),
      mediaItemType: 'book',
      duration,
      currentTime,
      progress: isFinished ? 1 : progress,
      isFinished,
      hideFromContinueListening: row.hideFromContinueListening,
      // ABS always emits these; strict Codable clients (e.g. Prologue) decode the whole
      // MediaProgress object and drop the entire item list if a required key is absent. Live ABS
      // 2.35.1 sends ebookLocation null but ebookProgress 0 for audio (it coalesces null to 0 on
      // write), so a non-optional Double decode is satisfied only by the number.
      ebookLocation: null,
      ebookProgress: 0,
      lastUpdate: updatedMs,
      startedAt: updatedMs,
      finishedAt: isFinished ? updatedMs : null,
      // ABS MediaProgress carries non-nullable createdAt/updatedAt; omitting them fails Prologue's
      // strict decode of /api/me, which silently blanks the whole library. BookOrbit tracks only one
      // timestamp on the progress row, so both mirror it (as startedAt/lastUpdate already do).
      createdAt: updatedMs,
      updatedAt: updatedMs,
    };
  }

  /**
   * Upsert progress from an absolute position (open-session sync, /me/progress, offline merge).
   * Returns the resulting ABS MediaProgress, or null when the book has no audio files.
   */
  async upsertFromCurrentTime(userId: number, bookId: number, libraryId: number, input: AbsProgressInput): Promise<Record<string, unknown> | null> {
    const audioFiles = await this.readRepo.audioFilesByBookId(bookId);
    const placement = AbsProgressService.resolveFileAndOffset(audioFiles, input.currentTime);
    if (!placement) return null;

    const duration = input.duration && input.duration > 0 ? input.duration : AbsProgressService.totalDuration(audioFiles);
    const finishPercent = await this.finishPercentForLibrary(libraryId);
    let percentage = duration > 0 ? Math.min(100, Math.max(0, (input.currentTime / duration) * 100)) : 0;
    if (input.isFinished) percentage = 100;

    // ABS `MediaProgress.applyProgressUpdate`: an explicit flag in the payload wins; otherwise an
    // existing hide is cleared only when the position actually moved (so idle re-syncs of the same
    // position don't resurface a hidden item on the Continue shelf).
    const hideFromContinueListening =
      input.hideFromContinueListening ??
      sql<boolean>`case
        when ${schema.audiobookProgress.currentFileId} <> ${placement.fileId}
          or ${schema.audiobookProgress.positionSeconds} <> ${placement.positionSeconds}
        then false
        else ${schema.audiobookProgress.hideFromContinueListening}
      end`;

    await this.db
      .insert(schema.audiobookProgress)
      .values({
        userId,
        bookId,
        percentage,
        currentFileId: placement.fileId,
        positionSeconds: placement.positionSeconds,
        hideFromContinueListening: input.hideFromContinueListening ?? false,
      })
      .onConflictDoUpdate({
        target: [schema.audiobookProgress.userId, schema.audiobookProgress.bookId],
        set: {
          percentage,
          currentFileId: placement.fileId,
          positionSeconds: placement.positionSeconds,
          hideFromContinueListening,
          updatedAt: new Date(),
        },
      });

    const [row] = await this.db
      .select()
      .from(schema.audiobookProgress)
      .where(and(eq(schema.audiobookProgress.userId, userId), eq(schema.audiobookProgress.bookId, bookId)))
      .limit(1);
    return row ? this.toMediaProgress(bookId, row, audioFiles, finishPercent) : null;
  }

  /** Current persisted updatedAt for a (user, book), for the offline newest-wins merge. */
  async getProgressUpdatedAt(userId: number, bookId: number): Promise<Date | null> {
    const [row] = await this.db
      .select({ updatedAt: schema.audiobookProgress.updatedAt })
      .from(schema.audiobookProgress)
      .where(and(eq(schema.audiobookProgress.userId, userId), eq(schema.audiobookProgress.bookId, bookId)))
      .limit(1);
    return row?.updatedAt ?? null;
  }

  /**
   * Book ids the user has started but not completed, most-recently-updated first (Continue shelf).
   * `excludeHidden` mirrors ABS, which respects `hideFromContinueListening` only on the home-page
   * shelves (`/personalized`), not on `/me/items-in-progress`.
   */
  async listInProgressBookIds(userId: number, opts: { excludeHidden?: boolean } = {}): Promise<number[]> {
    const rows = await this.db
      .select({ bookId: schema.audiobookProgress.bookId })
      .from(schema.audiobookProgress)
      .where(
        and(
          eq(schema.audiobookProgress.userId, userId),
          gt(schema.audiobookProgress.percentage, 0),
          lt(schema.audiobookProgress.percentage, 100),
          opts.excludeHidden ? eq(schema.audiobookProgress.hideFromContinueListening, false) : undefined,
        ),
      )
      .orderBy(desc(schema.audiobookProgress.updatedAt));
    return rows.map((r) => r.bookId);
  }

  /**
   * "Remove from Continue Listening": mark the progress row hidden (ABS
   * `MeController.removeItemFromContinueListening`). Returns false when there is no row (→ 404).
   */
  async hideFromContinueListening(userId: number, bookId: number): Promise<boolean> {
    const updated = await this.db
      .update(schema.audiobookProgress)
      .set({ hideFromContinueListening: true })
      .where(and(eq(schema.audiobookProgress.userId, userId), eq(schema.audiobookProgress.bookId, bookId)))
      .returning({ bookId: schema.audiobookProgress.bookId });
    return updated.length > 0;
  }

  /** Delete a user's progress for one book. Returns false when there was no row to remove (→ 404). */
  async deleteProgress(userId: number, bookId: number): Promise<boolean> {
    const deleted = await this.db
      .delete(schema.audiobookProgress)
      .where(and(eq(schema.audiobookProgress.userId, userId), eq(schema.audiobookProgress.bookId, bookId)))
      .returning({ bookId: schema.audiobookProgress.bookId });
    return deleted.length > 0;
  }

  /** Build ABS MediaProgress for a book, resolving the owning library automatically. */
  async getMediaProgressByBook(userId: number, bookId: number): Promise<Record<string, unknown> | null> {
    const libraryId = await this.readRepo.libraryIdForBook(bookId);
    if (libraryId === null) return null;
    return this.getMediaProgress(userId, bookId, libraryId);
  }

  /**
   * Stateless upsert from a raw PATCH /me/progress body. Resolves `currentTime` from `progress`
   * (0..1) when only the latter is supplied, and looks up the owning library for the finish rule.
   */
  async upsertFromBody(userId: number, bookId: number, body: AbsProgressBody): Promise<Record<string, unknown> | null> {
    const libraryId = await this.readRepo.libraryIdForBook(bookId);
    if (libraryId === null) return null;

    let currentTime = body.currentTime;
    if (currentTime === undefined && typeof body.progress === 'number') {
      const duration =
        body.duration && body.duration > 0 ? body.duration : AbsProgressService.totalDuration(await this.readRepo.audioFilesByBookId(bookId));
      currentTime = Math.max(0, Math.min(1, body.progress)) * duration;
    }
    if (currentTime === undefined && !body.isFinished) return null;

    return this.upsertFromCurrentTime(userId, bookId, libraryId, {
      currentTime: currentTime ?? 0,
      duration: body.duration,
      isFinished: body.isFinished,
      hideFromContinueListening: body.hideFromContinueListening,
    });
  }

  /**
   * Offline reconciliation merge (REIMPLEMENTATION_GUIDE §7.3): newest `updatedAt` wins. Skips the
   * upsert when the stored progress is newer than the incoming offline session.
   */
  async mergeOfflineProgress(
    userId: number,
    bookId: number,
    input: AbsProgressInput & { updatedAt?: number },
  ): Promise<{ progressSynced: boolean; mediaProgress: Record<string, unknown> | null }> {
    const existing = await this.getProgressUpdatedAt(userId, bookId);
    if (existing && input.updatedAt && existing.getTime() > input.updatedAt) {
      return { progressSynced: false, mediaProgress: await this.getMediaProgressByBook(userId, bookId) };
    }
    const libraryId = await this.readRepo.libraryIdForBook(bookId);
    if (libraryId === null) return { progressSynced: false, mediaProgress: null };
    const mediaProgress = await this.upsertFromCurrentTime(userId, bookId, libraryId, input);
    return { progressSynced: mediaProgress != null, mediaProgress };
  }
}

function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}
