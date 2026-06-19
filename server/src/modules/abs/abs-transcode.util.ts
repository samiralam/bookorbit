/**
 * Pure helpers for the HLS transcode router (REIMPLEMENTATION_GUIDE §5.3). Kept free of fs/ffmpeg so
 * the segment-window / seek-reset decision and playlist generation can be unit-tested in isolation.
 */

/** HLS target segment length in seconds. ffmpeg cuts on keyframes so real segments may vary slightly. */
export const HLS_SEGMENT_SECONDS = 6;

/**
 * How many segments ahead of the last produced one a client may request before we treat it as a seek
 * (rather than "transcoder hasn't caught up yet"). 10 × 6s ≈ a 60s buffer window.
 */
export const HLS_SEGMENT_LOOKAHEAD = 10;

/** The single playlist filename the synthetic transcode track points at. */
export const HLS_PLAYLIST_FILE = 'output.m3u8';

/** ffmpeg writes segments as `output-<n>.ts`; `-start_number` controls the first index. */
const SEGMENT_RE = /^output-(\d+)\.ts$/;
const HLS_FILE_RE = /^output(-\d+)?\.(ts|m3u8)$/;

/**
 * Validate an `:file` path component against the only two shapes we serve (`output.m3u8`,
 * `output-<n>.ts`). The strict pattern also blocks path traversal — no slashes or `..` can match.
 */
export function isHlsFile(file: string): boolean {
  return HLS_FILE_RE.test(file);
}

/** Parse the segment index out of `output-<n>.ts`, or null if the name isn't a segment. */
export function parseSegmentNumber(file: string): number | null {
  const match = SEGMENT_RE.exec(file);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** Total number of segments needed to cover `duration` seconds at the given segment length. */
export function totalSegments(duration: number, segmentLength = HLS_SEGMENT_SECONDS): number {
  if (duration <= 0) return 0;
  return Math.ceil(duration / segmentLength);
}

/**
 * Generate a VOD playlist listing every segment up front. ABS writes the full playlist itself (rather
 * than letting ffmpeg emit a live one) so the client knows the true total duration and can seek to any
 * offset; the `.ts` files are produced on demand and `404` until ready.
 */
export function buildVodPlaylist(duration: number, segmentLength = HLS_SEGMENT_SECONDS): string {
  const count = totalSegments(duration, segmentLength);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${segmentLength}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (let i = 0; i < count; i++) {
    const remaining = duration - i * segmentLength;
    const segDuration = Math.min(segmentLength, remaining);
    lines.push(`#EXTINF:${segDuration.toFixed(6)},`, `output-${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

export type SegmentAction = 'serve' | 'wait' | 'reset' | 'not-found';

export interface SegmentDecisionInput {
  /** The segment index the client asked for. */
  requestedSegment: number;
  /** The segment index ffmpeg is currently transcoding from (its `-start_number`). */
  windowStart: number;
  /** Highest segment index produced on disk so far, or `windowStart - 1` if none yet. */
  highestAvailable: number;
  /** Total segments in the title; requests outside `[0, total)` are 404s. */
  total: number;
  /** True while ffmpeg is being re-based after a seek (client should just retry). */
  isResetting: boolean;
  lookahead?: number;
}

/**
 * Mirror of ABS `Stream.checkSegmentNumberRequest` (REIMPLEMENTATION_GUIDE §5.3). Decides what to do
 * with a `.ts` request whose file isn't on disk:
 * - `not-found`: index is outside the title.
 * - `wait`: the transcoder is resetting, or the segment is within reach and just not written yet.
 * - `reset`: the client seeked outside the transcoded window — re-base ffmpeg and emit `stream_reset`.
 * - `serve`: the segment should already exist (caller still confirms the file is present).
 */
export function decideSegmentRequest(input: SegmentDecisionInput): SegmentAction {
  const { requestedSegment, windowStart, highestAvailable, total, isResetting } = input;
  const lookahead = input.lookahead ?? HLS_SEGMENT_LOOKAHEAD;

  if (requestedSegment < 0 || requestedSegment >= total) return 'not-found';
  if (isResetting) return 'wait';
  // Seeked backward before what ffmpeg is currently producing.
  if (requestedSegment < windowStart) return 'reset';
  // Already produced (or should be) — the caller re-checks the file on disk.
  if (requestedSegment <= highestAvailable) return 'serve';
  // Ahead of the produced edge but close: the transcoder will reach it shortly.
  if (requestedSegment <= highestAvailable + lookahead) return 'wait';
  // Far ahead — a forward seek beyond the buffer.
  return 'reset';
}
