import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../../db';
import * as schema from '../../../db/schema';
import { encodeAbsId } from '../abs-id.util';

/** An ABS AudioBookmark: `{ libraryItemId, title, time, createdAt }` (epoch ms). */
function toAbsBookmark(row: schema.BookmarkRow): Record<string, unknown> {
  return {
    libraryItemId: encodeAbsId('libraryItem', row.bookId),
    title: row.title,
    time: row.positionSeconds ?? 0,
    createdAt: row.createdAt.getTime(),
  };
}

/**
 * Audio bookmarks (REIMPLEMENTATION_GUIDE §3 / ENDPOINTS §3). Backed by BookOrbit's `bookmarks`
 * table; audio bookmarks carry an absolute `positionSeconds` (the ABS `time`) and a null `cfi`.
 * Identity for update/delete is the (user, book, time) triple, matching ABS's delete-by-time route.
 */
@Injectable()
export class AbsBookmarkService {
  constructor(@Inject(DB) private readonly db: NodePgDatabase<typeof schema>) {}

  /** All of a user's audio bookmarks, for the `GET /api/me` user object. */
  async listForUser(userId: number): Promise<Record<string, unknown>[]> {
    const rows = await this.db
      .select()
      .from(schema.bookmarks)
      .where(and(eq(schema.bookmarks.userId, userId), isNull(schema.bookmarks.cfi)))
      .orderBy(asc(schema.bookmarks.bookId), asc(schema.bookmarks.positionSeconds));
    return rows.map(toAbsBookmark);
  }

  /** Create (or rename in place) a bookmark at `time`; returns the resulting ABS bookmark. */
  async create(userId: number, bookId: number, time: number, title: string): Promise<Record<string, unknown>> {
    const existing = await this.findAt(userId, bookId, time);
    if (existing) {
      const [updated] = await this.db.update(schema.bookmarks).set({ title }).where(eq(schema.bookmarks.id, existing.id)).returning();
      return toAbsBookmark(updated);
    }
    const [row] = await this.db.insert(schema.bookmarks).values({ userId, bookId, title, positionSeconds: time, cfi: null }).returning();
    return toAbsBookmark(row);
  }

  /** Rename the bookmark at `time`; returns null when none exists. */
  async update(userId: number, bookId: number, time: number, title: string): Promise<Record<string, unknown> | null> {
    const existing = await this.findAt(userId, bookId, time);
    if (!existing) return null;
    const [updated] = await this.db.update(schema.bookmarks).set({ title }).where(eq(schema.bookmarks.id, existing.id)).returning();
    return toAbsBookmark(updated);
  }

  /** Delete the bookmark at `time`; returns true when one was removed. */
  async remove(userId: number, bookId: number, time: number): Promise<boolean> {
    const existing = await this.findAt(userId, bookId, time);
    if (!existing) return false;
    await this.db.delete(schema.bookmarks).where(eq(schema.bookmarks.id, existing.id));
    return true;
  }

  private async findAt(userId: number, bookId: number, time: number): Promise<schema.BookmarkRow | null> {
    const [row] = await this.db
      .select()
      .from(schema.bookmarks)
      .where(
        and(
          eq(schema.bookmarks.userId, userId),
          eq(schema.bookmarks.bookId, bookId),
          isNull(schema.bookmarks.cfi),
          eq(schema.bookmarks.positionSeconds, time),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}
