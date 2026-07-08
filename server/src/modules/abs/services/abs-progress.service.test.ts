import { AbsProgressService } from './abs-progress.service';
import * as schema from '../../../db/schema';
import type { AbsAudioFileRow } from '../abs-read.repository';

function file(id: number, durationSeconds: number): AbsAudioFileRow {
  return { id, bookId: 1, format: 'mp3', sortOrder: id, durationSeconds, sizeBytes: 1000, absolutePath: `/x/${id}.mp3` };
}

describe('AbsProgressService progress math', () => {
  const files = [file(10, 100), file(11, 200), file(12, 50)]; // total 350s

  it('sums total duration', () => {
    expect(AbsProgressService.totalDuration(files)).toBe(350);
    expect(AbsProgressService.totalDuration([])).toBe(0);
  });

  it('computes absolute current time across files', () => {
    expect(AbsProgressService.absoluteCurrentTime(files, 10, 30)).toBe(30); // first file
    expect(AbsProgressService.absoluteCurrentTime(files, 11, 30)).toBe(130); // 100 + 30
    expect(AbsProgressService.absoluteCurrentTime(files, 12, 10)).toBe(310); // 100 + 200 + 10
  });

  it('resolves an absolute position back to (file, offset)', () => {
    expect(AbsProgressService.resolveFileAndOffset(files, 30)).toEqual({ fileId: 10, positionSeconds: 30 });
    expect(AbsProgressService.resolveFileAndOffset(files, 130)).toEqual({ fileId: 11, positionSeconds: 30 });
    expect(AbsProgressService.resolveFileAndOffset(files, 310)).toEqual({ fileId: 12, positionSeconds: 10 });
  });

  it('round-trips absoluteCurrentTime <-> resolveFileAndOffset', () => {
    for (const t of [0, 50, 100, 250, 349]) {
      const placement = AbsProgressService.resolveFileAndOffset(files, t)!;
      expect(AbsProgressService.absoluteCurrentTime(files, placement.fileId, placement.positionSeconds)).toBe(t);
    }
  });

  it('pins a past-the-end position to the last file end', () => {
    expect(AbsProgressService.resolveFileAndOffset(files, 9999)).toEqual({ fileId: 12, positionSeconds: 50 });
  });

  it('returns null when there are no audio files', () => {
    expect(AbsProgressService.resolveFileAndOffset([], 10)).toBeNull();
  });
});

describe('AbsProgressService#toMediaProgress shape', () => {
  // Stub deps: toMediaProgress is pure given its args and touches neither.
  const service = new AbsProgressService(undefined as never, undefined as never);
  const row = {
    userId: 3,
    bookId: 427,
    percentage: 1,
    currentFileId: 10,
    positionSeconds: 30,
    updatedAt: new Date('2026-06-01T00:00:00Z'),
  } as schema.AudiobookProgress;

  // Regression: ABS MediaProgress carries non-nullable createdAt/updatedAt. Omitting them fails
  // Prologue's strict Codable decode of /api/me and silently blanks the entire library.
  it('emits every key ABS MediaProgress requires, incl. createdAt/updatedAt', () => {
    const progress = (
      service as unknown as {
        toMediaProgress: (b: number, r: schema.AudiobookProgress, f: AbsAudioFileRow[], p: number) => Record<string, unknown>;
      }
    ).toMediaProgress(427, row, [file(10, 100), file(11, 200)], 98);

    expect(Object.keys(progress).sort()).toEqual(
      [
        'createdAt',
        'currentTime',
        'duration',
        'ebookLocation',
        'ebookProgress',
        'episodeId',
        'finishedAt',
        'hideFromContinueListening',
        'id',
        'isFinished',
        'lastUpdate',
        'libraryItemId',
        'mediaItemId',
        'mediaItemType',
        'progress',
        'startedAt',
        'updatedAt',
        'userId',
      ].sort(),
    );
    const updatedMs = row.updatedAt.getTime();
    expect(progress.createdAt).toBe(updatedMs);
    expect(progress.updatedAt).toBe(updatedMs);
    // Verified against live ABS 2.35.1: userId is always present and ebookProgress is a number
    // (0 for audio), never null — strict clients decode both.
    expect(progress.userId).toBe(`usr_${row.userId}`);
    expect(progress.ebookProgress).toBe(0);
  });
});
