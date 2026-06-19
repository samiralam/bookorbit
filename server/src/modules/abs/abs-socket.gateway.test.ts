import type { UserService } from '../user/user.service';
import { AbsSocketGateway } from './abs-socket.gateway';
import type { AbsTokenService } from './auth/abs-token.service';
import { makeAbsUser } from './__testing__/abs-test-helpers';

interface BuildOpts {
  payload?: { userId: number; username: string } | null;
  user?: ReturnType<typeof makeAbsUser> | null;
}

function build(opts: BuildOpts = {}) {
  const tokenService = { verifyAccessToken: vi.fn().mockReturnValue(opts.payload ?? null) } as unknown as AbsTokenService;
  const userService = { findByIdWithPermissions: vi.fn().mockResolvedValue(opts.user ?? null) } as unknown as UserService;
  return { gateway: new AbsSocketGateway(tokenService, userService) };
}

function makeClient() {
  return { id: 'sock-1', emit: vi.fn(), join: vi.fn().mockResolvedValue(undefined) } as any;
}

describe('AbsSocketGateway#handleAuth', () => {
  it('emits auth_failed("Invalid token") for a bad/non-string token', async () => {
    const { gateway } = build({ payload: null });
    const client = makeClient();
    await gateway.handleAuth(client, 'bad-token');
    expect(client.emit).toHaveBeenCalledWith('auth_failed', { message: 'Invalid token' });
  });

  it('emits auth_failed("Invalid user") when the user is missing or inactive', async () => {
    const { gateway } = build({ payload: { userId: 1, username: 'a' }, user: makeAbsUser({ active: false }) });
    const client = makeClient();
    await gateway.handleAuth(client, 'tok');
    expect(client.emit).toHaveBeenCalledWith('auth_failed', { message: 'Invalid user' });
  });

  it('joins the user room + the authed-broadcast room and emits init on a valid token', async () => {
    const { gateway } = build({ payload: { userId: 8, username: 'admin' }, user: makeAbsUser({ id: 8, username: 'admin' }) });
    const client = makeClient();
    await gateway.handleAuth(client, 'tok');
    expect(client.join).toHaveBeenCalledWith('abs:user:8');
    expect(client.join).toHaveBeenCalledWith('abs:authed');
    expect(client.emit).toHaveBeenCalledWith('init', { userId: 'usr_8', username: 'admin', usersOnline: [] });
  });
});

describe('AbsSocketGateway#handlePing', () => {
  it('replies pong', () => {
    const { gateway } = build();
    const client = makeClient();
    gateway.handlePing(client);
    expect(client.emit).toHaveBeenCalledWith('pong');
  });
});

describe('AbsSocketGateway server-emitted events', () => {
  it('emits user_item_progress_updated into the user room', () => {
    const { gateway } = build();
    const emit = vi.fn();
    gateway.server = { to: vi.fn().mockReturnValue({ emit }) } as any;
    const payload = { id: 'mp-1', sessionId: 's-1', deviceDescription: 'app', data: {} };
    gateway.emitUserItemProgressUpdated(8, payload);
    expect(gateway.server.to as any).toHaveBeenCalledWith('abs:user:8');
    expect(emit).toHaveBeenCalledWith('user_item_progress_updated', payload);
  });

  it('emits user_session_closed into the user room', () => {
    const { gateway } = build();
    const emit = vi.fn();
    gateway.server = { to: vi.fn().mockReturnValue({ emit }) } as any;
    gateway.emitUserSessionClosed(8, 'sess-1');
    expect(emit).toHaveBeenCalledWith('user_session_closed', 'sess-1');
  });
});

describe('AbsSocketGateway catalog-change events', () => {
  function withGateway() {
    const { gateway } = build();
    const emit = vi.fn();
    gateway.server = { to: vi.fn().mockReturnValue({ emit }) } as any;
    return { gateway, emit, to: gateway.server.to as any };
  }

  it('broadcasts library_updated to the authed room', () => {
    const { gateway, emit, to } = withGateway();
    const library = { id: 'lib_5', name: 'Audiobooks' };
    gateway.emitLibraryUpdated(library);
    expect(to).toHaveBeenCalledWith('abs:authed');
    expect(emit).toHaveBeenCalledWith('library_updated', library);
  });

  it('broadcasts item_added and items_updated to the authed room', () => {
    const { gateway, emit } = withGateway();
    gateway.emitItemAdded({ id: 'li_1' });
    gateway.emitItemsUpdated([{ id: 'li_1' }, { id: 'li_2' }]);
    expect(emit).toHaveBeenCalledWith('item_added', { id: 'li_1' });
    expect(emit).toHaveBeenCalledWith('items_updated', [{ id: 'li_1' }, { id: 'li_2' }]);
  });
});
