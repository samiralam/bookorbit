import { Controller, Get, Param, Query, UseFilters, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { AbsExceptionFilter } from '../abs-exception.filter';
import { AbsHttpException } from '../abs-errors';
import { decodeAbsId } from '../abs-id.util';
import { AbsAuthGuard } from '../auth/abs-auth.guard';
import { AbsCatalogService } from '../services/abs-catalog.service';

/** Author detail (ENDPOINTS.md §8). `?include=items,series` eager-loads the author's books. */
@Public()
@UseGuards(AbsAuthGuard)
@UseFilters(AbsExceptionFilter)
@SkipThrottle()
@Controller('api/authors')
export class AbsAuthorsController {
  constructor(private readonly catalogService: AbsCatalogService) {}

  @Get(':id')
  async getOne(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query() query: Record<string, string>): Promise<Record<string, unknown>> {
    const authorId = decodeAbsId('author', id);
    if (authorId === null) throw AbsHttpException.notFound();
    const include = (query.include ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    return this.catalogService.getAuthor(user, authorId, include);
  }
}
