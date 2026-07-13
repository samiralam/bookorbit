import { doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './auth';

/**
 * Server-side session rows backing the Audiobookshelf-compatible refresh-token flow.
 *
 * ABS clients refresh aggressively and sometimes concurrently, so a session keeps the
 * current `refreshToken` plus the previous one (`lastRefreshToken`) inside a short grace
 * window. A refresh that presents either token within the window succeeds without forcing
 * a re-rotation, which is what prevents spurious logouts (see REIMPLEMENTATION_GUIDE §2.3).
 *
 * Intentionally separate from `refresh_tokens` (BookOrbit's native auth), whose rotation
 * revokes immediately and treats reuse as theft — incompatible with the ABS wire contract.
 */
export const absSessions = pgTable(
  'abs_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The signed refresh JWT currently active for this session.
    refreshToken: text('refresh_token').notNull(),
    // The immediately-previous refresh JWT, honored only until lastRefreshTokenExpiresAt.
    lastRefreshToken: text('last_refresh_token'),
    lastRefreshTokenExpiresAt: timestamp('last_refresh_token_expires_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: varchar('ip_address', { length: 64 }),
    userAgent: varchar('user_agent', { length: 512 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('abs_sessions_user_id_idx').on(t.userId),
    index('abs_sessions_refresh_token_idx').on(t.refreshToken),
    index('abs_sessions_last_refresh_token_idx').on(t.lastRefreshToken),
  ],
);

export type AbsSession = typeof absSessions.$inferSelect;
export type NewAbsSession = typeof absSessions.$inferInsert;

/**
 * Persisted listening-session history backing the ABS `playbackSessions` table
 * (REIMPLEMENTATION_GUIDE §7): one row per playback session with `timeListening > 0`,
 * feeding `/api/me/listening-sessions`, `/me/listening-stats`, and `/me/stats/year/:year`.
 *
 * Rows are an immutable log: `book_id`/`library_id` are plain snapshots (no FK) so history
 * survives book/library deletion, exactly like ABS. Display fields and `media_metadata`
 * (ABS `oldMetadataToJSON` shape) are snapshotted at session start for the same reason.
 */
export const absPlaybackSessions = pgTable(
  'abs_playback_sessions',
  {
    // Server-generated for online sessions; client-supplied for offline (local) uploads.
    id: uuid('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    libraryId: integer('library_id'),
    bookId: integer('book_id').notNull(),
    displayTitle: text('display_title').notNull().default(''),
    displayAuthor: text('display_author').notNull().default(''),
    coverPath: text('cover_path'),
    mediaMetadata: jsonb('media_metadata').notNull().$type<Record<string, unknown>>(),
    chapters: jsonb('chapters').notNull().default([]).$type<Record<string, unknown>[]>(),
    duration: doublePrecision('duration').notNull().default(0),
    playMethod: integer('play_method').notNull(),
    mediaPlayer: varchar('media_player', { length: 64 }).notNull().default('unknown'),
    deviceInfo: jsonb('device_info').$type<Record<string, unknown>>(),
    serverVersion: varchar('server_version', { length: 32 }).notNull(),
    // Listening-stats bucket keys, stamped at write time like ABS (server-local calendar).
    date: varchar('date', { length: 10 }).notNull(),
    dayOfWeek: varchar('day_of_week', { length: 16 }).notNull(),
    timeListening: doublePrecision('time_listening').notNull().default(0),
    // `current_time` is reserved in Postgres; wire names stay startTime/currentTime.
    startTimeSeconds: doublePrecision('start_time_seconds').notNull().default(0),
    currentTimeSeconds: doublePrecision('current_time_seconds').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    // Year-in-review buckets by createdAt (ABS `userStats.js`), NOT startedAt.
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    // Local uploads set this explicitly from the client's value; $onUpdateFn covers server syncs.
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('abs_playback_sessions_user_updated_idx').on(t.userId, t.updatedAt.desc()),
    index('abs_playback_sessions_user_book_idx').on(t.userId, t.bookId),
    index('abs_playback_sessions_user_created_idx').on(t.userId, t.createdAt),
  ],
);

export type AbsPlaybackSessionRow = typeof absPlaybackSessions.$inferSelect;
export type NewAbsPlaybackSessionRow = typeof absPlaybackSessions.$inferInsert;
