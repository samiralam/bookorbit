import { Logger } from '@nestjs/common';
import { OnGatewayConnection, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { UserService } from '../user/user.service';
import { encodeAbsId } from './abs-id.util';
import { AbsTokenService } from './auth/abs-token.service';

function userRoom(userId: number): string {
  return `abs:user:${userId}`;
}

/**
 * Audiobookshelf Socket.IO contract (REIMPLEMENTATION_GUIDE §6). Unlike BookOrbit's namespaced
 * gateways (which authenticate via the connection handshake), ABS clients connect to the default
 * namespace and then **emit `auth`** with their access-token JWT; the server replies `init` (or
 * `auth_failed`). Subsequent per-user events are emitted into the user's room.
 */
@WebSocketGateway({ cors: { origin: '*', methods: ['GET', 'POST'] } })
export class AbsSocketGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(AbsSocketGateway.name);

  constructor(
    private readonly tokenService: AbsTokenService,
    private readonly userService: UserService,
  ) {}

  handleConnection(): void {
    // No-op: ABS clients authenticate via the explicit `auth` event below, not the handshake.
  }

  @SubscribeMessage('auth')
  async handleAuth(client: Socket, token: unknown): Promise<void> {
    const payload = typeof token === 'string' ? this.tokenService.verifyAccessToken(token) : null;
    if (!payload) {
      client.emit('auth_failed', { message: 'Invalid token' });
      return;
    }

    const user = await this.userService.findByIdWithPermissions(payload.userId);
    if (!user || !user.active) {
      client.emit('auth_failed', { message: 'Invalid user' });
      return;
    }

    await client.join(userRoom(user.id));
    client.emit('init', { userId: encodeAbsId('user', user.id), username: user.username, usersOnline: [] });
    this.logger.debug(`[abs.socket] userId=${user.id} socketId=${client.id} authenticated`);
  }

  @SubscribeMessage('ping')
  handlePing(client: Socket): void {
    client.emit('pong');
  }

  /** Another device updated progress; clients re-sync the now-playing position. */
  emitUserItemProgressUpdated(
    userId: number,
    payload: { id: string; sessionId: string | null; deviceDescription: string; data: Record<string, unknown> },
  ): void {
    this.server?.to(userRoom(userId)).emit('user_item_progress_updated', payload);
  }

  emitUserSessionClosed(userId: number, sessionId: string): void {
    this.server?.to(userRoom(userId)).emit('user_session_closed', sessionId);
  }
}
