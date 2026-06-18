import { Body, Controller, Get, HttpCode, Inject, Post, UseFilters } from '@nestjs/common';
import { hash } from 'bcryptjs';
import { count, eq, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { Public } from '../../../common/decorators/public.decorator';
import { DB } from '../../../db';
import * as schema from '../../../db/schema';
import { ABS_APP_NAME, ABS_DEFAULT_LANGUAGE, ABS_SERVER_VERSION } from '../abs.constants';
import { AbsExceptionFilter } from '../abs-exception.filter';
import { AbsHttpException } from '../abs-errors';

interface AbsInitBody {
  newRoot?: { username?: string; password?: string };
  username?: string;
  password?: string;
}

/**
 * Unauthenticated discovery handshake (REIMPLEMENTATION_GUIDE §1.3). These routes live at the
 * router root, NOT under `/api`, and are excluded from the global `api/v1` prefix in main.ts.
 */
@Public()
@UseFilters(AbsExceptionFilter)
@Controller()
export class AbsDiscoveryController {
  constructor(@Inject(DB) private readonly db: NodePgDatabase<typeof schema>) {}

  @Get('ping')
  ping(): { success: true } {
    return { success: true };
  }

  @Get('healthcheck')
  @HttpCode(200)
  healthcheck(): void {
    // 200 empty — for load balancers.
  }

  @Get('status')
  async status(): Promise<Record<string, unknown>> {
    const isInit = (await this.db.$count(schema.users)) > 0;
    return {
      app: ABS_APP_NAME,
      serverVersion: ABS_SERVER_VERSION,
      isInit,
      language: ABS_DEFAULT_LANGUAGE,
      authMethods: ['local'],
      authFormData: {},
    };
  }

  /**
   * First-run: create the initial root user. Only valid when no users exist (returns 500 otherwise,
   * matching ABS). Existing BookOrbit deployments already have users, so this is effectively a
   * brand-new-instance path.
   */
  @Post('init')
  @HttpCode(200)
  async init(@Body() body: AbsInitBody): Promise<{ success: true }> {
    const username = body.newRoot?.username ?? body.username;
    const password = body.newRoot?.password ?? body.password;
    if (!username || !password) throw AbsHttpException.text(400, 'Missing username or password');

    await this.db.transaction(async (tx) => {
      const [{ total }] = await tx.select({ total: count() }).from(schema.users);
      if (Number(total) > 0) throw AbsHttpException.bare(500);

      const existing = await tx.query.users.findFirst({ where: eq(sql`lower(${schema.users.username})`, username.toLowerCase()) });
      if (existing) throw AbsHttpException.bare(500);

      const passwordHash = await hash(password, 12);
      await tx.insert(schema.users).values({ username, name: username, passwordHash, isSuperuser: true, isDefaultPassword: false });
    });

    return { success: true };
  }
}
