import { index, integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

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
