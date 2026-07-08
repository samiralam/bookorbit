import { Permission } from '@bookorbit/types';

import type { RequestUser } from '../../../common/types/request-user';
import { ABS_DEFAULT_LANGUAGE, ABS_SERVER_VERSION, ABS_SOURCE } from '../abs.constants';
import { encodeAbsId } from '../abs-id.util';

export interface AbsUserExtras {
  /** Pre-mapped ABS MediaProgress objects (empty until the progress service populates them). */
  mediaProgress?: Record<string, unknown>[];
  /** Pre-mapped ABS AudioBookmark objects. */
  bookmarks?: Record<string, unknown>[];
  /** ABS library id strings the user can access; empty array means "all". */
  librariesAccessible?: string[];
  accessToken?: string;
  refreshToken?: string | null;
  /**
   * Value for the legacy `token` field when `accessToken` isn't attached (e.g. `GET /api/me`).
   * Live ABS 2.35.1 always sends a real token string here — a null fails clients that decode it
   * as a non-optional String.
   */
  legacyToken?: string;
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
    // ABS `tagsAreDenylist` — always present in live 2.35.1 payloads; BookOrbit has no tag ACLs.
    selectedTagsNotAccessible: false,
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
    email: user.email, // ABS sends this (nullable); strict clients (e.g. Prologue) require the key
    type: absUserType(user),
    token: extras.accessToken ?? extras.legacyToken ?? null, // legacy field; old clients read user.token
    // ABS sets this flag in jwtAuthCheck to flag pre-2.26 tokens; we never issue old tokens.
    isOldToken: false,
    accessToken: extras.accessToken,
    refreshToken: extras.refreshToken ?? null,
    mediaProgress: extras.mediaProgress ?? [],
    seriesHideFromContinueListening: [],
    bookmarks: extras.bookmarks ?? [],
    isActive: user.active,
    isLocked: false,
    lastSeen: Date.now(),
    createdAt: Date.now(),
    permissions: absPermissions(user),
    librariesAccessible: accessAllLibraries ? [] : (extras.librariesAccessible ?? []),
    // ABS calls this `itemTagsSelected` (not `itemTagsAccessible`); BookOrbit has no per-tag ACLs.
    itemTagsSelected: [],
    hasOpenIDLink: false, // BookOrbit has no OIDC linking; ABS always emits this boolean
  };
}

/**
 * Structurally-complete ServerSettings mirroring ABS `ServerSettings.toJSONForBrowser()`
 * (v2.35.1). The full field set matters: strict clients (e.g. Prologue) decode this object with a
 * non-optional model, so an omitted key — notably `authActiveAuthMethods` — fails the whole login
 * decode. We keep the secret-bearing OIDC fields ABS strips in `toJSONForBrowser` out, and report
 * only `local` auth since BookOrbit has no OIDC flow.
 */
export function buildAbsServerSettings(): Record<string, unknown> {
  return {
    id: 'server-settings',
    scannerFindCovers: false,
    scannerCoverProvider: 'google',
    scannerParseSubtitle: false,
    scannerPreferMatchedMetadata: false,
    scannerDisableWatcher: true,
    storeCoverWithItem: false,
    storeMetadataWithItem: false,
    metadataFileFormat: 'json',
    rateLimitLoginRequests: 10,
    rateLimitLoginWindow: 600000,
    allowIframe: false,
    backupPath: '/metadata/backups',
    backupSchedule: false,
    backupsToKeep: 2,
    maxBackupSize: 1,
    loggerDailyLogsToKeep: 7,
    loggerScannerLogsToKeep: 2,
    homeBookshelfView: 1,
    bookshelfView: 1,
    podcastEpisodeSchedule: '0 * * * *',
    sortingIgnorePrefix: false,
    sortingPrefixes: ['the', 'a'],
    chromecastEnabled: false,
    dateFormat: 'MM/dd/yyyy',
    timeFormat: 'HH:mm',
    language: ABS_DEFAULT_LANGUAGE,
    allowedOrigins: [],
    logLevel: 2,
    version: ABS_SERVER_VERSION,
    buildNumber: 0,
    authLoginCustomMessage: null,
    authActiveAuthMethods: ['local'],
    authOpenIDIssuerURL: null,
    authOpenIDAuthorizationURL: null,
    authOpenIDTokenURL: null,
    authOpenIDUserInfoURL: null,
    authOpenIDJwksURL: null,
    authOpenIDLogoutURL: null,
    authOpenIDTokenSigningAlgorithm: 'RS256',
    authOpenIDButtonText: 'Login with OpenId',
    authOpenIDAutoLaunch: false,
    authOpenIDAutoRegister: false,
    authOpenIDMatchExistingBy: null,
    authOpenIDSubfolderForRedirectURLs: null,
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
