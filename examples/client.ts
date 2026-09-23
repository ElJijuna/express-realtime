/**
 * Example client: Ana and a guest connect, join the lobby, chat and call a handler.
 *
 * Run after `npm run example`: npm run example:client
 */
import { createRealtimeClient } from '../src/client/index.js';

const url = process.env.URL ?? 'http://localhost:3000';
const ana = createRealtimeClient(url, { getToken: () => 'token:ana' });
const bob = createRealtimeClient(url, { getToken: () => 'token:bob', publicNamespace: false });
const guest = createRealtimeClient(url);

ana.onNotification((n) => {
  console.log(`[ana]   ${n.type} · ${n.title}: ${n.message}`);
});
bob.onNotification((n) => {
  console.log(`[bob]   ${n.type} · ${n.title}: ${n.message}`);
});
guest.onNotification((n) => {
  console.log(`[guest] ${n.type} · ${n.title}: ${n.message}`);
});
bob.chat.onMessage((m) => {
  console.log(`[bob]   chat from ${m.from}: ${m.text}`);
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

await sleep(500);
await guest.rooms.join('lobby');
await ana.rooms.join('lobby');
await ana.rooms.join('team:red');
await ana.chat.send('2', { text: 'Hi Bob' });
console.log('[ana]   order:track →', await ana.call('order:track', 42));

await fetch(`${url}/orders`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'token:ana' },
  body: JSON.stringify({ sellerId: '2' }),
});
await fetch(`${url}/announcements`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Maintenance', message: 'Tonight at 22:00' }),
});

await sleep(500);

for (const client of [ana, bob, guest]) {
  client.close();
}
