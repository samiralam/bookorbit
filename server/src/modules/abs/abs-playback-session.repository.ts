import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import type { AbsPlaybackSessionRow, NewAbsPlaybackSessionRow } from '../../db/schema';

/**
 * CRUD for the persisted listening-session log (`abs_playback_sessions`), mirroring ABS's
 * `playbackSessions` table. Reads deliberately load a user's full history and reduce in JS —
 * exactly what ABS does (`getUserListeningSessionsHelper`) — which guarantees behavioral parity
 * for pagination and the stats maps; per-user session counts stay small in BookOrbit deployments.
 */
@Injectable()
export class AbsPlaybackSessionRepository {
  constructor(@Inject(DB) private readonly db: NodePgDatabase<typeof schema>) {}

  async insert(row: NewAbsPlaybackSessionRow): Promise<void> {
    await this.db.insert(schema.absPlaybackSessions).values(row);
  }

  /** Periodic save of an open server session (ABS `saveSession` update path). */
  async updateSync(id: string, values: { currentTime: number; timeListening: number; updatedAt: Date }): Promise<void> {
    await this.db
      .update(schema.absPlaybackSessions)
      .set({
        currentTimeSeconds: values.currentTime,
        timeListening: values.timeListening,
        updatedAt: values.updatedAt,
      })
      .where(eq(schema.absPlaybackSessions.id, id));
  }

  /**
   * Upsert-update path for an offline session re-uploaded by a client: the client owns the row's
   * clock, so `updatedAt` and the recomputed date buckets come from the payload.
   */
  async updateFromLocal(
    id: string,
    values: { currentTime: number; timeListening: number; updatedAt: Date; date: string; dayOfWeek: string },
  ): Promise<void> {
    await this.db
      .update(schema.absPlaybackSessions)
      .set({
        currentTimeSeconds: values.currentTime,
        timeListening: values.timeListening,
        updatedAt: values.updatedAt,
        date: values.date,
        dayOfWeek: values.dayOfWeek,
      })
      .where(eq(schema.absPlaybackSessions.id, id));
  }

  async findById(id: string): Promise<AbsPlaybackSessionRow | null> {
    const rows = await this.db.select().from(schema.absPlaybackSessions).where(eq(schema.absPlaybackSessions.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /** A user's full history, newest sync first (the order every ABS history endpoint assumes). */
  async listForUser(userId: number, opts?: { bookId?: number }): Promise<AbsPlaybackSessionRow[]> {
    const where =
      opts?.bookId !== undefined
        ? and(eq(schema.absPlaybackSessions.userId, userId), eq(schema.absPlaybackSessions.bookId, opts.bookId))
        : eq(schema.absPlaybackSessions.userId, userId);
    return this.db.select().from(schema.absPlaybackSessions).where(where).orderBy(desc(schema.absPlaybackSessions.updatedAt));
  }

  /** Sessions created within a calendar year (year-in-review buckets by `createdAt`, like ABS). */
  async listForUserCreatedInYear(userId: number, year: number): Promise<AbsPlaybackSessionRow[]> {
    const start = new Date(year, 0, 1);
    const end = new Date(year + 1, 0, 1);
    return this.db
      .select()
      .from(schema.absPlaybackSessions)
      .where(
        and(
          eq(schema.absPlaybackSessions.userId, userId),
          gte(schema.absPlaybackSessions.createdAt, start),
          lt(schema.absPlaybackSessions.createdAt, end),
        ),
      )
      .orderBy(desc(schema.absPlaybackSessions.updatedAt));
  }
}
