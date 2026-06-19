import type { AbsPlaybackService } from '../services/abs-playback.service';
import { makeAbsUser } from '../__testing__/abs-test-helpers';
import { AbsSessionsController } from './abs-sessions.controller';

function build() {
  const playbackService = {
    getSession: vi.fn().mockReturnValue({ id: 'sess-1' }),
    sync: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AbsPlaybackService;
  return { controller: new AbsSessionsController(playbackService), playbackService };
}

describe('AbsSessionsController', () => {
  it('getSession returns the open session for the owner', () => {
    const { controller, playbackService } = build();
    const user = makeAbsUser();
    expect(controller.getSession(user, 'sess-1')).toEqual({ id: 'sess-1' });
    expect(playbackService.getSession).toHaveBeenCalledWith('sess-1', user);
  });

  it('sync forwards the body to the playback service (200 on success)', async () => {
    const { controller, playbackService } = build();
    const user = makeAbsUser();
    const body = { currentTime: 120, timeListened: 30 };
    await controller.sync(user, 'sess-1', body);
    expect(playbackService.sync).toHaveBeenCalledWith('sess-1', user, body);
  });

  it('sync tolerates an empty body', async () => {
    const { controller, playbackService } = build();
    await controller.sync(makeAbsUser(), 'sess-1', undefined as never);
    expect(playbackService.sync).toHaveBeenCalledWith('sess-1', expect.anything(), {});
  });

  it('close forwards the optional final sync body', async () => {
    const { controller, playbackService } = build();
    const user = makeAbsUser();
    const body = { currentTime: 300 };
    await controller.close(user, 'sess-1', body);
    expect(playbackService.close).toHaveBeenCalledWith('sess-1', user, body);
  });
});
