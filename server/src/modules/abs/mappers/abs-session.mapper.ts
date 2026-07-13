import { randomUUID } from 'crypto';

import type { AbsPlaybackSessionRow } from '../../../db/schema';
import { ABS_MEDIA_TYPE_BOOK, ABS_SERVER_VERSION } from '../abs.constants';
import { encodeAbsId } from '../abs-id.util';

/**
 * ABS stamps sessions with the SERVER's local calendar (`date-fns format('yyyy-MM-dd')` /
 * `'EEEE'`), not UTC — these buckets feed the listening-stats days/dayOfWeek maps.
 */
export function absDateParts(at: Date): { date: string; dayOfWeek: string } {
  const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  const dayOfWeek = at.toLocaleDateString('en-US', { weekday: 'long' });
  return { date, dayOfWeek };
}

/**
 * Normalize a client-supplied deviceInfo payload into ABS `DeviceInfo.toJSON()` output: client
 * fields passed through, `clientVersion` falling back to the server version, `clientName` /
 * `deviceName` inferred exactly like `DeviceInfo.setData` (sdkVersion ⇒ Android, model ⇒ iOS),
 * and — like ABS — every null/undefined key stripped from the result.
 */
export function buildAbsDeviceInfo(userId: number, client: Record<string, unknown> | undefined, ipAddress?: string): Record<string, unknown> {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const id = randomUUID();
  const manufacturer = str(client?.manufacturer);
  const model = str(client?.model);
  const sdkVersion = typeof client?.sdkVersion === 'number' ? String(client.sdkVersion) : str(client?.sdkVersion);
  let clientName = str(client?.clientName);
  let deviceName: string | null = null;
  if (sdkVersion) {
    clientName ??= 'Abs Android';
    deviceName = `${manufacturer ?? 'Unknown'} ${model ?? ''}`;
  } else if (model) {
    clientName ??= 'Abs iOS';
    deviceName = `${manufacturer ?? 'Unknown'} ${model ?? ''}`;
  } else {
    clientName ??= 'Unknown';
  }
  const obj: Record<string, string | null> = {
    id,
    userId: encodeAbsId('user', userId),
    deviceId: str(client?.deviceId) ?? id,
    ipAddress: ipAddress ?? null,
    clientVersion: str(client?.clientVersion) ?? ABS_SERVER_VERSION,
    manufacturer,
    model,
    sdkVersion,
    clientName,
    deviceName,
  };
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));
}

/**
 * A persisted session row as ABS `PlaybackSession.toJSON()` — the shape history endpoints return
 * (`/me/listening-sessions`, stats `recentSessions`). No `audioTracks`/`libraryItem` here; those
 * belong to `toJSONForClient`, which only open sessions (play response, `GET /api/session/:id`)
 * carry.
 */
export function toAbsSessionJson(row: AbsPlaybackSessionRow): Record<string, unknown> {
  return {
    id: row.id,
    userId: encodeAbsId('user', row.userId),
    libraryId: row.libraryId === null ? null : encodeAbsId('library', row.libraryId),
    libraryItemId: encodeAbsId('libraryItem', row.bookId),
    bookId: encodeAbsId('book', row.bookId),
    episodeId: null,
    mediaType: ABS_MEDIA_TYPE_BOOK,
    mediaMetadata: row.mediaMetadata,
    chapters: row.chapters,
    displayTitle: row.displayTitle,
    displayAuthor: row.displayAuthor,
    coverPath: row.coverPath,
    duration: row.duration,
    playMethod: row.playMethod,
    mediaPlayer: row.mediaPlayer,
    deviceInfo: row.deviceInfo ?? null,
    serverVersion: row.serverVersion,
    date: row.date,
    dayOfWeek: row.dayOfWeek,
    timeListening: row.timeListening,
    startTime: row.startTimeSeconds,
    currentTime: row.currentTimeSeconds,
    startedAt: row.startedAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}
