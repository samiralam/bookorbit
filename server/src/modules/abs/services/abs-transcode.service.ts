import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChildProcess, spawn } from 'child_process';
import { mkdir, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import type { AbsAudioFileRow } from '../abs-read.repository';
import { AbsSocketGateway } from '../abs-socket.gateway';
import {
  buildVodPlaylist,
  decideSegmentRequest,
  HLS_SEGMENT_SECONDS,
  parseSegmentNumber,
  type SegmentAction,
  totalSegments,
} from '../abs-transcode.util';

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
/** Open transcode streams idle for this long are torn down (mirrors the playback session TTL). */
const STALE_STREAM_MS = 36 * 60 * 60 * 1000;

interface TranscodeStream {
  id: string;
  userId: number;
  streamDir: string;
  concatPath: string;
  audioFiles: AbsAudioFileRow[];
  duration: number;
  segmentLength: number;
  total: number;
  /** Segment index ffmpeg's current invocation started from (`-start_number`). */
  windowStart: number;
  /** True between kicking ffmpeg to a new offset and its first segment landing on disk. */
  isResetting: boolean;
  process: ChildProcess | null;
  updatedAt: number;
}

export interface SegmentResolution {
  action: SegmentAction;
  /** Absolute path to serve, set only when `action === 'serve'`. */
  filePath?: string;
}

/**
 * Manages HLS transcode streams for `playMethod=2` sessions (REIMPLEMENTATION_GUIDE §5.3). Each stream
 * owns a temp dir, a concat list of the item's audio files, and a running ffmpeg that emits
 * `output-<n>.ts` segments. We generate the VOD playlist ourselves; seeking outside the transcoded
 * window re-bases ffmpeg and notifies the client over the socket via `stream_reset`.
 */
@Injectable()
export class AbsTranscodeService {
  private readonly logger = new Logger(AbsTranscodeService.name);
  private readonly streams = new Map<string, TranscodeStream>();
  private readonly streamsRoot: string;

  constructor(
    config: ConfigService,
    private readonly socketGateway: AbsSocketGateway,
  ) {
    const appDataPath = config.get<string>('storage.appDataPath')!;
    this.streamsRoot = join(appDataPath, 'abs', 'streams');
  }

  /**
   * Spin up a transcode stream for an open session and return the playlist URL the synthetic
   * audio track points at. ffmpeg is started from the segment covering `startTime` so resume
   * playback doesn't transcode from the top of a long book.
   */
  async createStream(opts: {
    streamId: string;
    userId: number;
    audioFiles: AbsAudioFileRow[];
    duration: number;
    startTime: number;
  }): Promise<string> {
    const segmentLength = HLS_SEGMENT_SECONDS;
    const streamDir = join(this.streamsRoot, opts.streamId);
    await mkdir(streamDir, { recursive: true });

    const concatPath = join(streamDir, 'concat.txt');
    await writeFile(concatPath, this.buildConcatList(opts.audioFiles));
    await writeFile(join(streamDir, 'output.m3u8'), buildVodPlaylist(opts.duration, segmentLength));

    const total = totalSegments(opts.duration, segmentLength);
    const windowStart = total > 0 ? Math.min(Math.max(0, Math.floor(opts.startTime / segmentLength)), total - 1) : 0;

    const stream: TranscodeStream = {
      id: opts.streamId,
      userId: opts.userId,
      streamDir,
      concatPath,
      audioFiles: opts.audioFiles,
      duration: opts.duration,
      segmentLength,
      total,
      windowStart,
      isResetting: false,
      process: null,
      updatedAt: Date.now(),
    };
    this.streams.set(opts.streamId, stream);
    this.launchFfmpeg(stream, windowStart);
    return `/hls/${opts.streamId}/output.m3u8`;
  }

  hasStream(streamId: string): boolean {
    return this.streams.has(streamId);
  }

  /** Generated VOD playlist for an open stream, or null when the stream id is unknown. */
  playlist(streamId: string): string | null {
    const stream = this.streams.get(streamId);
    if (!stream) return null;
    stream.updatedAt = Date.now();
    return buildVodPlaylist(stream.duration, stream.segmentLength);
  }

  /**
   * Resolve a `.ts` segment request. Serves the file when ready; on a seek outside the transcoded
   * window it re-bases ffmpeg, emits `stream_reset`, and reports `reset` so the caller `404`s.
   */
  async resolveSegment(streamId: string, file: string): Promise<SegmentResolution> {
    const stream = this.streams.get(streamId);
    if (!stream) return { action: 'not-found' };
    stream.updatedAt = Date.now();

    const requestedSegment = parseSegmentNumber(file);
    if (requestedSegment === null) return { action: 'not-found' };

    const filePath = join(stream.streamDir, file);
    const highestAvailable = await this.highestAvailableSegment(stream);

    const action = decideSegmentRequest({
      requestedSegment,
      windowStart: stream.windowStart,
      highestAvailable,
      total: stream.total,
      isResetting: stream.isResetting,
    });

    if (action === 'serve') {
      // The decision says it should exist; confirm and otherwise let the client retry.
      return requestedSegment <= highestAvailable ? { action: 'serve', filePath } : { action: 'wait' };
    }

    if (action === 'reset') {
      this.resetTo(stream, requestedSegment);
      return { action: 'reset' };
    }

    return { action };
  }

  /** Tear down a stream: kill ffmpeg and remove its temp dir. Safe to call for unknown ids. */
  async closeStream(streamId: string): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    this.streams.delete(streamId);
    stream.process?.kill('SIGKILL');
    await rm(stream.streamDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Drop transcode streams with no activity in 36h. Invoked opportunistically. */
  pruneStaleStreams(): void {
    const cutoff = Date.now() - STALE_STREAM_MS;
    for (const [id, stream] of this.streams) {
      if (stream.updatedAt < cutoff) void this.closeStream(id);
    }
  }

  /** Re-base ffmpeg to start at `segment` and notify the client to restart playback there. */
  private resetTo(stream: TranscodeStream, segment: number): void {
    stream.process?.kill('SIGKILL');
    stream.windowStart = segment;
    stream.isResetting = true;
    this.launchFfmpeg(stream, segment);
    this.socketGateway.emitStreamReset(stream.userId, {
      streamId: stream.id,
      startTime: segment * stream.segmentLength,
    });
  }

  /** Highest `output-<n>.ts` index currently on disk, or `windowStart - 1` when none exist yet. */
  private async highestAvailableSegment(stream: TranscodeStream): Promise<number> {
    let highest = stream.windowStart - 1;
    let entries: string[];
    try {
      entries = await readdir(stream.streamDir);
    } catch {
      return highest;
    }
    for (const entry of entries) {
      const n = parseSegmentNumber(entry);
      if (n !== null && n > highest) highest = n;
    }
    return highest;
  }

  /** ffmpeg concat-demuxer manifest listing every audio file in play order. */
  private buildConcatList(audioFiles: AbsAudioFileRow[]): string {
    // `file '...'`; single quotes inside paths are escaped per the concat demuxer's quoting rules.
    return audioFiles.map((f) => `file '${f.absolutePath.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
  }

  /**
   * Spawn ffmpeg to transcode the concatenated audio to AAC HLS, writing `output-<n>.ts` from
   * `startSegment`. Input-seeks to the segment's start offset so a reset produces the right window.
   * Isolated into one method so tests can stub it without a real ffmpeg binary.
   */
  private launchFfmpeg(stream: TranscodeStream, startSegment: number): void {
    const startTime = startSegment * stream.segmentLength;
    const args = [
      '-y',
      '-ss',
      String(startTime),
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      stream.concatPath,
      '-map',
      '0:a',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ac',
      '2',
      '-f',
      'segment',
      '-segment_time',
      String(stream.segmentLength),
      '-segment_start_number',
      String(startSegment),
      '-segment_format',
      'mpegts',
      '-reset_timestamps',
      '1',
      join(stream.streamDir, 'output-%d.ts'),
    ];

    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    stream.process = proc;
    // Once ffmpeg starts emitting (any stderr progress), the reset window is live again.
    proc.stderr?.on('data', () => {
      if (stream.process === proc) stream.isResetting = false;
    });
    proc.on('error', (err) => this.logger.warn(`[abs.hls] ffmpeg failed for stream ${stream.id}: ${err.message}`));
    proc.on('close', () => {
      if (stream.process === proc) {
        stream.process = null;
        stream.isResetting = false;
      }
    });
  }
}
