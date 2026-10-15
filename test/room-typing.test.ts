import { afterEach, describe, expect, it } from 'vitest';
import {
  createRealtimeClient,
  type RealtimeClient,
  type RoomTypingEvent,
  type TypingParticipant,
} from '../src/client/index.js';
import {
  collect,
  connected,
  defined,
  sleep,
  startServer,
  type TestServer,
  tokenFor,
  waitFor,
} from './helpers.js';

let server: TestServer | undefined;

const clients: RealtimeClient[] = [];
const timings = { throttleMs: 40, idleMs: 150, expireMs: 300 };
const client = async (name?: string, publicOnly = false): Promise<RealtimeClient> => {
  const instance = createRealtimeClient(defined(server).url, {
    getToken: name ? () => tokenFor(name) : undefined,
    connectPrivate: Boolean(name) && !publicOnly,
    typing: timings,
    socketOptions: { transports: ['websocket'], forceNew: true },
  });

  clients.push(instance);
  await connected(defined(instance.private ?? instance.public));

  return instance;
};

afterEach(async () => {
  for (const instance of clients.splice(0)) {
    instance.close();
  }

  await server?.close();
  server = undefined;
});

describe('room typing', () => {
  it('groups connections by user, separates rooms and updates only on list changes', async () => {
    server = await startServer({ chat: false });
    server.rt.rooms.define('*', { access: 'public' });
    const [ana, tab, bob, eve] = await Promise.all([
      client('ana'),
      client('ana'),
      client('bob'),
      client('eve'),
    ]);
    const [a, a2, b, e, other] = await Promise.all([
      ana.rooms.join('lobby'),
      tab.rooms.join('lobby'),
      bob.rooms.join('lobby'),
      eve.rooms.join('lobby'),
      bob.rooms.join('other'),
    ]);
    const seen: TypingParticipant[][] = [];
    const elsewhere: TypingParticipant[][] = [];

    b.onTyping((list) => seen.push(list));
    other.onTyping((list) => elsewhere.push(list));
    expect(seen).toEqual([[]]);
    a.typing(true);
    await expect.poll(() => seen.at(-1)).toEqual([{ id: '1', kind: 'user' }]);
    a2.typing(true);
    await sleep(25);
    a.typing(false);
    e.typing(true);
    await expect
      .poll(() => seen.at(-1))
      .toEqual([
        { id: '1', kind: 'user' },
        { id: '3', kind: 'user' },
      ]);
    expect(seen).toHaveLength(3);
    expect(elsewhere).toEqual([[]]);
    a2.typing(false);
    e.typing(false);
    await expect.poll(() => seen.at(-1)).toEqual([]);
  });

  it('supports guests alongside authenticated public members and filters other namespaces', async () => {
    server = await startServer();
    server.rt.rooms.define('lobby', { access: 'public' });
    const [guest, ana, bob] = await Promise.all([client(), client('ana', true), client('bob')]);
    const [g, a, b] = await Promise.all([
      guest.rooms.join('lobby'),
      ana.rooms.join('lobby'),
      bob.rooms.join('lobby'),
    ]);

    let guests: TypingParticipant[] = [];
    let users: TypingParticipant[] = [];

    const privateSeen: TypingParticipant[][] = [];

    a.onTyping((list) => {
      guests = list;
    });
    g.onTyping((list) => {
      users = list;
    });
    b.onTyping((list) => privateSeen.push(list));
    g.typing(true);
    a.typing(true);
    await expect.poll(() => guests).toEqual([{ id: defined(guest.public).id, kind: 'guest' }]);
    await expect.poll(() => users).toEqual([{ id: '1', kind: 'user' }]);
    expect(privateSeen).toEqual([[]]);
  });

  it('throttles, stops on idle and expires activity when a stop is lost', async () => {
    server = await startServer();
    server.rt.rooms.define('lobby', { access: 'public' });
    const [ana, bob] = await Promise.all([client('ana'), client('bob')]);
    const [a, b] = await Promise.all([ana.rooms.join('lobby'), bob.rooms.join('lobby')]);
    const wire = collect<RoomTypingEvent>(defined(bob.private), 'room:typing');

    let current: TypingParticipant[] = [];

    b.onTyping((list) => {
      current = list;
    });
    a.typing(true);

    for (let index = 0; index < 5; index++) {
      a.typing(true);
    }

    await expect.poll(() => current.length).toBe(1);
    expect(wire.filter((event) => event.typing)).toHaveLength(1);
    await expect.poll(() => current).toEqual([]);
    expect(wire.at(-1)?.typing).toBe(false);
    defined(ana.private).emit('room:typing', { room: 'lobby', typing: true });
    await expect.poll(() => current.length).toBe(1);
    await expect.poll(() => current).toEqual([]);
  });

  it('clears on leave and disconnect, keeps subscriptions on reconnect, and disposes old handles', async () => {
    server = await startServer();
    server.rt.rooms.define('lobby', { access: 'public' });
    const [ana, bob] = await Promise.all([client('ana'), client('bob')]);
    const [a, b] = await Promise.all([ana.rooms.join('lobby'), bob.rooms.join('lobby')]);
    const seen: TypingParticipant[][] = [];

    b.onTyping((list) => seen.push(list));
    a.typing(true);
    await expect.poll(() => seen.at(-1)?.length).toBe(1);
    await a.leave();
    await expect.poll(() => seen.at(-1)).toEqual([]);
    a.typing(true);
    await sleep(30);
    expect(seen.at(-1)).toEqual([]);
    const fresh = await ana.rooms.join('lobby');

    fresh.typing(true);
    await expect.poll(() => seen.at(-1)?.length).toBe(1);
    defined(bob.private).disconnect();
    expect(seen.at(-1)).toEqual([]);
    defined(bob.private).connect();
    await connected(defined(bob.private));
    // Joining again is an ack barrier for automatic room recovery.
    await bob.rooms.join('lobby');
    await sleep(timings.expireMs + 20);
    expect(seen.at(-1)).toEqual([]);
    fresh.typing(true);
    await expect.poll(() => seen.at(-1)?.length).toBe(1);
    await bob.rooms.leave('lobby');
    expect(seen.at(-1)).toEqual([]);
    const count = seen.length;

    fresh.typing(false);
    await sleep(30);
    expect(seen).toHaveLength(count);
  });

  it('derives identity server-side and rejects nonmembers, reserved rooms and malformed payloads', async () => {
    server = await startServer({ chat: false });
    server.rt.rooms.define('lobby', { access: 'public' });
    const ana = server.connect('/private', tokenFor('ana'));
    const bob = server.connect('/private', tokenFor('bob'));

    await Promise.all([connected(ana), connected(bob)]);
    await bob.emitWithAck('room:join', 'lobby');
    const received = collect<RoomTypingEvent>(bob, 'room:typing');
    const own = collect(ana, 'room:typing');

    ana.emit('room:typing', { room: 'lobby', typing: true });
    ana.emit('room:typing', { room: 'authenticated', typing: true });
    ana.emit('room:typing', null);
    ana.emit('room:typing', []);
    ana.emit('room:typing', { room: '', typing: true });
    await ana.emitWithAck('room:join', 'lobby');
    ana.emit('room:typing', { room: 'lobby', typing: 'yes' });
    await sleep(30);
    expect(received).toEqual([]);
    const event = waitFor(bob, 'room:typing');

    ana.emit('room:typing', {
      room: 'lobby',
      typing: true,
      participant: { id: 'fake', kind: 'guest' },
      socketId: 'fake',
    });
    await expect(event).resolves.toEqual({
      room: 'lobby',
      typing: true,
      participant: { id: '1', kind: 'user' },
      socketId: ana.id,
    });
    expect(own).toEqual([]);
  });

  it('applies configured event rate limits', async () => {
    server = await startServer({
      rateLimit: { events: { 'room:typing': { points: 1, perMs: 1000 } } },
    });
    server.rt.rooms.define('lobby', { access: 'public' });
    const guest = server.connect('/');

    await connected(guest);
    await guest.emitWithAck('room:join', 'lobby');
    const limited = waitFor(guest, 'rate:limited');

    guest.emit('room:typing', { room: 'lobby', typing: true });
    guest.emit('room:typing', { room: 'lobby', typing: false });
    await expect(limited).resolves.toMatchObject({ event: 'room:typing' });
  });
});
