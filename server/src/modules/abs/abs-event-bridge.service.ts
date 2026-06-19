import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import {
  ACHIEVEMENT_EVENT_LIBRARY_CATALOG_CHANGED,
  AchievementEventsService,
  type LibraryCatalogChangedPayload,
} from '../achievement/achievement-events.service';
import { LibraryService } from '../library/library.service';
import { AbsSocketGateway } from './abs-socket.gateway';
import { toAbsLibrary } from './mappers/abs-library.mapper';

/**
 * Bridges BookOrbit's internal catalog-change signal to the ABS socket contract (§6.3). The scanner
 * and library service already emit `LIBRARY_CATALOG_CHANGED` on the shared event bus when a scan
 * ingests/updates books or access changes; we re-emit it as an ABS `library_updated` so connected
 * clients refresh that library's items/personalized shelves. Purely a consumer — no core changes.
 *
 * Per-item `item_added`/`items_updated` events would need the changed book ids, which the current
 * signal doesn't carry; library-level invalidation is the faithful subset we can drive today.
 */
@Injectable()
export class AbsEventBridgeService implements OnModuleInit {
  private readonly logger = new Logger(AbsEventBridgeService.name);
  /** Coalesce bursts of catalog-change events per library (scans fire many in quick succession). */
  private readonly pending = new Map<number, NodeJS.Timeout>();
  private static readonly DEBOUNCE_MS = 1000;

  constructor(
    private readonly achievementEvents: AchievementEventsService,
    private readonly libraryService: LibraryService,
    private readonly socketGateway: AbsSocketGateway,
  ) {}

  onModuleInit(): void {
    this.achievementEvents.on(ACHIEVEMENT_EVENT_LIBRARY_CATALOG_CHANGED, (payload: LibraryCatalogChangedPayload) => {
      this.scheduleLibraryUpdate(payload.libraryId);
    });
  }

  private scheduleLibraryUpdate(libraryId: number): void {
    const existing = this.pending.get(libraryId);
    if (existing) clearTimeout(existing);
    this.pending.set(
      libraryId,
      setTimeout(() => {
        this.pending.delete(libraryId);
        void this.emitLibraryUpdated(libraryId);
      }, AbsEventBridgeService.DEBOUNCE_MS).unref(),
    );
  }

  private async emitLibraryUpdated(libraryId: number): Promise<void> {
    try {
      const library = await this.libraryService.findOne(libraryId);
      this.socketGateway.emitLibraryUpdated(toAbsLibrary(library));
    } catch (err) {
      // Library may have been removed between the signal and this tick — nothing to broadcast.
      this.logger.debug(`[abs.event_bridge] libraryId=${libraryId} skip - ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
