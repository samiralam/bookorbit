import { Permission } from '@bookorbit/types';

import type { RequestUser } from '../../../common/types/request-user';

/** A RequestUser with the fields the ABS adapter reads; superuser by default. */
export function makeAbsUser(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 1,
    username: 'admin',
    name: 'admin',
    email: null,
    active: true,
    isSuperuser: true,
    isDefaultPassword: false,
    tokenVersion: 0,
    settings: {},
    avatarUrl: null,
    provisioningMethod: 'local',
    permissions: [],
    contentFilters: { rules: [] } as unknown as RequestUser['contentFilters'],
    ...overrides,
  };
}

export const ALL_LIBRARY_PERMISSIONS: Permission[] = [
  Permission.LibraryDownload,
  Permission.LibraryUpload,
  Permission.LibraryEditMetadata,
  Permission.LibraryDeleteBooks,
];

/**
 * Resolve the status thrown by an ABS handler (AbsHttpException). Returns the numeric HTTP status,
 * or the literal `'no-throw'` when the function unexpectedly returns. Works for sync and async fns.
 */
export async function thrownStatus(fn: () => unknown | Promise<unknown>): Promise<number | 'no-throw'> {
  try {
    await fn();
    return 'no-throw';
  } catch (err) {
    const e = err as { getStatus?: () => number };
    return typeof e.getStatus === 'function' ? e.getStatus() : -1;
  }
}

interface CapturedReply {
  statusCode: number;
  headers: Record<string, unknown>;
  body: unknown;
  contentType?: string;
}

/** Minimal chainable Fastify reply mock that records status/headers/body for assertions. */
export function makeReply(): { reply: any; captured: CapturedReply } {
  const captured: CapturedReply = { statusCode: 200, headers: {}, body: undefined };
  const reply: any = {
    status(code: number) {
      captured.statusCode = code;
      return reply;
    },
    header(key: string, value: unknown) {
      captured.headers[key] = value;
      return reply;
    },
    type(value: string) {
      captured.contentType = value;
      return reply;
    },
    send(body: unknown) {
      captured.body = body;
      return reply;
    },
  };
  return { reply, captured };
}

/** Minimal Fastify request mock carrying headers + query. */
export function makeRequest(opts: { headers?: Record<string, unknown>; query?: Record<string, unknown> } = {}): any {
  return { headers: opts.headers ?? {}, query: opts.query ?? {} };
}
