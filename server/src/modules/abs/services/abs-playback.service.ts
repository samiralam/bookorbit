import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

import type { RequestUser } from '../../../common/types/request-user';
import type { AbsPlaybackSessionRow } from '../../../db/schema';
import { LibraryService } from '../../library/library.service';
import { ABS_SERVER_VERSION } from '../abs.constants';
import { AbsHttpException } from '../abs-errors';
import { decodeAbsId, encodeAbsId } from '../abs-id.util';
import { canDirectPlay, normalizeChapters } from '../abs-media.util';
import { AbsPlaybackSessionRepository } from '../abs-playback-session.repository';
import { AbsReadRepository, type AbsAudioFileRow, type AbsItemRow } from '../abs-read.repository';
import { AbsSocketGateway } from '../abs-socket.gateway';
import { buildDirectPlayTracks, buildTranscodeTrack } from '../mappers/abs-item.mapper';
import { absDateParts, buildAbsDeviceInfo, toAbsSessionJson } from '../mappers/abs-session.mapper';
import { AbsProgressService } from './abs-progress.service';
import { AbsTranscodeService } from './abs-transcode.service';

const PLAY_METHOD_DIRECT = 0;
const PLAY_METHOD_TRANSCODE = 2;
/** Offline sessions uploaded via `/session/local[-all]` (ABS `PlayMethod.LOCAL`). */
const PLAY_METHOD_LOCAL = 3;
/** Open sessions with no update for this long are dropped (REIMPLEMENTATION_GUIDE §7.2). */
const STALE_SESSION_MS = 36 * 60 * 60 * 1000;

interface AbsPlaybackSession {
  id: string;
  userId: number;
  libraryId: number;
  bookId: number;
  deviceId: string | null;
  displayTitle: string;
  displayAuthor: string;
  mediaMetadata: Record<string, unknown>;
  chapters: Record<string, unknown>[];
  audioFiles: AbsAudioFileRow[];
  audioTracks: Record<string, unknown>[];
  duration: number;
  deviceInfo: Record<string, unknown>;
  playMethod: number;
  mediaPlayer: string;
  /** Set for transcode sessions (`playMethod=2`); the HLS stream id (== session id). */
  streamId: string | null;
  date: string;
  dayOfWeek: string;
  startTime: number;
  currentTime: number;
  timeListening: number;
  startedAt: number;
  updatedAt: number;
  /** Whether a history row exists yet (ABS `lastSave`): first save inserts, later saves update. */
  persisted: boolean;
}

export interface StartSessionBody {
  deviceInfo?: Record<string, unknown>;
  mediaPlayer?: string;
  forceDirectPlay?: boolean;
  forceTranscode?: boolean;
  supportedMimeTypes?: string[];
}

export interface SyncBody {
  currentTime?: number;
  timeListened?: number;
  duration?: number;
}

/** An offline-recorded session uploaded by the mobile app (REIMPLEMENTATION_GUIDE §7.3). */
export interface LocalSessionBody {
  id?: string;
  libraryItemId?: string;
  displayTitle?: string;
  displayAuthor?: string;
  mediaPlayer?: string;
  deviceInfo?: Record<string, unknown>;
  playMethod?: number;
  duration?: number;
  timeListening?: number;
  startTime?: number;
  currentTime?: number;
  startedAt?: number;
  updatedAt?: number;
  date?: string;
  dayOfWeek?: string;
}

/** Request-level context threaded into session writes (deviceInfo fidelity only). */
export interface LocalSessionContext {
  deviceInfo?: Record<string, unknown>;
  ipAddress?: string;
}

