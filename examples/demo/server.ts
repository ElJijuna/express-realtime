/**
 * Live demo: every feature of express-realtime behind a small web page.
 *
 * Run: npm run demo, then open http://localhost:3000 in two or more tabs.
 * The page (public/app.ts) is bundled with esbuild on every request: edit it and reload.
 * Tokens are fake ("token:ana:<expiresAt>") to keep the demo self-contained.
 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { build } from 'esbuild';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Server } from 'socket.io';
import { createRealtime, RealtimeError } from '../../src/index.js';

interface User {
  id: string;
  name: string;
  roles: string[];
  teams: string[];
}

type AuthedRequest = Request & { user: User };

const USERS: Record<string, User> = {
  ana: { id: '1', name: 'Ana', roles: ['admin'], teams: ['red'] },
  bob: { id: '2', name: 'Bob', roles: [], teams: ['red'] },
  eve: { id: '3', name: 'Eve', roles: [], teams: ['blue'] },
};
// Short-lived tokens so the page shows auth:expiring → refresh without waiting long.
const TOKEN_TTL_MS = 90_000;
const EXPIRY_WARNING_MS = 20_000;
const parseToken = (token: unknown): { user: User; expiresAt: number } | null => {
  if (typeof token !== 'string') {
    return null;
  }

  const [prefix, name, expiresAt] = token.split(':');
  const user = name ? USERS[name] : undefined;

  if (prefix !== 'token' || !user || Number(expiresAt) < Date.now()) {
    return null;
  }

  return { user, expiresAt: Number(expiresAt) };
};
const tokenOf = (handshake: { auth: Record<string, unknown> }): unknown => handshake.auth.token;
const app = express();

app.use(express.json());
const httpServer = createServer(app);
// Connection state recovery (in-memory adapter) lets short transport drops replay missed events.
const io = new Server(httpServer, {
  connectionStateRecovery: { maxDisconnectionDuration: 30_000 },
});
const rt = createRealtime<User>(io, {
  authenticate: (handshake) => parseToken(tokenOf(handshake))?.user ?? null,
  getUserId: (user) => user.id,
  getUserName: (user) => user.name,
  getUserRooms: (user) => user.roles.map((role) => `role:${role}`),
  getTokenExpiry: (_user, handshake) => parseToken(tokenOf(handshake))?.expiresAt,
  expiryWarningMs: EXPIRY_WARNING_MS,
  welcome: {
    public: ({ user }) => (user ? null : { title: 'Hi guest', message: 'Log in to chat' }),
    private: ({ user }) => ({
      title: `Hi ${user.name}`,
      message: 'Open another tab as someone else and start chatting',
      level: 'success',
    }),
  },
  canChat: (_from, to) => Object.values(USERS).some((user) => user.id === to),
  rateLimit: {
    default: { points: 20, perMs: 1000 },
    events: { 'order:track': { points: 3, perMs: 5000 } },
  },
  logger: { debug: () => {}, info: console.info, warn: console.warn, error: console.error },
});

rt.rooms.define('lobby', {
  access: 'public',
  welcome: ({ room }) => ({ title: `Welcome to ${String(room)}`, message: 'Be nice' }),
  announce: ({ user }) => ({ title: 'New member', message: `${user?.name ?? 'A guest'} joined` }),
});
rt.rooms.define('team:*', {
  access: 'private',
  canJoin: (user, room) => user?.teams.includes(room.slice('team:'.length)) ?? false,
  welcome: ({ room }) => ({ title: `Joined ${String(room)}`, message: 'Only your team is here' }),
});

rt.on(
  'private',
  'order:track',
  ({ data, user }) => ({ orderId: data, status: 'shipped', requestedBy: user.name }),
  {
    validate: (input) => {
      if (typeof input !== 'number') {
        throw new RealtimeError('invalid_payload', 'orderId must be a number');
      }

      return input;
    },
  },
);
rt.on('public', 'dice:roll', () => 1 + Math.floor(Math.random() * 6));

// The page is plain TypeScript: bundle it on each request so edits show up on reload.
const publicDir = join(import.meta.dirname, 'public');

app.get('/app.js', async (_req, res, next) => {
  try {
    const result = await build({
      entryPoints: [join(publicDir, 'app.ts')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      sourcemap: 'inline',
      write: false,
    });

    res.type('js').send(result.outputFiles[0]?.text);
  } catch (error) {
    next(error);
  }
});
app.use(express.static(publicDir));
app.use(rt.middleware());

const auth = (req: Request, res: Response, next: NextFunction): void => {
  const user = parseToken(req.header('authorization'))?.user;

  if (!user) {
    res.status(401).json({ error: 'unauthorized' });

    return;
  }

  (req as AuthedRequest).user = user;
  next();
};

app.post('/api/token', (req, res) => {
  const { user } = req.body as { user: string };

  if (!USERS[user]) {
    res.status(404).json({ error: 'unknown user' });

    return;
  }

  res.json({ token: `token:${user}:${String(Date.now() + TOKEN_TTL_MS)}` });
});

// Public route: everyone, guests included.
app.post('/api/announce', (req, res) => {
  const { message } = req.body as { message?: string };

  res
    .status(201)
    .json(
      req.notify(
        { broadcast: 'all' },
        { title: 'Announcement', message: message || 'Hello everyone', level: 'warning' },
      ),
    );
});

// Every tab of the caller: shows cross-tab delivery and deduplication.
app.post('/api/notify/me', auth, (req, res) => {
  const { user } = req as AuthedRequest;

  res
    .status(201)
    .json(
      req.notify({ user: user.id }, { title: 'For you', message: 'Delivered to all your tabs' }),
    );
});

app.post('/api/notify/admins', auth, (req, res) => {
  res.status(201).json(
    req.realtime.notify.role('admin', {
      title: 'Admins only',
      message: 'Only Ana receives this',
      level: 'success',
    }),
  );
});

// Custom event to a room; the page listens with room.on('room:event').
app.post('/api/rooms/:room/event', (req, res) => {
  const { room } = req.params;
  const { text } = req.body as { text?: string };

  rt.rooms.emit(room, 'room:event', { room, text: text || 'ping', at: new Date().toISOString() });
  res.status(202).end();
});

app.post('/api/revoke', auth, (req, res) => {
  rt.disconnectUser((req as AuthedRequest).user.id, 'revoked from the demo');
  res.status(202).end();
});

// Server-side disconnect of the namespaces: not recoverable, so the session and its rooms are
// lost and the client joins them again. disconnectSockets(true) would close the whole connection,
// which connection state recovery treats as recoverable.
app.post('/api/restart', (_req, res) => {
  io.of('/').disconnectSockets();
  io.of('/private').disconnectSockets();
  res.status(202).end();
});

app.get('/api/online', async (_req, res) => {
  const online = await Promise.all(
    Object.entries(USERS).map(async ([key, user]) => [key, await rt.isOnline(user.id)] as const),
  );

  res.json(Object.fromEntries(online));
});

const port = Number(process.env.PORT ?? 3000);

httpServer.listen(port, () => {
  console.log(
    `express-realtime demo on http://localhost:${String(port)} (open it in several tabs)`,
  );
});

const shutdown = async (): Promise<void> => {
  await rt.close({ timeoutMs: 3000 });
  httpServer.close();
};

process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
