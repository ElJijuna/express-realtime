import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ConnectionStatus,
  createRealtimeClient,
  type Notification,
  type RealtimeClient,
  RealtimeClientError,
} from '../src/client/index.js';
import { connected, defined, sleep, startServer, type TestServer, tokenFor } from './helpers.js';

let server: TestServer | undefined;

const clients: RealtimeClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }

  await server?.close();
  server = undefined;
});

const client = (url: string, options: Parameters<typeof createRealtimeClient>[1] = {}) => {
  const instance = createRealtimeClient(url, {
    ...options,
    socketOptions: { transports: ['websocket'], forceNew: true, ...options.socketOptions },
  });

  clients.push(instance);

  return instance;
};
const next = <T>(subscribe: (listener: (value: T) => void) => () => void): Promise<T> =>
  new Promise((resolve) => {
    const unsubscribe = subscribe((value) => {
      unsubscribe();
      resolve(value);
    });
  });

describe('createRealtimeClient', () => {
  it('receives welcomes and notifications from both connections, deduplicated', async () => {
    server = await startServer({ welcome: { public: { title: 'Hola', message: 'guest' } } });
    server.rt.rooms.define('lobby', { access: 'public' });
    const ana = client(server.url, { getToken: () => tokenFor('ana') });
    const received: Notification[] = [];

    ana.onNotification((notification) => {
      received.push(notification);
    });
    await Promise.all([connected(defined(ana.public)), connected(defined(ana.private))]);
    await sleep(50);
    expect(received.map((n) => n.title)).toEqual(['Hola']);

    await ana.rooms.join('lobby');
    // Same notification id sent twice (e.g. a retried job): delivered once.
    server.rt.notify.user('1', { id: 'fixed', title: 'Once', message: 'm' });
    server.rt.notify.user('1', { id: 'fixed', title: 'Once', message: 'm' });
    await sleep(100);
    expect(received.map((n) => n.title)).toEqual(['Hola', 'Once']);
  });

  it('sends chat messages and calls handlers with typed errors', async () => {
    server = await startServer();
    server.rt.on('private', 'sum', ({ data }) => (data as number[]).reduce((a, b) => a + b, 0));
    const ana = client(server.url, { getToken: () => tokenFor('ana'), publicNamespace: false });
    const bob = client(server.url, { getToken: () => tokenFor('bob'), publicNamespace: false });

    await Promise.all([connected(defined(ana.private)), connected(defined(bob.private))]);
    const incoming = next(bob.chat.onMessage);
    const sent = await ana.chat.send('2', { text: 'hola' });

    await expect(incoming).resolves.toEqual(sent);
    await expect(ana.call('sum', [1, 2, 3])).resolves.toBe(6);
    await expect(ana.chat.send('1', { text: 'me' })).rejects.toEqual(
      new RealtimeClientError('invalid_recipient'),
    );
    await expect(ana.rooms.join('nope')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('drops typing indicators sent while disconnected instead of replaying them', async () => {
    server = await startServer();
    const ana = client(server.url, { getToken: () => tokenFor('ana'), publicNamespace: false });
    const bob = client(server.url, { getToken: () => tokenFor('bob'), publicNamespace: false });
    const typing: unknown[] = [];

    bob.chat.onTyping((event) => {
      typing.push(event);
    });
    await Promise.all([connected(defined(ana.private)), connected(defined(bob.private))]);
    ana.private?.disconnect();
    ana.chat.typing('2', true);
    ana.private?.connect();
    await connected(defined(ana.private));
    await sleep(100);
    expect(typing).toEqual([]);

    ana.chat.typing('2', true);
    await sleep(100);
    expect(typing).toEqual([{ from: '1', typing: true }]);
  });

  it('refreshes the token when the server warns about expiry', async () => {
    let expiresAt = Date.now() + 300;

    server = await startServer({
      expiryWarningMs: 250,
      getTokenExpiry: () => expiresAt,
    });
    const refreshToken = vi.fn(() => {
      expiresAt = Date.now() + 60_000;

      return tokenFor('ana');
    });
    const ana = client(server.url, {
      getToken: () => tokenFor('ana'),
      refreshToken,
      publicNamespace: false,
    });

    await connected(defined(ana.private));
    await sleep(500);
    expect(refreshToken).toHaveBeenCalledOnce();
    expect(ana.private?.connected).toBe(true);
  });

  it('stops reconnecting after the session is revoked', async () => {
    server = await startServer();
    const onSessionRevoked = vi.fn();
    const ana = client(server.url, {
      getToken: () => tokenFor('ana'),
      publicNamespace: false,
      onSessionRevoked,
    });
    const socket = defined(ana.private);

    await connected(socket);
    server.rt.disconnectUser('1', 'logout');
    await sleep(200);
    expect(onSessionRevoked).toHaveBeenCalledWith('logout');
    expect(socket.connected).toBe(false);
    expect(ana.private).toBeNull();
    expect(ana.loggedIn).toBe(false);
  });

  it('rejoins its rooms after reconnecting, except the ones it left or lost access to', async () => {
    server = await startServer();
    let teamOpen = true;

    server.rt.rooms.define('lobby', { access: 'public' });
    server.rt.rooms.define('hall', { access: 'public' });
    server.rt.rooms.define('team:red', { access: 'private', canJoin: () => teamOpen });
    const ana = client(server.url, { getToken: () => tokenFor('ana') });
    const guest = client(server.url);

    await Promise.all([connected(defined(ana.private)), connected(defined(guest.public))]);
    await Promise.all([
      ana.rooms.join('lobby'),
      ana.rooms.join('hall'),
      ana.rooms.join('team:red'),
      guest.rooms.join('lobby'),
    ]);
    await ana.rooms.leave('hall');
    teamOpen = false;

    const [anaId, guestId] = [ana.private?.id, guest.public?.id];

    // Without connection state recovery, the server forgets every room of these sockets.
    server.io.of('/private').disconnectSockets(true);
    server.io.of('/').disconnectSockets(true);
    await sleep(300);
    expect(ana.private?.id).not.toBe(anaId);
    expect(guest.public?.id).not.toBe(guestId);

    const rooms = async (room: string) =>
      (await server?.rt.rooms.members(room))?.map((member) => member.socketId).sort();

    await expect(rooms('lobby')).resolves.toEqual([ana.private?.id, guest.public?.id].sort());
    await expect(rooms('hall')).resolves.toEqual([]);
    await expect(rooms('team:red')).resolves.toEqual([]);

    // A room it lost access to is forgotten: the next reconnection does not retry it.
    teamOpen = true;
    server.io.of('/private').disconnectSockets(true);
    await sleep(300);
    await expect(rooms('team:red')).resolves.toEqual([]);
  });

  it('reconnects after a graceful shutdown of another pod', async () => {
    server = await startServer();
    const guest = client(server.url);

    await connected(defined(guest.public));
    const firstId = guest.public?.id;

    // Simulate the pod announcing its shutdown without closing this test server.
    server.io.of('/').emit('server:shutdown', { reconnectInMs: 20 });
    await sleep(300);
    expect(guest.public?.connected).toBe(true);
    expect(guest.public?.id).not.toBe(firstId);
  });

  describe('connection status', () => {
    const track = (instance: RealtimeClient): ConnectionStatus[] => {
      const statuses: ConnectionStatus[] = [];

      instance.onStatusChange((status) => {
        statuses.push(status);
      });

      return statuses;
    };

    it('goes from connecting to connected once both connections are up', async () => {
      server = await startServer();
      const ana = client(server.url, { getToken: () => tokenFor('ana') });
      const statuses = track(ana);

      expect(ana.status).toBe('connecting');
      await Promise.all([connected(defined(ana.public)), connected(defined(ana.private))]);
      expect(ana.status).toBe('connected');
      expect(statuses).toEqual(['connected']);

      ana.close();
      expect(ana.status).toBe('offline');
      expect(statuses).toEqual(['connected', 'offline']);
    });

    it('reports reconnecting and calls onReconnect without recovery', async () => {
      server = await startServer();
      const ana = client(server.url, { getToken: () => tokenFor('ana') });

      await Promise.all([connected(defined(ana.public)), connected(defined(ana.private))]);
      const statuses = track(ana);
      const reconnected = next(ana.onReconnect);

      server.io.of('/private').disconnectSockets(true);
      await expect(reconnected).resolves.toEqual({ recovered: false });
      expect(statuses).toEqual(['reconnecting', 'connected']);
    });

    it('reports recovered reconnections', async () => {
      server = await startServer({}, undefined, {
        connectionStateRecovery: { maxDisconnectionDuration: 10_000 },
      });
      const guest = client(server.url);

      await connected(defined(guest.public));
      // Recovery needs the offset of a received event.
      const first = next(guest.onNotification);

      server.rt.notify.broadcastPublic({ title: 'Before', message: 'm' });
      await first;
      const reconnected = next(guest.onReconnect);

      // A transport failure, unlike a server-side disconnect, keeps the session.
      guest.public?.io.engine.close();
      await expect(reconnected).resolves.toEqual({ recovered: true });
      expect(guest.status).toBe('connected');
    });

    it('stays reconnecting through a graceful shutdown', async () => {
      server = await startServer();
      const guest = client(server.url);

      await connected(defined(guest.public));
      const statuses = track(guest);
      const reconnected = next(guest.onReconnect);

      server.io.of('/').emit('server:shutdown', { reconnectInMs: 20 });
      await reconnected;
      expect(statuses).toEqual(['reconnecting', 'connected']);
    });

    it('ignores a revoked private connection while the public one is in use', async () => {
      server = await startServer();
      const ana = client(server.url, { getToken: () => tokenFor('ana') });
      const bob = client(server.url, { getToken: () => tokenFor('bob'), publicNamespace: false });

      await Promise.all([
        connected(defined(ana.public)),
        connected(defined(ana.private)),
        connected(defined(bob.private)),
      ]);
      server.rt.disconnectUser('1', 'logout');
      server.rt.disconnectUser('2', 'logout');
      await sleep(200);
      expect(ana.status).toBe('connected');
      expect(bob.status).toBe('offline');
    });

    it('goes offline when the handshake is rejected and cannot be refreshed', async () => {
      server = await startServer();
      const refreshToken = vi.fn(() => 'token:nobody');
      const eve = client(server.url, {
        getToken: () => 'token:nobody',
        refreshToken,
        publicNamespace: false,
      });
      const statuses = track(eve);

      await sleep(300);
      expect(refreshToken).toHaveBeenCalledOnce();
      expect(eve.status).toBe('offline');
      expect(statuses).toEqual(['offline']);
    });
  });

  describe('login and logout', () => {
    it('opens the private connection for a guest that signs in', async () => {
      server = await startServer();
      const guest = client(server.url);
      const bob = client(server.url, { getToken: () => tokenFor('bob'), publicNamespace: false });
      const onReconnect = vi.fn();

      guest.onReconnect(onReconnect);
      // Registered while logged out: kept for the session opened later.
      const incoming = next(guest.chat.onMessage);

      await Promise.all([connected(defined(guest.public)), connected(defined(bob.private))]);
      expect(guest.private).toBeNull();
      expect(guest.loggedIn).toBe(false);
      await expect(guest.chat.send('2', { text: 'hi' })).rejects.toMatchObject({
        code: 'unauthorized',
      });

      await guest.login(() => tokenFor('ana'));
      expect(guest.loggedIn).toBe(true);
      expect(guest.private?.connected).toBe(true);
      expect(guest.status).toBe('connected');
      expect(onReconnect).not.toHaveBeenCalled();

      await bob.chat.send('1', { text: 'welcome back' });
      await expect(incoming).resolves.toMatchObject({ from: '2', text: 'welcome back' });
    });

    it('closes only the private connection on logout and forgets its rooms', async () => {
      server = await startServer();
      server.rt.rooms.define('team:red', { access: 'private', canJoin: () => true });
      const ana = client(server.url, { getToken: () => tokenFor('ana') });

      await Promise.all([connected(defined(ana.public)), connected(defined(ana.private))]);
      await ana.rooms.join('team:red');
      ana.logout();
      expect(ana.private).toBeNull();
      expect(ana.public?.connected).toBe(true);
      expect(ana.status).toBe('connected');
      await expect(ana.call('anything', 1, { scope: 'private' })).rejects.toMatchObject({
        code: 'unauthorized',
      });

      await ana.login();
      await sleep(100);
      await expect(server.rt.rooms.members('team:red')).resolves.toEqual([]);
    });

    it('rejects when the server refuses the token', async () => {
      server = await startServer();
      const guest = client(server.url);

      await connected(defined(guest.public));
      await expect(guest.login(() => 'token:nobody')).rejects.toMatchObject({
        code: 'unauthorized',
      });
      expect(guest.loggedIn).toBe(false);
      expect(guest.private).toBeNull();
      expect(guest.status).toBe('connected');

      // Retrying with a valid token works.
      await guest.login(() => tokenFor('ana'));
      expect(guest.private?.connected).toBe(true);
    });

    it('signs in again after the session is revoked', async () => {
      server = await startServer();
      const ana = client(server.url, { getToken: () => tokenFor('ana'), publicNamespace: false });

      await connected(defined(ana.private));
      server.rt.disconnectUser('1', 'logout');
      await sleep(200);
      expect(ana.status).toBe('offline');

      await ana.login();
      expect(ana.status).toBe('connected');
      expect(ana.private?.connected).toBe(true);
    });

    it('is offline without a public namespace until login', async () => {
      server = await startServer();
      const ana = client(server.url, { publicNamespace: false });

      expect(ana.status).toBe('offline');
      await ana.login(() => tokenFor('ana'));
      expect(ana.status).toBe('connected');
    });

    it('rejects a pending login when the client is closed', async () => {
      server = await startServer();
      const guest = client(server.url);
      const pending = guest.login(() => tokenFor('ana'));

      guest.close();
      await expect(pending).rejects.toMatchObject({ code: 'closed' });
      await expect(guest.login()).rejects.toMatchObject({ code: 'closed' });
    });
  });
});
