import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import { Server, type ServerOptions } from 'socket.io';
import { type Socket as ClientSocket, io as connect } from 'socket.io-client';
import { createRealtime, type Realtime, type RealtimeOptions } from '../src/index.js';

export interface TestUser {
  id: string;
  name: string;
  roles: string[];
  teams: string[];
}

export const USERS: Record<string, TestUser> = {
  ana: { id: '1', name: 'Ana', roles: ['admin'], teams: ['red'] },
  bob: { id: '2', name: 'Bob', roles: [], teams: ['blue'] },
  eve: { id: '3', name: 'Eve', roles: [], teams: [] },
};

/** Token format used by tests: `token:<username>`. */
export const tokenFor = (name: keyof typeof USERS): string => `token:${name}`;

export const userFromToken = (token: unknown): TestUser | null => {
  if (typeof token !== 'string' || !token.startsWith('token:')) {
    return null;
  }

  return USERS[token.slice('token:'.length)] ?? null;
};

export interface TestServer {
  app: Express;
  http: HttpServer;
  io: Server;
  rt: Realtime<TestUser>;
  url: string;
  clients: ClientSocket[];
  connect: (namespace: '/' | '/private', token?: string) => ClientSocket;
  close: () => Promise<void>;
}

export const startServer = async (
  options: Partial<RealtimeOptions<TestUser>> = {},
  configure?: (io: Server, app: Express) => void,
  serverOptions: Partial<ServerOptions> = {},
): Promise<TestServer> => {
  const app = express();

  app.use(express.json());
  const http = createServer(app);
  const io = new Server(http, serverOptions);

  configure?.(io, app);
  const rt = createRealtime<TestUser>(io, {
    authenticate: (handshake) => userFromToken((handshake.auth as { token?: unknown }).token),
    getUserId: (user) => user.id,
    getUserName: (user) => user.name,
    getUserRooms: (user) => user.roles.map((role) => `role:${role}`),
    ...options,
  });

  await new Promise<void>((resolve) => {
    http.listen(0, resolve);
  });
  const { port } = http.address() as AddressInfo;
  const url = `http://localhost:${String(port)}`;
  const clients: ClientSocket[] = [];

  return {
    app,
    http,
    io,
    rt,
    url,
    clients,
    connect: (namespace, token) => {
      const socket = connect(`${url}${namespace === '/' ? '' : namespace}`, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        auth: token ? { token } : {},
      });

      clients.push(socket);

      return socket;
    },
    close: async () => {
      for (const client of clients) {
        client.disconnect();
      }

      await io.close();
    },
  };
};

export const waitFor = <T = unknown>(
  socket: ClientSocket,
  event: string,
  timeoutMs = 2000,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);

    socket.once(event, (value: T) => {
      clearTimeout(timer);
      resolve(value);
    });
  });

/** Collects every payload of an event, for asserting that something did NOT arrive. */
export const collect = <T = unknown>(socket: ClientSocket, event: string): T[] => {
  const received: T[] = [];

  socket.on(event, (value: T) => {
    received.push(value);
  });

  return received;
};

export const connected = (socket: ClientSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    if (socket.connected) {
      resolve();

      return;
    }

    socket.once('connect', () => {
      resolve();
    });
    socket.once('connect_error', reject);
  });

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Narrows away null/undefined, failing the test otherwise. */
export const defined = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error('expected a value');
  }

  return value;
};