/**
 * In-memory playback-session manager (mirrors ABS `PlaybackSessionManager`). Negotiates direct-play
 * vs transcode (REIMPLEMENTATION_GUIDE §5.1): direct-play (`playMethod=0`) tracks point at
 * `/public/session/:id/track/:index` and the client seeks via HTTP Range; transcode (`playMethod=2`)
 * hands off to {@link AbsTranscodeService} for an HLS stream under `/hls/:streamId`. Progress is
 * persisted to `audiobook_progress` on sync/close, and — like ABS — the session itself is persisted
 * to `abs_playback_sessions` once it has accumulated listening time, feeding the history/stats
 * endpoints. Open state stays memory-only: a restart loses open sessions but keeps their history.
 */
@Injectable()
export class AbsPlaybackService {
  private readonly logger = new Logger(AbsPlaybackService.name);
  private readonly sessions = new Map<string, AbsPlaybackSession>();

  constructor(
    private readonly readRepo: AbsReadRepository,
    private readonly progressService: AbsProgressService,
    private readonly socketGateway: AbsSocketGateway,
    private readonly libraryService: LibraryService,
    private readonly transcodeService: AbsTranscodeService,
    private readonly sessionRepo: AbsPlaybackSessionRepository,
  ) {}

  async startSession(user: RequestUser, bookId: number, body: StartSessionBody, ipAddress?: string): Promise<Record<string, unknown>> {
    const item = await this.readRepo.findItem(bookId);
    if (!item || item.status === 'processing') throw AbsHttpException.notFound();
    if (!user.isSuperuser) {
      const accessible = await this.libraryService.findAccessibleLibraryIds(user);
      if (!accessible.includes(item.libraryId)) throw AbsHttpException.notFound();
    }

    const audioFiles = await this.readRepo.audioFilesByBookId(bookId);
    if (audioFiles.length === 0) throw AbsHttpException.notFound();

    const { mediaMetadata, authorName } = await this.mediaSnapshot(item);

    const deviceId = typeof body.deviceInfo?.deviceId === 'string' ? body.deviceInfo.deviceId : null;
    await this.closeOpenSessionsForDevice(user.id, deviceId);

    // Resume point: saved position unless the book is already finished (then restart at 0).
    const progress = await this.progressService.getMediaProgress(user.id, bookId, item.libraryId);
    const isFinished = !!progress?.isFinished;
    const resumeAt = isFinished ? 0 : ((progress?.currentTime as number) ?? 0);

    const sessionId = randomUUID();
    const duration = AbsProgressService.totalDuration(audioFiles);

    // Direct play unless the client forces transcode or its supportedMimeTypes can't cover the files.
    const directPlay =
      body.forceDirectPlay ||
      (!body.forceTranscode &&
        canDirectPlay(
          audioFiles.map((f) => f.format),
          body.supportedMimeTypes,
        ));

    let audioTracks: Record<string, unknown>[];
    let streamId: string | null = null;
    if (directPlay) {
      audioTracks = buildDirectPlayTracks(sessionId, audioFiles);
    } else {
      streamId = sessionId;
      await this.transcodeService.createStream({ streamId, userId: user.id, audioFiles, duration, startTime: resumeAt });
      audioTracks = [buildTranscodeTrack(streamId, duration)];
    }

    const now = Date.now();
    const session: AbsPlaybackSession = {
      id: sessionId,
      userId: user.id,
      libraryId: item.libraryId,
      bookId,
      deviceId,
      displayTitle: item.title ?? '',
      displayAuthor: authorName,
      mediaMetadata,
      chapters: normalizeChapters(item.chapters, duration) as unknown as Record<string, unknown>[],
      audioFiles,
      audioTracks,
      duration,
      deviceInfo: buildAbsDeviceInfo(user.id, body.deviceInfo, ipAddress),
      playMethod: directPlay ? PLAY_METHOD_DIRECT : PLAY_METHOD_TRANSCODE,
      mediaPlayer: body.mediaPlayer ?? 'unknown',
      streamId,
      ...absDateParts(new Date(now)),
      startTime: resumeAt,
      currentTime: resumeAt,
      timeListening: 0,
      startedAt: now,
      updatedAt: now,
      persisted: false,
    };
    this.sessions.set(sessionId, session);
    return this.toClientJSON(session);
  }

