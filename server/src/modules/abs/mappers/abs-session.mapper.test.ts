import type { AbsPlaybackSessionRow } from '../../../db/schema';
import { absDateParts, buildAbsDeviceInfo, toAbsSessionJson } from './abs-session.mapper';

function row(overrides: Partial<AbsPlaybackSessionRow> = {}): AbsPlaybackSessionRow {
  return {
    id: 'f1e2d3c4-0000-4000-8000-000000000001',
    userId: 3,
    libraryId: 4,
    bookId: 42,
    displayTitle: 'The Hobbit',
    displayAuthor: 'J.R.R. Tolkien',
    coverPath: '/metadata/items/42/cover',
    mediaMetadata: { title: 'The Hobbit' },
    chapters: [],
    duration: 300,
    playMethod: 0,
    mediaPlayer: 'AVPlayer',
    deviceInfo: { deviceId: 'dev-1' },
    serverVersion: '2.35.1',
    date: '2026-07-12',
    dayOfWeek: 'Sunday',
    timeListening: 120,
    startTimeSeconds: 10,
    currentTimeSeconds: 130,
    startedAt: new Date(1_700_000_000_000),
    createdAt: new Date(1_700_000_000_000),
    updatedAt: new Date(1_700_000_100_000),
    ...overrides,
  };
}

describe('toAbsSessionJson', () => {
  it('emits EXACTLY the ABS PlaybackSession.toJSON key set (strict-Codable clients)', () => {
    const json = toAbsSessionJson(row());
    expect(Object.keys(json).sort()).toEqual(
      [
        'id',
        'userId',
        'libraryId',
        'libraryItemId',
        'bookId',
        'episodeId',
        'mediaType',
        'mediaMetadata',
        'chapters',
        'displayTitle',
        'displayAuthor',
        'coverPath',
        'duration',
        'playMethod',
        'mediaPlayer',
        'deviceInfo',
        'serverVersion',
        'date',
        'dayOfWeek',
        'timeListening',
        'startTime',
        'currentTime',
        'startedAt',
        'updatedAt',
      ].sort(),
    );
    // No toJSONForClient extras on history rows:
    expect(json).not.toHaveProperty('audioTracks');
    expect(json).not.toHaveProperty('libraryItem');
  });

  it('encodes ids, keeps books podcast-free, and emits ms epochs', () => {
    const json = toAbsSessionJson(row());
    expect(json.userId).toBe('usr_3');
    expect(json.libraryId).toBe('lib_4');
    expect(json.libraryItemId).toBe('li_42');
    expect(json.bookId).toBe('bk_42');
    expect(json.episodeId).toBeNull();
    expect(json.mediaType).toBe('book');
    expect(json.startedAt).toBe(1_700_000_000_000);
    expect(json.updatedAt).toBe(1_700_000_100_000);
    expect(json.startTime).toBe(10);
    expect(json.currentTime).toBe(130);
  });

  it('passes a null libraryId through (deleted library) instead of encoding it', () => {
    expect(toAbsSessionJson(row({ libraryId: null })).libraryId).toBeNull();
  });
});

describe('absDateParts', () => {
  it('formats the server-local calendar date and English weekday', () => {
    const { date, dayOfWeek } = absDateParts(new Date(2026, 6, 12, 9, 30));
    expect(date).toBe('2026-07-12');
    expect(dayOfWeek).toBe('Sunday');
  });
});

describe('buildAbsDeviceInfo', () => {
  it('infers Abs Android from sdkVersion and builds deviceName like ABS', () => {
    const info = buildAbsDeviceInfo(3, { deviceId: 'dev-1', manufacturer: 'Google', model: 'Pixel 8', sdkVersion: 34 });
    expect(info.clientName).toBe('Abs Android');
    expect(info.sdkVersion).toBe('34');
    expect(info.deviceName).toBe('Google Pixel 8');
    expect(info.userId).toBe('usr_3');
    expect(info.deviceId).toBe('dev-1');
  });

  it('strips null fields and falls back deviceId to the generated id', () => {
    const info = buildAbsDeviceInfo(3, undefined, undefined);
    expect(info).not.toHaveProperty('manufacturer');
    expect(info).not.toHaveProperty('model');
    expect(info).not.toHaveProperty('ipAddress');
    expect(info).not.toHaveProperty('deviceName');
    expect(info.clientName).toBe('Unknown');
    expect(info.deviceId).toBe(info.id);
    expect(typeof info.clientVersion).toBe('string'); // server-version fallback
  });

  it('keeps the caller ip when provided', () => {
    expect(buildAbsDeviceInfo(3, {}, '10.1.1.2').ipAddress).toBe('10.1.1.2');
  });
});
