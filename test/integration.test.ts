import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ack, ChatMessage, Notification } from '../src/index.js';
import { RealtimeError } from '../src/index.js';
import {
  collect,
  connected,
  sleep,
  startServer,
  type TestServer,
  tokenFor,
  userFromToken,
  waitFor,
} from './helpers.js';

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const start = async (...args: Parameters<typeof startServer>): Promise<TestServer> => {
  server = await startServer(...args);

  return server;
};

describe('namespaces and auth', () => {
  it('accepts guests in the public namespace and rejects them in the private one', async () => {
    const { connect } = await start();

    await expect(connected(connect('/'))).resolves.toBeUndefined();
    await expect(connected(connect('/private'))).rejects.toThrow('unauthorized');
    await expect(connected(connect('/private', 'token:nobody'))).rejects.toThrow('unauthorized');
  });

  it('treats an authenticate() failure as unauthorized, not as a crash', async () => {
    const onError = vi.fn();
    const { connect } = await start({
      authenticate: () => {
        throw new Error('db down');
      },
      onError,
    });

    await expect(connected(connect('/private', tokenFor('ana')))).rejects.toThrow('unauthorized');
    await expect(connected(connect('/'))).resolves.toBeUndefined();
  });

  it('keeps native middlewares and emits working next to the library', async () => {
    const seen: string[] = [];
    const { connect, io } = await start({}, (nativeIo) => {
      nativeIo.of('/private').use((socket, next) => {
        seen.push(socket.id);
        next();
      });
    });
    const ana = connect('/private', tokenFor('ana'));

    await connected(ana);
    expect(seen).toHaveLength(1);
    const native = waitFor(ana, 'custom');

    io.of('/private').to('user:1').emit('custom', 'hello');
    await expect(native).resolves.toBe('hello');
  });
});

describe('notifications', () => {
  it('delivers req.notify to every tab of the target user and nobody else', async () => {
    const { app, connect, rt } = await start();

    app.use((req, _res, next) => {
      (req as { user?: unknown }).user = userFromToken(req.header('authorization'));
      next();
    });
    app.use(rt.middleware());
    app.post('/orders', (req, res) => {
      const notification = req.notify(
        { user: '2' },
        { title: 'New order', message: '#1', icon: 'cart', data: { orderId: 1 } },
      );

      res.status(201).json(notification);
    });

    const bobTab1 = connect('/private', tokenFor('bob'));
    const bobTab2 = connect('/private', tokenFor('bob'));
    const eve = connect('/private', tokenFor('eve'));
    const guest = connect('/');

    await Promise.all([bobTab1, bobTab2, eve, guest].map(connected));
    const eveGot = collect(eve, 'notification');
    const guestGot = collect(guest, 'notification');
    const tab1 = waitFor<Notification>(bobTab1, 'notification');
    const tab2 = waitFor<Notification>(bobTab2, 'notification');
    const response = await request(app)
      .post('/orders')
      .set('authorization', tokenFor('ana'))
      .expect(201);
    const [first, second] = await Promise.all([tab1, tab2]);

    expect(first).toEqual(response.body);
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      title: 'New order',
      icon: 'cart',
      level: 'info',
      from: { id: '1', name: 'Ana' },
      data: { orderId: 1 },
    });
    await sleep(100);
    expect(eveGot).toEqual([]);
    expect(guestGot).toEqual([]);
  });

  it('throws a validation error for an invalid payload', async () => {
    const { rt } = await start();

    expect(() => rt.notify.user('1', { title: '', message: 'm' })).toThrow('title is required');
  });

  it('reaches role rooms and public broadcasts', async () => {
    const { connect, rt } = await start();
    const ana = connect('/private', tokenFor('ana'));
    const bob = connect('/private', tokenFor('bob'));
    const guest = connect('/');

    await Promise.all([ana, bob, guest].map(connected));
    const bobGot = collect(bob, 'notification');
    const toAdmin = waitFor<Notification>(ana, 'notification');

    rt.notify.role('admin', { title: 'Deploy', message: 'v2' });
    await expect(toAdmin).resolves.toMatchObject({ title: 'Deploy' });
    const toGuest = waitFor<Notification>(guest, 'notification');

    rt.notify.broadcastPublic({ title: 'Maintenance', message: 'soon' });
    await expect(toGuest).resolves.toMatchObject({ title: 'Maintenance' });
    await sleep(50);
    expect(bobGot).toEqual([]);
  });
});