  getSession(sessionId: string, user: RequestUser): Record<string, unknown> {
    const session = this.requireOwnedSession(sessionId, user);
    return this.toClientJSON(session);
  }

  /** Returns the audio file backing a track index for the open-session track endpoint. */
  trackFile(sessionId: string, index: number): AbsAudioFileRow | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    // Podcast quirk: index 0 falls back to the first track. Books are 0-based already.
    return session.audioFiles[index] ?? session.audioFiles[0] ?? null;
  }

  async sync(sessionId: string, user: RequestUser, body: SyncBody): Promise<void> {
    const session = this.requireOwnedSession(sessionId, user);
    if (typeof body.currentTime === 'number') session.currentTime = body.currentTime;
    if (typeof body.timeListened === 'number') session.timeListening += body.timeListened;
    session.updatedAt = Date.now();

    const mediaProgress = await this.progressService.upsertFromCurrentTime(session.userId, session.bookId, session.libraryId, {
      currentTime: session.currentTime,
      duration: body.duration ?? session.duration,
    });
    if (mediaProgress) {
      this.socketGateway.emitUserItemProgressUpdated(session.userId, {
        id: mediaProgress.id as string,
        sessionId,
        deviceDescription: (session.deviceInfo?.clientName as string) ?? 'BookOrbit',
        data: mediaProgress,
      });
    }
    await this.saveSession(session);
  }

  async close(sessionId: string, user: RequestUser, body?: SyncBody): Promise<void> {
    const session = this.requireOwnedSession(sessionId, user);
    if (body && (typeof body.currentTime === 'number' || typeof body.timeListened === 'number')) {
      await this.sync(sessionId, user, body); // saves
    } else {
      await this.saveSession(session);
    }
    this.sessions.delete(sessionId);
    if (session.streamId) await this.transcodeService.closeStream(session.streamId);
    this.socketGateway.emitUserSessionClosed(session.userId, sessionId);
  }

  /**
   * Reconcile one offline-recorded session: upsert the history row by the CLIENT's session id
   * (ABS `PlaybackSessionManager.syncLocalSession`), then merge progress newest-`updatedAt`-wins
   * (REIMPLEMENTATION_GUIDE §7.3). Returns a per-session result; never throws on bad input.
   */
  async syncLocalSession(user: RequestUser, body: LocalSessionBody, ctx: LocalSessionContext = {}): Promise<Record<string, unknown>> {
    const id = body.id ?? randomUUID();
    const bookId = body.libraryItemId ? decodeAbsId('libraryItem', body.libraryItemId) : null;
    if (bookId === null || typeof body.currentTime !== 'number') {
      return { id, success: false, error: 'Invalid local session' };
    }
    const item = await this.readRepo.findItem(bookId);
    if (!item || item.status === 'processing') {
      return { id, success: false, error: 'Media item not found' };
    }

    try {
      await this.upsertLocalSessionRow(user, id, bookId, item, body, ctx);
    } catch (err) {
      this.logger.warn(`Failed to persist local session ${id}: ${(err as Error).message}`);
      return { id, success: false, error: 'Failed to save session' };
    }

    const { progressSynced, mediaProgress } = await this.progressService.mergeOfflineProgress(user.id, bookId, {
      currentTime: body.currentTime,
      duration: body.duration,
      updatedAt: body.updatedAt,
    });

    if (progressSynced && mediaProgress) {
      this.socketGateway.emitUserItemProgressUpdated(user.id, {
        id: mediaProgress.id as string,
        sessionId: id,
        deviceDescription: 'BookOrbit',
        data: mediaProgress,
      });
    }
    return { id, success: true, progressSynced };
  }

  /** Batch offline reconciliation: `{ results: [{ id, success, progressSynced, error? }] }`. */
  async syncLocalSessions(user: RequestUser, sessions: LocalSessionBody[], ctx: LocalSessionContext = {}): Promise<Record<string, unknown>> {
    const results: Record<string, unknown>[] = [];
    for (const session of sessions ?? []) {
      results.push(await this.syncLocalSession(user, session, ctx));
    }
    return { results };
  }

  private async upsertLocalSessionRow(
    user: RequestUser,
    id: string,
    bookId: number,
    item: AbsItemRow,
    body: LocalSessionBody,
    ctx: LocalSessionContext,
  ): Promise<void> {
    const currentTime = body.currentTime as number;
    const updatedAtMs = typeof body.updatedAt === 'number' ? body.updatedAt : Date.now();
    const updatedAt = new Date(updatedAtMs);
    const dateParts = absDateParts(updatedAt);

    const existing = await this.sessionRepo.findById(id);
    if (existing) {
      // The id is client-controlled; never let one user rewrite another's history row.
      if (existing.userId !== user.id) throw new Error('session id belongs to another user');
      await this.sessionRepo.updateFromLocal(id, {
        currentTime,
        timeListening: typeof body.timeListening === 'number' ? body.timeListening : existing.timeListening,
        updatedAt,
        ...dateParts,
      });
      return;
    }

    // New row: like ABS, snapshot metadata from the CURRENT server item, not the client payload.
    const { mediaMetadata, authorName } = await this.mediaSnapshot(item);
    const audioFiles = await this.readRepo.audioFilesByBookId(bookId);
    const duration = typeof body.duration === 'number' ? body.duration : AbsProgressService.totalDuration(audioFiles);
    const startedAtMs = typeof body.startedAt === 'number' ? body.startedAt : updatedAtMs;
    await this.sessionRepo.insert({
      id,
      userId: user.id,
      libraryId: item.libraryId,
      bookId,
      displayTitle: body.displayTitle ?? item.title ?? '',
      displayAuthor: body.displayAuthor ?? authorName,
      coverPath: `/metadata/items/${bookId}/cover`,
      mediaMetadata,
      chapters: normalizeChapters(item.chapters, duration) as unknown as Record<string, unknown>[],
      duration,
      playMethod: typeof body.playMethod === 'number' ? body.playMethod : PLAY_METHOD_LOCAL,
      mediaPlayer: body.mediaPlayer ?? 'unknown',
      deviceInfo: buildAbsDeviceInfo(user.id, body.deviceInfo ?? ctx.deviceInfo, ctx.ipAddress),
      serverVersion: ABS_SERVER_VERSION,
      date: body.date ?? dateParts.date,
      dayOfWeek: body.dayOfWeek ?? dateParts.dayOfWeek,
      timeListening: typeof body.timeListening === 'number' ? body.timeListening : 0,
      startTimeSeconds: typeof body.startTime === 'number' ? body.startTime : 0,
      currentTimeSeconds: currentTime,
      startedAt: new Date(startedAtMs),
      // ABS maps the row's createdAt to the session's startedAt (year-stats bucket by createdAt).
      createdAt: new Date(startedAtMs),
      updatedAt,
    });
  }

  /**
   * Persist an open session's current state (ABS `saveSession`): nothing is written until the
   * session has accumulated listening time; the first save inserts, later saves update.
   */
  private async saveSession(session: AbsPlaybackSession): Promise<void> {
    if (session.timeListening <= 0) return;
    if (session.persisted) {
      await this.sessionRepo.updateSync(session.id, {
        currentTime: session.currentTime,
        timeListening: session.timeListening,
        updatedAt: new Date(session.updatedAt),
      });
    } else {
      await this.sessionRepo.insert(this.toRow(session));
      session.persisted = true;
    }
  }

  /** The ABS `oldMetadataToJSON` snapshot stored on sessions (and echoed by the play response). */
  private async mediaSnapshot(item: AbsItemRow): Promise<{ mediaMetadata: Record<string, unknown>; authorName: string }> {
    const [authors, narrators, series, genres] = await Promise.all([
      this.readRepo.authorsByBookIds([item.id]),
      this.readRepo.narratorsByBookIds([item.id]),
      this.readRepo.seriesByBookIds([item.id]),
      this.readRepo.genresByBookIds([item.id]),
    ]);
    const authorName = authors.map((a) => a.name).join(', ');
    const mediaMetadata = {
      title: item.title ?? '',
      subtitle: item.subtitle ?? null,
      authors: authors.map((a) => ({ id: encodeAbsId('author', a.id), name: a.name })),
      narrators: narrators.map((n) => n.name),
      series: series.map((s) => ({ id: encodeAbsId('series', s.id), name: s.name, sequence: s.sequence != null ? String(s.sequence) : null })),
      genres: genres.map((g) => g.name),
      publishedYear: item.publishedYear != null ? String(item.publishedYear) : null,
      publishedDate: null,
      publisher: item.publisher ?? null,
      description: item.description ?? null,
      isbn: item.isbn13 ?? item.isbn10 ?? null,
      asin: null,
      language: item.language ?? null,
      explicit: false,
      abridged: false,
    };
    return { mediaMetadata, authorName };
  }

  private requireOwnedSession(sessionId: string, user: RequestUser): AbsPlaybackSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw AbsHttpException.notFound();
    if (session.userId !== user.id && !user.isSuperuser) throw AbsHttpException.notFound();
    return session;
  }

  /** Device takeover: ABS routes this through `closeSession`, so the dropped session is saved. */
  private async closeOpenSessionsForDevice(userId: number, deviceId: string | null): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.userId !== userId) continue;
      if (deviceId && session.deviceId !== deviceId) continue;
      this.sessions.delete(id);
      await this.saveSession(session);
      if (session.streamId) void this.transcodeService.closeStream(session.streamId);
    }
  }

  /**
   * Drop stale open sessions (no sync in 36h). Invoked opportunistically. No save here — ABS's
   * stale sweep only evicts from memory; the last sync already persisted anything worth keeping.
   */
  pruneStaleSessions(): void {
    const cutoff = Date.now() - STALE_SESSION_MS;
    for (const [id, session] of this.sessions) {
      if (session.updatedAt < cutoff) {
        this.sessions.delete(id);
        if (session.streamId) void this.transcodeService.closeStream(session.streamId);
      }
    }
  }

  /** The in-memory session as a history row (also the base of the client JSON). */
  private toRow(session: AbsPlaybackSession): AbsPlaybackSessionRow {
    return {
      id: session.id,
      userId: session.userId,
      libraryId: session.libraryId,
      bookId: session.bookId,
      displayTitle: session.displayTitle,
      displayAuthor: session.displayAuthor,
      coverPath: `/metadata/items/${session.bookId}/cover`,
      mediaMetadata: session.mediaMetadata,
      chapters: session.chapters,
      duration: session.duration,
      playMethod: session.playMethod,
      mediaPlayer: session.mediaPlayer,
      deviceInfo: session.deviceInfo,
      serverVersion: ABS_SERVER_VERSION,
      date: session.date,
      dayOfWeek: session.dayOfWeek,
      timeListening: session.timeListening,
      startTimeSeconds: session.startTime,
      currentTimeSeconds: session.currentTime,
      startedAt: new Date(session.startedAt),
      createdAt: new Date(session.startedAt),
      updatedAt: new Date(session.updatedAt),
    };
  }

  /** ABS `toJSONForClient`: the `toJSON` wire shape plus the playable `audioTracks`. */
  private toClientJSON(session: AbsPlaybackSession): Record<string, unknown> {
    return { ...toAbsSessionJson(this.toRow(session)), audioTracks: session.audioTracks };
  }
}
