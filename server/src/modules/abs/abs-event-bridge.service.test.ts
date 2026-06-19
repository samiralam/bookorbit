import { EventEmitter } from 'events';

import type { LibraryService } from '../library/library.service';
import { ACHIEVEMENT_EVENT_LIBRARY_CATALOG_CHANGED, type AchievementEventsService } from '../achievement/achievement-events.service';
import { AbsEventBridgeService } from './abs-event-bridge.service';
import type { AbsSocketGateway } from './abs-socket.gateway';

function build(libraryFindOne = vi.fn().mockResolvedValue({ id: 5, name: 'Audiobooks', folders: [] })) {
  const achievementEvents = new EventEmitter() as unknown as AchievementEventsService;
  const libraryService = { findOne: libraryFindOne } as unknown as LibraryService;
  const socketGateway = { emitLibraryUpdated: vi.fn() } as unknown as AbsSocketGateway;
  const bridge = new AbsEventBridgeService(achievementEvents, libraryService, socketGateway);
  bridge.onModuleInit();
  return { bridge, achievementEvents, libraryService, socketGateway };
}

describe('AbsEventBridgeService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('re-emits a debounced library_updated when the catalog changes', async () => {
    const { achievementEvents, socketGateway } = build();

    (achievementEvents as unknown as EventEmitter).emit(ACHIEVEMENT_EVENT_LIBRARY_CATALOG_CHANGED, { userId: 1, libraryId: 5 });
    expect(socketGateway.emitLibraryUpdated).not.toHaveBeenCalled(); // debounced

    await vi.advanceTimersByTimeAsync(1000);
    expect(socketGateway.emitLibraryUpdated).toHaveBeenCalledTimes(1);
    expect(socketGateway.emitLibraryUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: 'lib_5', name: 'Audiobooks' }));
  });

  it('coalesces a burst of catalog-change events for the same library into one emit', async () => {
    const { achievementEvents, socketGateway } = build();
    const emitter = achievementEvents as unknown as EventEmitter;

    for (let i = 0; i < 5; i++) emitter.emit(ACHIEVEMENT_EVENT_LIBRARY_CATALOG_CHANGED, { userId: 1, libraryId: 5 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(socketGateway.emitLibraryUpdated).toHaveBeenCalledTimes(1);
  });

  it('swallows errors when the library was removed before the tick', async () => {
    const { achievementEvents, socketGateway } = build(vi.fn().mockRejectedValue(new Error('Library not found')));

    (achievementEvents as unknown as EventEmitter).emit(ACHIEVEMENT_EVENT_LIBRARY_CATALOG_CHANGED, { userId: 1, libraryId: 9 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(socketGateway.emitLibraryUpdated).not.toHaveBeenCalled();
  });
});
