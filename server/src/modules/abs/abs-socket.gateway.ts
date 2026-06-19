import { Logger } from '@nestjs/common';
import { OnGatewayConnection, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { UserService } from '../user/user.service';
import { encodeAbsId } from './abs-id.util';
import { AbsTokenService } from './auth/abs-token.service';

function userRoom(userId: number): string {
  return `abs:user:${userId}`;
}

/** All authenticated ABS sockets; targets the contract's `emitter` (all authed clients) fan-out. */
const AUTHED_ROOM = 'abs:authed';

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
    await client.join(AUTHED_ROOM);
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

  /**
   * The HLS transcoder was re-based after a seek beyond the buffered window (REIMPLEMENTATION_GUIDE
   * §5.3). The client must restart playback at `startTime`; a client that ignores this "sticks" on seek.
   */
  emitStreamReset(userId: number, payload: { streamId: string; startTime: number }): void {
    this.server?.to(userRoom(userId)).emit('stream_reset', payload);
  }

  // --- Catalog change events (REIMPLEMENTATION_GUIDE §6.3). Broadcast to all authed clients so
  //     they refresh their library/item caches; payloads are ABS LibraryItem / Library shapes. ---

  emitItemAdded(item: Record<string, unknown>): void {
    this.server?.to(AUTHED_ROOM).emit('item_added', item);
  }

  emitItemUpdated(item: Record<string, unknown>): void {
    this.server?.to(AUTHED_ROOM).emit('item_updated', item);
  }

  emitItemRemoved(item: Record<string, unknown>): void {
    this.server?.to(AUTHED_ROOM).emit('item_removed', item);
  }

  emitItemsAdded(items: Record<string, unknown>[]): void {
    this.server?.to(AUTHED_ROOM).emit('items_added', items);
  }

  emitItemsUpdated(items: Record<string, unknown>[]): void {
    this.server?.to(AUTHED_ROOM).emit('items_updated', items);
  }

  emitLibraryAdded(library: Record<string, unknown>): void {
    this.server?.to(AUTHED_ROOM).emit('library_added', library);
  }

  emitLibraryUpdated(library: Record<string, unknown>): void {
    this.server?.to(AUTHED_ROOM).emit('library_updated', library);
  }

  emitLibraryRemoved(library: Record<string, unknown>): void {
    this.server?.to(AUTHED_ROOM).emit('library_removed', library);
  }
}