describe('rooms', () => {
  it('lets guests join public rooms but not private or reserved ones', async () => {
    const { connect, rt } = await start();

    rt.rooms.define('lobby', { access: 'public' });
    rt.rooms.define('team:*', {
      access: 'private',
      canJoin: (user, room) => user?.teams.includes(room.split(':')[1] ?? '') ?? false,
    });
    const guest = connect('/');
    const ana = connect('/private', tokenFor('ana'));

    await Promise.all([guest, ana].map(connected));
    await expect(guest.emitWithAck('room:join', 'lobby')).resolves.toEqual({
      ok: true,
      data: { room: 'lobby' },
    });
    await expect(guest.emitWithAck('room:join', 'team:red')).resolves.toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    await expect(ana.emitWithAck('room:join', 'team:red')).resolves.toMatchObject({ ok: true });
    await expect(ana.emitWithAck('room:join', 'team:blue')).resolves.toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    await expect(ana.emitWithAck('room:join', 'user:2')).resolves.toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    await expect(ana.emitWithAck('room:join', 'undeclared')).resolves.toMatchObject({
      ok: false,
      error: 'forbidden',
    });
  });

  it('delivers room notifications to members of both namespaces', async () => {
    const { connect, rt } = await start();

    rt.rooms.define('lobby', { access: 'public' });
    const guest = connect('/');
    const ana = connect('/private', tokenFor('ana'));
    const bob = connect('/private', tokenFor('bob'));

    await Promise.all([guest, ana, bob].map(connected));
    await guest.emitWithAck('room:join', 'lobby');
    await ana.emitWithAck('room:join', 'lobby');
    const bobGot = collect(bob, 'notification');
    const both = Promise.all([
      waitFor<Notification>(guest, 'notification'),
      waitFor<Notification>(ana, 'notification'),
    ]);

    rt.notify.room('lobby', { title: 'Hi room', message: 'm' });
    const [toGuest, toAna] = await both;

    expect(toGuest.id).toBe(toAna.id);
    expect(await rt.rooms.members('lobby')).toHaveLength(2);
    await sleep(50);
    expect(bobGot).toEqual([]);
  });

  it('joins every socket of a user server-side', async () => {
    const { connect, rt } = await start();
    const ana = connect('/private', tokenFor('ana'));

    await connected(ana);
    rt.rooms.join('1', 'project:7');
    await sleep(50);
    const got = waitFor(ana, 'project:update');

    rt.rooms.emit('project:7', 'project:update', { progress: 50 });
    await expect(got).resolves.toEqual({ progress: 50 });
  });
});

describe('welcome messages', () => {
  it('welcomes public and private connections, only on the new socket', async () => {
    const { connect } = await start({
      welcome: {
        public: { title: 'Hola', message: 'Bienvenido' },
        private: ({ user }) => ({ title: `Hola ${user.name}`, message: 'Tienes tareas' }),
      },
    });
    const guest = connect('/');
    const guestWelcome = waitFor<Notification>(guest, 'notification');

    await expect(guestWelcome).resolves.toMatchObject({ type: 'welcome', title: 'Hola' });

    const tab1 = connect('/private', tokenFor('ana'));

    await expect(waitFor<Notification>(tab1, 'notification')).resolves.toMatchObject({
      title: 'Hola Ana',
    });
    const tab1Got = collect(tab1, 'notification');
    const tab2 = connect('/private', tokenFor('ana'));

    await expect(waitFor<Notification>(tab2, 'notification')).resolves.toMatchObject({
      title: 'Hola Ana',
    });
    await sleep(50);
    expect(tab1Got).toEqual([]);
  });

  it('sends nothing for null and survives a failing resolver', async () => {
    const onError = vi.fn();
    const { connect } = await start({
      onError,
      welcome: {
        public: () => null,
        private: () => {
          throw new Error('boom');
        },
      },
    });
    const guest = connect('/');
    const ana = connect('/private', tokenFor('ana'));
    const got = [...[guest, ana].map((socket) => collect(socket, 'notification'))];

    await Promise.all([guest, ana].map(connected));
    await sleep(100);
    expect(got.flat()).toEqual([]);
    expect(ana.connected).toBe(true);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ scope: 'welcome' }),
    );
  });

  it('welcomes room joiners and announces them to the other members', async () => {
    const { connect, rt } = await start();

    rt.rooms.define('lobby', {
      access: 'public',
      welcome: ({ room }) => ({ title: `Bienvenido a ${String(room)}`, message: 'Sé amable' }),
      announce: ({ user }) => ({
        title: 'Nuevo en la sala',
        message: `${user?.name ?? 'Invitado'} se unió`,
      }),
    });
    const guest = connect('/');
    const ana = connect('/private', tokenFor('ana'));

    await Promise.all([guest, ana].map(connected));
    await guest.emitWithAck('room:join', 'lobby');
    const announce = waitFor<Notification>(guest, 'notification');
    const welcome = waitFor<Notification>(ana, 'notification');

    await ana.emitWithAck('room:join', 'lobby');
    await expect(welcome).resolves.toMatchObject({ type: 'welcome', title: 'Bienvenido a lobby' });
    await expect(announce).resolves.toMatchObject({
      type: 'room.join',
      message: 'Ana se unió',
    });
  });

  it('changes welcomes at runtime', async () => {
    const { connect, rt } = await start({ welcome: { public: { title: 'Old', message: 'm' } } });

    rt.welcome.set('public', { title: 'New', message: 'm' });
    await expect(waitFor<Notification>(connect('/'), 'notification')).resolves.toMatchObject({
      title: 'New',
    });
    rt.rooms.define('lobby', { access: 'public' });
    rt.rooms.update('lobby', { welcome: { title: 'Room hi', message: 'm' } });
    const guest = connect('/');

    await connected(guest);
    await sleep(50);
    const roomWelcome = waitFor<Notification>(guest, 'notification');

    await guest.emitWithAck('room:join', 'lobby');
    await expect(roomWelcome).resolves.toMatchObject({ title: 'Room hi' });
    expect(() => {
      rt.rooms.update('missing', {});
    }).toThrow(RealtimeError);
  });
});

