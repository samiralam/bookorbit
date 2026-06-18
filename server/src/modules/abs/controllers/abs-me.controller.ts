import { Controller, Get, UseFilters, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { LibraryService } from '../../library/library.service';
import { AbsExceptionFilter } from '../abs-exception.filter';
import { encodeAbsId } from '../abs-id.util';
import { AbsAuthGuard } from '../auth/abs-auth.guard';
import { toAbsUser } from '../mappers/abs-user.mapper';
import { AbsProgressService } from '../services/abs-progress.service';

/** Current-user endpoint (REIMPLEMENTATION_GUIDE §3). */
@Public()
@UseGuards(AbsAuthGuard)
@UseFilters(AbsExceptionFilter)
@Controller('api/me')
export class AbsMeController {
  constructor(
    private readonly progressService: AbsProgressService,
    private readonly libraryService: LibraryService,
  ) {}

  @Get()
  async me(@CurrentUser() user: RequestUser): Promise<Record<string, unknown>> {
    const [mediaProgress, accessibleIds] = await Promise.all([
      this.progressService.listMediaProgressForUser(user.id),
      this.libraryService.findAccessibleLibraryIds(user),
    ]);
    return toAbsUser(user, {
      mediaProgress,
      librariesAccessible: user.isSuperuser ? [] : accessibleIds.map((id) => encodeAbsId('library', id)),
    });
  }
}
