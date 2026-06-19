import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AchievementModule } from '../achievement/achievement.module';
import { LibraryModule } from '../library/library.module';
import { UserModule } from '../user/user.module';
import { AbsEventBridgeService } from './abs-event-bridge.service';
import { AbsReadRepository } from './abs-read.repository';
import { AbsSocketGateway } from './abs-socket.gateway';
import { AbsAuthController } from './auth/abs-auth.controller';
import { AbsAuthGuard } from './auth/abs-auth.guard';
import { AbsDiscoveryController } from './auth/abs-discovery.controller';
import { AbsSessionService } from './auth/abs-session.service';
import { AbsTokenService } from './auth/abs-token.service';
import { AbsAuthorizeController } from './controllers/abs-authorize.controller';
import { AbsAuthorsController } from './controllers/abs-authors.controller';
import { AbsHlsController } from './controllers/abs-hls.controller';
import { AbsItemsController } from './controllers/abs-items.controller';
import { AbsLibrariesController } from './controllers/abs-libraries.controller';
import { AbsMeController } from './controllers/abs-me.controller';
import { AbsPlaylistsController } from './controllers/abs-playlists.controller';
import { AbsPublicController } from './controllers/abs-public.controller';
import { AbsSessionsController } from './controllers/abs-sessions.controller';
import { AbsBookmarkService } from './services/abs-bookmark.service';
import { AbsCatalogService } from './services/abs-catalog.service';
import { AbsPlaybackService } from './services/abs-playback.service';
import { AbsProgressService } from './services/abs-progress.service';
import { AbsStreamService } from './services/abs-stream.service';
import { AbsTranscodeService } from './services/abs-transcode.service';

/**
 * Audiobookshelf-compatible API surface. Self-contained: mounts at the router root (excluded from
 * the global `api/v1` prefix in main.ts), bypasses the global ValidationPipe / GlobalExceptionFilter
 * via raw bodies + a controller-scoped AbsExceptionFilter, and reuses BookOrbit services for data.
 */
@Module({
  imports: [JwtModule.register({}), UserModule, LibraryModule, AchievementModule],
  controllers: [
    AbsDiscoveryController,
    AbsAuthController,
    AbsAuthorizeController,
    AbsMeController,
    AbsLibrariesController,
    AbsItemsController,
    AbsAuthorsController,
    AbsSessionsController,
    AbsPublicController,
    AbsPlaylistsController,
    AbsHlsController,
  ],
  providers: [
    AbsTokenService,
    AbsSessionService,
    AbsAuthGuard,
    AbsReadRepository,
    AbsProgressService,
    AbsCatalogService,
    AbsPlaybackService,
    AbsStreamService,
    AbsTranscodeService,
    AbsSocketGateway,
    AbsBookmarkService,
    AbsEventBridgeService,
  ],
  exports: [AbsTokenService],
})
export class AbsModule {}
