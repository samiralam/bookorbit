import {
  buildVodPlaylist,
  decideSegmentRequest,
  isHlsFile,
  parseSegmentNumber,
  totalSegments,
  type SegmentDecisionInput,
} from './abs-transcode.util';

describe('isHlsFile', () => {
  it('accepts the playlist and segment filenames', () => {
    expect(isHlsFile('output.m3u8')).toBe(true);
    expect(isHlsFile('output-0.ts')).toBe(true);
    expect(isHlsFile('output-123.ts')).toBe(true);
  });

  it('rejects path traversal and foreign files', () => {
    expect(isHlsFile('../secret.ts')).toBe(false);
    expect(isHlsFile('output-1.ts/../../etc/passwd')).toBe(false);
    expect(isHlsFile('output.mp4')).toBe(false);
    expect(isHlsFile('concat.txt')).toBe(false);
    expect(isHlsFile('output-.ts')).toBe(false);
  });
});

describe('parseSegmentNumber', () => {
  it('extracts the index from a segment filename', () => {
    expect(parseSegmentNumber('output-0.ts')).toBe(0);
    expect(parseSegmentNumber('output-42.ts')).toBe(42);
  });

  it('returns null for non-segment names', () => {
    expect(parseSegmentNumber('output.m3u8')).toBeNull();
    expect(parseSegmentNumber('output-x.ts')).toBeNull();
  });
});

describe('totalSegments', () => {
  it('rounds up to cover the whole duration', () => {
    expect(totalSegments(60, 6)).toBe(10);
    expect(totalSegments(61, 6)).toBe(11);
    expect(totalSegments(0, 6)).toBe(0);
  });
});

describe('buildVodPlaylist', () => {
  it('lists every segment with a trailing endlist and a short final segment', () => {
    const playlist = buildVodPlaylist(15, 6);
    expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(playlist).toContain('output-0.ts');
    expect(playlist).toContain('output-2.ts');
    expect(playlist).not.toContain('output-3.ts');
    expect(playlist).toContain('#EXT-X-ENDLIST');
    // Final segment is the 3-second remainder, not a full 6s.
    expect(playlist).toContain('#EXTINF:3.000000,');
  });
});

describe('decideSegmentRequest', () => {
  const base: SegmentDecisionInput = { requestedSegment: 5, windowStart: 0, highestAvailable: 4, total: 100, isResetting: false };

  it('serves a segment that should already exist', () => {
    expect(decideSegmentRequest({ ...base, requestedSegment: 3, highestAvailable: 4 })).toBe('serve');
  });

  it('waits while the transcoder catches up to a nearby segment', () => {
    expect(decideSegmentRequest({ ...base, requestedSegment: 6, highestAvailable: 4 })).toBe('wait');
  });

  it('waits while the stream is resetting', () => {
    expect(decideSegmentRequest({ ...base, requestedSegment: 50, highestAvailable: 4, isResetting: true })).toBe('wait');
  });

  it('resets on a forward seek beyond the lookahead window', () => {
    expect(decideSegmentRequest({ ...base, requestedSegment: 50, highestAvailable: 4 })).toBe('reset');
  });

  it('resets on a backward seek before the current window', () => {
    expect(decideSegmentRequest({ ...base, requestedSegment: 2, windowStart: 10, highestAvailable: 14 })).toBe('reset');
  });

  it('404s a segment outside the title', () => {
    expect(decideSegmentRequest({ ...base, requestedSegment: 100, total: 100 })).toBe('not-found');
    expect(decideSegmentRequest({ ...base, requestedSegment: -1 })).toBe('not-found');
  });
});
