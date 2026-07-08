import { toAbsLibrary } from './abs-library.mapper';

describe('toAbsLibrary', () => {
  it('encodes the id, maps folders, and reports mediaType book', () => {
    const createdAt = new Date('2024-01-02T03:04:05.000Z');
    const lib = toAbsLibrary({
      id: 5,
      name: 'Audiobooks',
      icon: 'headphones',
      displayOrder: 2,
      coverAspectRatio: '1.6',
      createdAt,
      updatedAt: createdAt,
      folders: [{ id: 11, path: '/data/audiobooks', createdAt }],
    });

    expect(lib.id).toBe('lib_5');
    expect(lib.name).toBe('Audiobooks');
    expect(lib.mediaType).toBe('book');
    expect(lib.icon).toBe('headphones');
    // ABS display order is 1-based; BookOrbit's 0-based value shifts up by one.
    expect(lib.displayOrder).toBe(3);
    expect(lib.createdAt).toBe(createdAt.getTime());
    expect(lib.folders).toEqual([{ id: '11', fullPath: '/data/audiobooks', libraryId: 'lib_5', addedAt: createdAt.getTime() }]);
    // ABS Library.toOldJSON always carries lastScan/lastScanVersion; strict clients may read a null
    // lastScan as "never scanned" and hide content, so we mirror updatedAt as the effective scan.
    expect(lib.lastScan).toBe(createdAt.getTime());
    expect(lib.lastScanVersion).toEqual(expect.any(String));
  });

  it('maps a square cover aspect ratio to flag 1 and a standard one to flag 0 (ABS BookCoverAspectRatio)', () => {
    expect((toAbsLibrary({ id: 1, name: 'a', coverAspectRatio: '1/1' }).settings as any).coverAspectRatio).toBe(1);
    expect((toAbsLibrary({ id: 1, name: 'a', coverAspectRatio: '1' }).settings as any).coverAspectRatio).toBe(1);
    expect((toAbsLibrary({ id: 1, name: 'a', coverAspectRatio: '1.6' }).settings as any).coverAspectRatio).toBe(0);
  });

  it('emits the full ABS 2.35.1 LibrarySettings field set', () => {
    const settings = toAbsLibrary({ id: 1, name: 'a' }).settings as Record<string, unknown>;
    expect(Object.keys(settings).sort()).toEqual([
      'audiobooksOnly',
      'autoScanCronExpression',
      'coverAspectRatio',
      'disableWatcher',
      'epubsAllowScriptedContent',
      'hideSingleBookSeries',
      'markAsFinishedPercentComplete',
      'markAsFinishedTimeRemaining',
      'metadataPrecedence',
      'onlyShowLaterBooksInContinueSeries',
      'skipMatchingMediaWithAsin',
      'skipMatchingMediaWithIsbn',
    ]);
  });

  it('normalizes non-ABS icon values to the ABS icon set', () => {
    expect(toAbsLibrary({ id: 1, name: 'a', icon: 'Mic' }).icon).toBe('microphone-1');
    expect(toAbsLibrary({ id: 1, name: 'a', icon: 'BookOpen' }).icon).toBe('book-1');
    expect(toAbsLibrary({ id: 1, name: 'a', icon: 'SomethingElse' }).icon).toBe('database');
  });

  it('applies sensible defaults when optional fields are absent', () => {
    const lib = toAbsLibrary({ id: 7, name: 'Bare' });
    expect(lib.folders).toEqual([]);
    expect(lib.displayOrder).toBe(1);
    expect(lib.icon).toBe('database');
    expect(lib.createdAt).toBe(0);
  });
});
