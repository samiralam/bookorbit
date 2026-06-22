import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { and, gt, lt, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../../db/db.module';
import * as schema from '../../../db/schema';

type Db = NodePgDatabase<typeof schema>;

@Injectable()
export class OidcStateService {
  private readonly ttlMs: number;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly configService: ConfigService,
  ) {
    this.ttlMs = this.configService.get<number>('oidcRuntime.stateTtlMs') ?? 5 * 60 * 1000;
  }

  /**
   * Create a single-use state row. `explicitState` lets a caller pin the value — needed for the ABS
   * mobile OIDC flow, which round-trips the client-supplied `state` so the native app can match it.
   */
  async generate(providerId: number, meta?: Record<string, unknown>, explicitState?: string): Promise<string> {
    const state = explicitState ?? randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ttlMs);
    const metaJson = meta ? JSON.stringify(meta) : null;

    await Promise.all([
      this.db.delete(schema.oidcStates).where(lt(schema.oidcStates.expiresAt, new Date())),
      // Upsert on the `state` primary key. A caller-pinned `explicitState` (the ABS mobile flow
      // round-trips the client's `state`) can be replayed within the TTL — iOS clients re-issue the
      // `/auth/openid` navigation with the same state — and a plain insert would throw a PK violation,
      // which the ABS filter surfaces as an empty-body 500 that iOS renders as a blank "openid" file.
      // Refreshing the row keeps the latest authorize attempt authoritative.
      this.db
        .insert(schema.oidcStates)
        .values({ state, providerId, expiresAt, meta: metaJson })
        .onConflictDoUpdate({ target: schema.oidcStates.state, set: { providerId, expiresAt, meta: metaJson } }),
    ]);

    return state;
  }

  /**
   * Read a live state row's meta WITHOUT consuming it (the row is still consumed later at callback).
   * Used by the ABS `/auth/openid/mobile-redirect` hop, which only needs to forward the code to the
   * app and must not invalidate the state the subsequent `/callback` exchange depends on.
   */
  async peek(state: string): Promise<{ valid: boolean; providerId?: number; meta?: Record<string, unknown> }> {
    const row = await this.db.query.oidcStates.findFirst({
      where: and(eq(schema.oidcStates.state, state), gt(schema.oidcStates.expiresAt, new Date())),
    });
    if (!row) return { valid: false };
    const meta = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : undefined;
    return { valid: true, providerId: row.providerId, meta };
  }

  async validateAndConsume(state: string): Promise<{ valid: boolean; providerId?: number; meta?: Record<string, unknown> }> {
    const deleted = await this.db
      .delete(schema.oidcStates)
      .where(and(eq(schema.oidcStates.state, state), gt(schema.oidcStates.expiresAt, new Date())))
      .returning();

    if (deleted.length === 0) return { valid: false };
    const row = deleted[0];
    const meta = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : undefined;
    return { valid: true, providerId: row.providerId, meta };
  }
}
