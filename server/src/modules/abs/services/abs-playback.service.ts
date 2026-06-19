import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

import type { RequestUser } from '../../../common/types/request-user';
import { LibraryService } from '../../library/library.service';
import { ABS_MEDIA_TYPE_BOOK, ABS_SERVER_VERSION } from '../abs.constants';
import { AbsHttpException } from '../abs-errors';
import { decodeAbsId, encodeAbsId } from '../abs-id.util';
import { normalizeChapters } from '../abs-media.util';
import { AbsReadRepository, type AbsAudioFileRow } from '../abs-read.repository';
import { AbsSocketGateway } from '../abs-socket.gateway';
import { buildDirectPlayTracks } from '../mappers/abs-item.mapper';
import { AbsProgressService } from './abs-progress.service';

const PLAY_METHOD_DIRECT = 0;
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
  startTime: number;
  currentTime: number;
  timeListening: number;
  startedAt: number;
  updatedAt: number;
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
  currentTime?: number;
  timeListening?: number;
  duration?: number;
  updatedAt?: number;
}

/**
 * In-memory playback-session manager (mirrors ABS `PlaybackSessionManager`). MVP is direct-play
 * only (`playMethod=0`): tracks point at `/public/session/:id/track/:index` and the client seeks via
 * HTTP Range. Progress is persisted to `audiobook_progress` on sync/close.
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
  ) {}

  async startSession(user: RequestUser, bookId: number, body: StartSessionBody): Promise<Record<string, unknown>> {
    const item = await this.readRepo.findItem(bookId);
    if (!item || item.status === 'processing') throw AbsHttpException.notFound();
    if (!user.isSuperuser) {
      const accessible = await this.libraryService.findAccessibleLibraryIds(user);
      if (!accessible.includes(item.libraryId)) throw AbsHttpException.notFound();
    }

    const audioFiles = await this.readRepo.audioFilesByBookId(bookId);
    if (audioFiles.length === 0) throw AbsHttpException.notFound();

    const [authors, narrators, series] = await Promise.all([
      this.readRepo.authorsByBookIds([bookId]),
      this.readRepo.narratorsByBookIds([bookId]),
      this.readRepo.seriesByBookIds([bookId]),
    ]);

    const deviceId = typeof body.deviceInfo?.deviceId === 'string' ? body.deviceInfo.deviceId : null;
    this.closeOpenSessionsForDevice(user.id, deviceId);

    // Resume point: saved position unless the book is already finished (then restart at 0).
    const progress = await this.progressService.getMediaProgress(user.id, bookId, item.libraryId);
    const isFinished = !!progress?.isFinished;
    const resumeAt = isFinished ? 0 : ((progress?.currentTime as number) ?? 0);

    const sessionId = randomUUID();
    const duration = AbsProgressService.totalDuration(audioFiles);
    const authorName = authors.map((a) => a.name).join(', ');
    const mediaMetadata = {
      title: item.title ?? '',
      subtitle: item.subtitle ?? null,
      authorName,
      narratorName: narrators.map((n) => n.name).join(', '),
      seriesName: series.map((s) => s.name).join(', '),
      duration,
      language: item.language ?? null,
    };

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
      audioTracks: buildDirectPlayTracks(sessionId, audioFiles),
      duration,
      deviceInfo: { ...(body.deviceInfo ?? {}) },
      startTime: resumeAt,
      currentTime: resumeAt,
      timeListening: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
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
  }

  async close(sessionId: string, user: RequestUser, body?: SyncBody): Promise<void> {
    const session = this.requireOwnedSession(sessionId, user);
    if (body && (typeof body.currentTime === 'number' || typeof body.timeListened === 'number')) {
      await this.sync(sessionId, user, body);
    }
    this.sessions.delete(sessionId);
    this.socketGateway.emitUserSessionClosed(session.userId, sessionId);
  }

  /**
   * Reconcile one offline-recorded session into `audiobook_progress` using newest-`updatedAt`-wins
   * (REIMPLEMENTATION_GUIDE §7.3). Returns a per-session result; never throws on bad input.
   */
  async syncLocalSession(user: RequestUser, body: LocalSessionBody): Promise<Record<string, unknown>> {
    const id = body.id ?? randomUUID();
    const bookId = body.libraryItemId ? decodeAbsId('libraryItem', body.libraryItemId) : null;
    if (bookId === null || typeof body.currentTime !== 'number') {
      return { id, success: false, progressSynced: false, error: 'Invalid local session' };
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
  async syncLocalSessions(user: RequestUser, sessions: LocalSessionBody[]): Promise<Record<string, unknown>> {
    const results: Record<string, unknown>[] = [];
    for (const session of sessions ?? []) {
      results.push(await this.syncLocalSession(user, session));
    }
    return { results };
  }

  private requireOwnedSession(sessionId: string, user: RequestUser): AbsPlaybackSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw AbsHttpException.notFound();
    if (session.userId !== user.id && !user.isSuperuser) throw AbsHttpException.notFound();
    return session;
  }

  private closeOpenSessionsForDevice(userId: number, deviceId: string | null): void {
    for (const [id, session] of this.sessions) {
      if (session.userId !== userId) continue;
      if (deviceId && session.deviceId !== deviceId) continue;
      this.sessions.delete(id);
    }
  }

  /** Drop stale open sessions (no sync in 36h). Invoked opportunistically. */
  pruneStaleSessions(): void {
    const cutoff = Date.now() - STALE_SESSION_MS;
    for (const [id, session] of this.sessions) {
      if (session.updatedAt < cutoff) this.sessions.delete(id);
    }
  }

  private toClientJSON(session: AbsPlaybackSession): Record<string, unknown> {
    const now = Date.now();
    return {
      id: session.id,
      userId: encodeAbsId('user', session.userId),
      libraryId: encodeAbsId('library', session.libraryId),
      libraryItemId: encodeAbsId('libraryItem', session.bookId),
      bookId: encodeAbsId('book', session.bookId),
      episodeId: null,
      mediaType: ABS_MEDIA_TYPE_BOOK,
      mediaMetadata: session.mediaMetadata,
      chapters: session.chapters,
      displayTitle: session.displayTitle,
      displayAuthor: session.displayAuthor,
      coverPath: `/metadata/items/${session.bookId}/cover`,
      duration: session.duration,
      playMethod: PLAY_METHOD_DIRECT,
      mediaPlayer: 'unknown',
      deviceInfo: session.deviceInfo,
      serverVersion: ABS_SERVER_VERSION,
      date: new Date(session.startedAt).toISOString().slice(0, 10),
      dayOfWeek: new Date(session.startedAt).toLocaleDateString('en-US', { weekday: 'long' }),
      timeListening: session.timeListening,
      startTime: session.startTime,
      currentTime: session.currentTime,
      startedAt: session.startedAt,
      updatedAt: now,
      audioTracks: session.audioTracks,
    };
  }
}
