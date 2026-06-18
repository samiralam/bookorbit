import { AbsProgressService } from './abs-progress.service';
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
