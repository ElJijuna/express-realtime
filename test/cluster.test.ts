import { createAdapter } from '@socket.io/redis-adapter';
import { Emitter } from '@socket.io/redis-emitter';
import { createClient } from 'redis';
import { afterEach, describe, expect, it } from 'vitest';
import { createRealtimeEmitter, type Notification } from '../src/index.js';
import {
  collect,
  connected,
  sleep,
  startServer,
  type TestServer,
  tokenFor,
  waitFor,
} from './helpers.js';

const { REDIS_URL } = process.env;
const createRedis = () => createClient({ url: REDIS_URL });

type RedisClient = ReturnType<typeof createRedis>;

const redisClients: RedisClient[] = [];
const servers: TestServer[] = [];
const redis = async (): Promise<RedisClient> => {
  const client = createRedis();

  redisClients.push(client);
  await client.connect();

  return client;
};
/** One "pod": its own HTTP server and Socket.io server, sharing Redis with the others. */
const pod = async (options: Parameters<typeof startServer>[0] = {}): Promise<TestServer> => {
  const pub = await redis();
  const sub = await redis();
  const server = await startServer(options, (io) => {
    io.adapter(createAdapter(pub, sub));
  });

  servers.push(server);

  return server;
};

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }

  for (const client of redisClients.splice(0)) {
    if (client.isOpen) {
      await client.quit();
    } else {
      client.destroy();
    }
  }
});

describe.skipIf(!REDIS_URL)('cluster (Redis adapter)', () => {
  it('notifies, joins rooms and disconnects users connected to another pod', async () => {
    const [podA, podB] = [await pod(), await pod()];
    const bob = podB.connect('/private', tokenFor('bob'));

    await connected(bob);
    const notification = waitFor<Notification>(bob, 'notification');

    podA.rt.notify.user('2', { title: 'From pod A', message: 'm' });
    await expect(notification).resolves.toMatchObject({ title: 'From pod A' });

    podA.rt.rooms.join('2', 'project:1');
    await sleep(100);
    const roomEvent = waitFor(bob, 'project:update');

    podA.rt.rooms.emit('project:1', 'project:update', 1);
    await expect(roomEvent).resolves.toBe(1);
    expect(await podA.rt.isOnline('2')).toBe(true);

    const revoked = waitFor(bob, 'session:revoked');

    podA.rt.disconnectUser('2', 'banned');
    await expect(revoked).resolves.toEqual({ reason: 'banned' });
  });

  it('syncs welcome and room changes made on another pod', async () => {
    const [podA, podB] = [await pod(), await pod()];

    podA.rt.rooms.define('lobby', { access: 'public' });
    podB.rt.rooms.define('lobby', { access: 'public' });
    podA.rt.welcome.set('public', { title: 'Synced', message: 'm' });
    podA.rt.rooms.update('lobby', { welcome: { title: 'Room synced', message: 'm' } });
    await sleep(200);

    const guest = podB.connect('/');

    await expect(waitFor<Notification>(guest, 'notification')).resolves.toMatchObject({
      title: 'Synced',
    });
    const roomWelcome = waitFor<Notification>(guest, 'notification');

    await guest.emitWithAck('room:join', 'lobby');
    await expect(roomWelcome).resolves.toMatchObject({ title: 'Room synced' });
  });

  it('reaches sockets from a worker through the Redis emitter', async () => {
    const podB = await pod();
    const bob = podB.connect('/private', tokenFor('bob'));
    const eve = podB.connect('/private', tokenFor('eve'));

    await Promise.all([bob, eve].map(connected));
    const eveGot = collect(eve, 'notification');
    const worker = createRealtimeEmitter(new Emitter(await redis()));
    const notification = waitFor<Notification>(bob, 'notification');
    const chat = waitFor(bob, 'chat:message');

    worker.notify.user('2', { title: 'Export ready', message: 'm' });
    await expect(notification).resolves.toMatchObject({ title: 'Export ready' });
    worker.chat.send('3', '2', { text: 'from a bot' });
    await expect(chat).resolves.toMatchObject({ from: '3', to: '2', text: 'from a bot' });
    await sleep(100);
    expect(eveGot).toEqual([]);
  });
});
