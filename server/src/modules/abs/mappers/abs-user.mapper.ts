import { Permission } from '@bookorbit/types';

import type { RequestUser } from '../../../common/types/request-user';
import { ABS_DEFAULT_LANGUAGE, ABS_SERVER_VERSION, ABS_SOURCE } from '../abs.constants';
import { encodeAbsId } from '../abs-id.util';

export interface AbsUserExtras {
  /** Pre-mapped ABS MediaProgress objects (empty until the progress service populates them). */
  mediaProgress?: Record<string, unknown>[];
  /** ABS library id strings the user can access; empty array means "all". */
  librariesAccessible?: string[];
  accessToken?: string;
  refreshToken?: string | null;
}

function has(user: RequestUser, permission: Permission): boolean {
  return user.isSuperuser || user.permissions.includes(permission);
}

/** ABS user `type`. BookOrbit superusers map to root; everyone else is a regular user. */
function absUserType(user: RequestUser): string {
  return user.isSuperuser ? 'root' : 'user';
}

function absPermissions(user: RequestUser): Record<string, boolean> {
  return {
    download: has(user, Permission.LibraryDownload),
    update: has(user, Permission.LibraryEditMetadata),
    delete: has(user, Permission.LibraryDeleteBooks),
    upload: has(user, Permission.LibraryUpload),
    accessAllLibraries: user.isSuperuser,
    accessAllTags: true,
    accessExplicitContent: true,
    createEreader: false,
  };
}

/**
 * The ABS user object embedded in the login payload and returned by `GET /api/me`.
 * `accessToken`/`refreshToken` are only attached on login/refresh (REIMPLEMENTATION_GUIDE §2.2).
 */
export function toAbsUser(user: RequestUser, extras: AbsUserExtras = {}): Record<string, unknown> {
  const accessAllLibraries = user.isSuperuser;
  return {
    id: encodeAbsId('user', user.id),
    username: user.username,
    type: absUserType(user),
    token: extras.accessToken ?? null, // legacy field; old clients read user.token
    accessToken: extras.accessToken,
    refreshToken: extras.refreshToken ?? null,
    mediaProgress: extras.mediaProgress ?? [],
    seriesHideFromContinueListening: [],
    bookmarks: [],
    isActive: user.active,
    isLocked: false,
    lastSeen: Date.now(),
    createdAt: Date.now(),
    permissions: absPermissions(user),
    librariesAccessible: accessAllLibraries ? [] : (extras.librariesAccessible ?? []),
    itemTagsAccessible: [],
  };
}

/** Minimal but structurally-correct ServerSettings for clients that read a handful of fields. */
export function buildAbsServerSettings(): Record<string, unknown> {
  return {
    id: 'server-settings',
    scannerFindCovers: false,
    scannerCoverProvider: 'google',
    scannerParseSubtitle: false,
    storeCoverWithItem: false,
    storeMetadataWithItem: false,
    metadataFileFormat: 'json',
    rateLimitLoginRequests: 10,
    rateLimitLoginWindow: 600000,
    backupSchedule: false,
    backupsToKeep: 2,
    maxBackupSize: 1,
    loggerDailyLogsToKeep: 7,
    loggerScannerLogsToKeep: 2,
    homeBookshelfView: 1,
    bookshelfView: 1,
    sortingIgnorePrefix: false,
    sortingPrefixes: ['the', 'a'],
    chromecastEnabled: false,
    dateFormat: 'MM/dd/yyyy',
    timeFormat: 'HH:mm',
    language: ABS_DEFAULT_LANGUAGE,
    logLevel: 2,
    version: ABS_SERVER_VERSION,
  };
}

export interface AbsLoginPayloadOptions {
  accessToken: string;
  refreshToken: string | null;
  mediaProgress?: Record<string, unknown>[];
  librariesAccessible?: string[];
  userDefaultLibraryId?: string | null;
}

/** The full body returned by `POST /login` and `POST /auth/refresh` (REIMPLEMENTATION_GUIDE §2.2). */
export function toAbsLoginPayload(user: RequestUser, opts: AbsLoginPayloadOptions): Record<string, unknown> {
  return {
    user: toAbsUser(user, {
      accessToken: opts.accessToken,
      refreshToken: opts.refreshToken,
      mediaProgress: opts.mediaProgress,
      librariesAccessible: opts.librariesAccessible,
    }),
    userDefaultLibraryId: opts.userDefaultLibraryId ?? null,
    serverSettings: buildAbsServerSettings(),
    ereaderDevices: [],
    Source: ABS_SOURCE,
  };
}
