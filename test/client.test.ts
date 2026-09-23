import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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

    await connected(defined(ana.private));
    server.rt.disconnectUser('1', 'logout');
    await sleep(200);
    expect(onSessionRevoked).toHaveBeenCalledWith('logout');
    expect(ana.private?.connected).toBe(false);
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
});