describe('1:1 chat', () => {
  it('delivers to the recipient and the sender other tabs, ignoring a forged from', async () => {
    const { connect } = await start();
    const anaTab1 = connect('/private', tokenFor('ana'));
    const anaTab2 = connect('/private', tokenFor('ana'));
    const bob = connect('/private', tokenFor('bob'));

    await Promise.all([anaTab1, anaTab2, bob].map(connected));
    const toBob = waitFor<ChatMessage>(bob, 'chat:message');
    const toAnaTab2 = waitFor<ChatMessage>(anaTab2, 'chat:message');
    const tab1Got = collect(anaTab1, 'chat:message');
    const ack = (await anaTab1.emitWithAck('chat:send', {
      to: '2',
      text: 'hola',
      from: '3',
    })) as Ack<ChatMessage>;

    expect(ack.ok).toBe(true);
    const received = await toBob;

    expect(received).toMatchObject({ from: '1', to: '2', text: 'hola', conversationId: 'dm:1:2' });
    expect((await toAnaTab2).id).toBe(received.id);
    await sleep(50);
    expect(tab1Got).toEqual([]);
  });

  it('rejects messages when onChatMessage or canChat refuse them', async () => {
    const onChatMessage = vi.fn(() => {
      throw new Error('db down');
    });
    const { connect } = await start({
      onChatMessage,
      canChat: (from, to) => !(from.id === '1' && to === '3'),
    });
    const ana = connect('/private', tokenFor('ana'));
    const bob = connect('/private', tokenFor('bob'));

    await Promise.all([ana, bob].map(connected));
    const bobGot = collect(bob, 'chat:message');

    await expect(ana.emitWithAck('chat:send', { to: '2', text: 'hi' })).resolves.toMatchObject({
      ok: false,
      error: 'chat_rejected',
    });
    await expect(ana.emitWithAck('chat:send', { to: '3', text: 'hi' })).resolves.toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    await expect(ana.emitWithAck('chat:send', { to: '1', text: 'hi' })).resolves.toMatchObject({
      ok: false,
      error: 'invalid_recipient',
    });
    await expect(ana.emitWithAck('chat:send', { to: '2', text: '' })).resolves.toMatchObject({
      ok: false,
      error: 'invalid_payload',
    });
    await sleep(50);
    expect(bobGot).toEqual([]);
    expect(onChatMessage).toHaveBeenCalledOnce();
  });

  it('relays typing indicators', async () => {
    const { connect } = await start();
    const ana = connect('/private', tokenFor('ana'));
    const bob = connect('/private', tokenFor('bob'));

    await Promise.all([ana, bob].map(connected));
    const typing = waitFor(bob, 'chat:typing');

    ana.emit('chat:typing', { to: '2', typing: true });
    await expect(typing).resolves.toEqual({ from: '1', typing: true });
  });
});

