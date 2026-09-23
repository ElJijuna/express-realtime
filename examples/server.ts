/**
 * Example core: Express + the core's own Socket.io server + express-realtime.
 *
 * Run: npm run example, then npm run example:client in another terminal.
 * Tokens are fake ("token:ana") to keep the example self-contained; use your JWT verification.
 */
import { createServer } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Server } from 'socket.io';
import { createRealtime, RealtimeError } from '../src/index.js';

interface User {
  id: string;
  name: string;
  roles: string[];
  teams: string[];
}

const USERS: Record<string, User> = {
  ana: { id: '1', name: 'Ana', roles: ['admin'], teams: ['red'] },
  bob: { id: '2', name: 'Bob', roles: [], teams: ['red'] },
};
const verifyToken = (token: unknown): User | null =>
  typeof token === 'string' && token.startsWith('token:')
    ? (USERS[token.slice('token:'.length)] ?? null)
    : null;
const app = express();

app.use(express.json());
const httpServer = createServer(app);
// The core owns Socket.io: adapter, CORS and transports are configured here, not in the library.
const io = new Server(httpServer, { cors: { origin: '*' } });
const rt = createRealtime<User>(io, {
  authenticate: (handshake) => verifyToken((handshake.auth as { token?: unknown }).token),
  getUserId: (user) => user.id,
  getUserName: (user) => user.name,
  getUserRooms: (user) => user.roles.map((role) => `role:${role}`),
  welcome: {
    public: ({ user }) =>
      user ? null : { title: 'Hi', message: 'Welcome to the site', icon: 'wave' },
    private: ({ user }) => ({ title: `Hi ${user.name}`, message: 'You have 3 pending tasks' }),
  },
  onChatMessage: (message) => {
    // Persist here if you need history. Throw to reject the message.
    console.log('chat', message.from, '→', message.to, message.text);
  },
  logger: console,
});

rt.rooms.define('lobby', {
  access: 'public',
  welcome: ({ room }) => ({ title: `Welcome to ${String(room)}`, message: 'Be nice' }),
  announce: ({ user }) => ({
    title: 'New member',
    message: `${user?.name ?? 'A guest'} joined`,
  }),
});
rt.rooms.define('team:*', {
  access: 'private',
  canJoin: (user, room) => user?.teams.includes(room.slice('team:'.length)) ?? false,
});

rt.on('private', 'order:track', ({ data, user }) => {
  if (typeof data !== 'number') {
    throw new RealtimeError('invalid_payload');
  }

  return { orderId: data, status: 'shipped', requestedBy: user.name };
});

// The core's auth middleware, protecting REST routes.
const auth = (req: Request, res: Response, next: NextFunction): void => {
  const user = verifyToken(req.header('authorization'));

  if (!user) {
    res.status(401).end();

    return;
  }

  (req as Request & { user: User }).user = user;
  next();
};

app.use(rt.middleware());

// Unprotected route: public broadcast.
app.post('/announcements', (req, res) => {
  const { title, message } = req.body as { title: string; message: string };

  res.status(201).json(req.notify({ broadcast: 'all' }, { title, message, level: 'warning' }));
});

// Protected route: notify one user; `from` is the authenticated user.
app.post('/orders', auth, (req, res) => {
  const { sellerId } = req.body as { sellerId: string };
  const orderId = Date.now();

  req.notify(
    { user: sellerId },
    { title: 'New order', message: `#${String(orderId)}`, icon: 'cart', data: { orderId } },
  );
  res.status(201).json({ orderId });
});

// Protected route: notify admins.
app.post('/deploys', auth, (req, res) => {
  res
    .status(201)
    .json(
      req.realtime.notify.role('admin', { title: 'Deploy', message: 'v2.3', level: 'success' }),
    );
});

const port = Number(process.env.PORT ?? 3000);

httpServer.listen(port, () => {
  console.log(`express-realtime example on http://localhost:${String(port)}`);
});

const shutdown = async (): Promise<void> => {
  await rt.close({ timeoutMs: 3000 });
  httpServer.close();
};

process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
