import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
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
      libraryItemId,
      episodeId: null,
      mediaItemId: encodeAbsId('book', bookId),
      mediaItemType: 'book',
      duration,
      currentTime,
      progress: isFinished ? 1 : progress,
      isFinished,
      hideFromContinueListening: false,
      lastUpdate: updatedMs,
      startedAt: updatedMs,
      finishedAt: isFinished ? updatedMs : null,
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

    await this.db
      .insert(schema.audiobookProgress)
      .values({ userId, bookId, percentage, currentFileId: placement.fileId, positionSeconds: placement.positionSeconds })
      .onConflictDoUpdate({
        target: [schema.audiobookProgress.userId, schema.audiobookProgress.bookId],
        set: { percentage, currentFileId: placement.fileId, positionSeconds: placement.positionSeconds, updatedAt: new Date() },
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