describe('declarative handlers and rate limit', () => {
  it('returns the handler result, validation errors and hides internal errors', async () => {
    const onError = vi.fn();
    const { connect, rt } = await start({ onError });

    rt.on('private', 'order:track', ({ data, userId }) => ({ id: data, by: userId }), {
      validate: (input) => {
        if (typeof input !== 'number') {
          throw Object.assign(new Error('bad'), { issues: [{ path: [], message: 'number' }] });
        }

        return input;
      },
    });
    rt.on('both', 'explode', () => {
      throw new Error('secret stack');
    });
    rt.on('both', 'teapot', () => {
      throw new RealtimeError('teapot');
    });
    const ana = connect('/private', tokenFor('ana'));

    await connected(ana);
    await expect(ana.emitWithAck('order:track', 7)).resolves.toEqual({
      ok: true,
      data: { id: 7, by: '1' },
    });
    await expect(ana.emitWithAck('order:track', 'x')).resolves.toEqual({
      ok: false,
      error: 'invalid_payload',
      details: [{ path: [], message: 'number' }],
    });
    await expect(ana.emitWithAck('explode')).resolves.toEqual({
      ok: false,
      error: 'internal_error',
    });
    await expect(ana.emitWithAck('teapot')).resolves.toEqual({ ok: false, error: 'teapot' });
    expect(onError).toHaveBeenCalledOnce();
    expect(() => {
      rt.on('both', 'disconnect', () => undefined);
    }).toThrow('reserved');
  });

  it('drops events over the limit and reports them', async () => {
    const rateLimited = vi.fn();
    const { connect, rt } = await start({ metrics: { rateLimited } });

    rt.on('public', 'ping', () => 'pong', { rateLimit: { points: 2, perMs: 60_000 } });
    const guest = connect('/');

    await connected(guest);
    const notice = waitFor(guest, 'rate:limited');

    await expect(guest.emitWithAck('ping')).resolves.toMatchObject({ ok: true });
    await expect(guest.emitWithAck('ping')).resolves.toMatchObject({ ok: true });
    await expect(guest.emitWithAck('ping')).resolves.toMatchObject({
      ok: false,
      error: 'rate_limited',
    });
    await expect(notice).resolves.toMatchObject({ event: 'ping' });
    expect(rateLimited).toHaveBeenCalledWith({ scope: 'public', event: 'ping', userId: null });
  });
});

describe('token expiry and session control', () => {
  it('warns before expiry, accepts a refresh and expires without it', async () => {
    const expiries = new Map<string, number>();
    const { connect } = await start({
      expiryWarningMs: 100,
      getTokenExpiry: (_user, handshake) => {
        const { token } = handshake.auth as { token: string };
        const expiry = expiries.get(token) ?? Date.now() + 200;

        expiries.set(token, expiry);

        return expiry;
      },
    });
    const ana = connect('/private', tokenFor('ana'));

    await connected(ana);
    await waitFor(ana, 'auth:expiring');
    expiries.set(tokenFor('ana'), Date.now() + 60_000);
    await expect(ana.emitWithAck('auth:refresh', tokenFor('bob'))).resolves.toMatchObject({
      ok: false,
      error: 'user_mismatch',
    });
    await expect(ana.emitWithAck('auth:refresh', tokenFor('ana'))).resolves.toMatchObject({
      ok: true,
    });
    await sleep(250);
    expect(ana.connected).toBe(true);

    const bob = connect('/private', tokenFor('bob'));

    await connected(bob);
    const expired = waitFor(bob, 'auth:expired', 1000);
    const disconnected = waitFor(bob, 'disconnect', 1000);

    await expired;
    await expect(disconnected).resolves.toBe('io server disconnect');
  });

  it('disconnectUser revokes every tab of the user', async () => {
    const { connect, rt } = await start();
    const tabs = [connect('/private', tokenFor('ana')), connect('/private', tokenFor('ana'))];
    const bob = connect('/private', tokenFor('bob'));

    await Promise.all([...tabs, bob].map(connected));
    expect(await rt.isOnline('1')).toBe(true);
    const revoked = tabs.map((tab) => waitFor(tab, 'session:revoked'));

    rt.disconnectUser('1', 'banned');
    await expect(Promise.all(revoked)).resolves.toEqual([
      { reason: 'banned' },
      { reason: 'banned' },
    ]);
    await sleep(50);
    expect(tabs.every((tab) => !tab.connected)).toBe(true);
    expect(bob.connected).toBe(true);
    expect(await rt.isOnline('1')).toBe(false);
  });
});

describe('graceful shutdown', () => {
  it('announces the shutdown, rejects new connections and keeps the core io open', async () => {
    const { connect, rt, io } = await start();
    const guest = connect('/');

    await connected(guest);
    const shutdown = waitFor(guest, 'server:shutdown');
    const disconnected = waitFor(guest, 'disconnect', 1000);
    const closing = rt.close({ timeoutMs: 200, reconnectInMs: 10 });

    await expect(shutdown).resolves.toEqual({ reconnectInMs: 10 });
    await expect(connected(connect('/'))).rejects.toThrow('server_shutting_down');
    await closing;
    await expect(disconnected).resolves.toBe('io server disconnect');
    expect(io.of('/private')).toBeDefined();
    expect(io.engine).toBeDefined();
  });
});
