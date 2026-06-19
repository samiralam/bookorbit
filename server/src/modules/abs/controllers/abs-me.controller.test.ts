import type { LibraryService } from '../../library/library.service';
import type { AbsProgressService } from '../services/abs-progress.service';
import { makeAbsUser } from '../__testing__/abs-test-helpers';
import { AbsMeController } from './abs-me.controller';

function build(progress: Record<string, unknown>[], accessibleIds: number[]) {
  const progressService = { listMediaProgressForUser: vi.fn().mockResolvedValue(progress) } as unknown as AbsProgressService;
  const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue(accessibleIds) } as unknown as LibraryService;
  return { controller: new AbsMeController(progressService, libraryService), progressService };
}

describe('AbsMeController#me', () => {
  it('returns the current user with their media progress', async () => {
    const { controller, progressService } = build([{ id: 'mp1' }], [3]);
    const user = await controller.me(makeAbsUser({ id: 8, isSuperuser: false }));
    expect(user.id).toBe('usr_8');
    expect(user.mediaProgress).toEqual([{ id: 'mp1' }]);
    expect(progressService.listMediaProgressForUser).toHaveBeenCalledWith(8);
  });

  it('exposes encoded accessible library ids for scoped users', async () => {
    const { controller } = build([], [3, 7]);
    const user = await controller.me(makeAbsUser({ isSuperuser: false }));
    expect(user.librariesAccessible).toEqual(['lib_3', 'lib_7']);
  });

  it('hides the library list for superusers (empty array means "all")', async () => {
    const { controller } = build([], [3, 7]);
    const user = await controller.me(makeAbsUser({ isSuperuser: true }));
    expect(user.librariesAccessible).toEqual([]);
  });
});
