import { Controller, Get, UseFilters, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../../../common/decorators/public.decorator';
import { AbsExceptionFilter } from '../abs-exception.filter';
import { AbsAuthGuard } from '../auth/abs-auth.guard';

/**
 * Playlists are not modelled in BookOrbit (its collections are filtered views, not ordered queues),
 * so the list is intentionally empty. The route exists because clients call it on startup.
 */
@Public()
@UseGuards(AbsAuthGuard)
@UseFilters(AbsExceptionFilter)
@SkipThrottle()
@Controller('api/playlists')
export class AbsPlaylistsController {
  @Get()
  list(): Record<string, unknown> {
    return { results: [], total: 0, limit: 0, page: 0 };
  }
}
