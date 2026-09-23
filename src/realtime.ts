import type { RequestHandler } from 'express';
import { createAuth } from './auth.js';
import { type ChatService, createChat } from './chat.js';
import { createServerBroadcaster, type RealtimeContext } from './context.js';
import type { NotificationSender } from './contract.js';
import { EVENTS, userRoom } from './events.js';
import { createExpressMiddleware, type RealtimeMiddlewareOptions } from './express.js';
import { createHandlers, type HandlerRegistry } from './handlers.js';
import { type CloseOptions, closeRealtime } from './lifecycle.js';
import { NotificationService } from './notifications.js';
import { createObservability } from './observability.js';
import { createRuleResolver, SocketRateLimiter } from './rate-limit.js';
import { createRooms, type RoomService } from './rooms.js';
import { createSync } from './sync.js';
import type { AnyNamespace, AnyServer, RealtimeOptions, RealtimeSocket } from './types.js';
import { createWelcome, type WelcomeController } from './welcome.js';

/** The realtime layer mounted on the core's Socket.io server. */
export interface Realtime<User> {
  /** The core's Socket.io server, untouched. */
  io: AnyServer;
  /** Public namespace, or `null` when disabled. */
  publicNsp: AnyNamespace | null;
  privateNsp: AnyNamespace;
  notify: NotificationService;
  rooms: RoomService<User>;
  chat: ChatService;
  welcome: WelcomeController;
  /** Registers a socket event handler with ack, validation and rate limit. */
  on: HandlerRegistry<User>['on'];
  /** Emits `session:revoked` and disconnects every socket of the user, on every pod. */
  disconnectUser(userId: string | number, reason?: string): void;
  /** Whether the user has at least one private socket on any pod. Queries every pod. */
  isOnline(userId: string | number): Promise<boolean>;
  /** Express middleware adding `req.realtime` and `req.notify`. */
  middleware(options?: RealtimeMiddlewareOptions<User>): RequestHandler;
  /** Graceful shutdown for this pod. */
  close(options?: CloseOptions): Promise<void>;
}

const LIBRARY_CLIENT_EVENTS = [
  EVENTS.roomJoin,
  EVENTS.roomLeave,
  EVENTS.chatSend,
  EVENTS.chatTyping,
  EVENTS.authRefresh,
];

/**
 * Mounts the realtime layer on the core's Socket.io server.
 *
 * The server is used as is: its adapter, transports, CORS and middlewares stay under the
 * core's control. The library adds an auth middleware and handlers to the public and
 * private namespaces only.
 *
 * @example
 * ```ts
 * const io = new Server(httpServer);
 * const rt = createRealtime(io, {
 *   authenticate: (handshake) => verifyJwt(handshake.auth.token),
 *   getUserId: (user) => user.id,
 * });
 * app.use(rt.middleware());
 * ```
 */
export const createRealtime = <User>(
  io: AnyServer,
  options: RealtimeOptions<User>,
): Realtime<User> => {
  const publicNamespace = options.publicNamespace ?? '/';
  const privateNamespace = options.privateNamespace ?? '/private';

  if (publicNamespace === privateNamespace) {
    throw new Error('express-realtime: publicNamespace and privateNamespace must differ');
  }

  const ctx: RealtimeContext<User> = {
    io,
    publicNsp: publicNamespace === false ? null : io.of(publicNamespace),
    privateNsp: io.of(privateNamespace),
    options,
    obs: createObservability(options),
    state: { closing: false },
    managedEvents: new Set(LIBRARY_CLIENT_EVENTS),
    handlerRules: new Map(),
  };
  const sync = createSync(ctx);
  const auth = createAuth(ctx);
  const welcome = createWelcome(ctx, sync);
  const rooms = createRooms(ctx, sync);
  const chat = createChat(ctx);
  const handlers = createHandlers(ctx);
  const notify = new NotificationService(createServerBroadcaster(ctx), options.limits, ctx.obs);
  const resolveRule =
    options.rateLimit === false
      ? null
      : createRuleResolver(
          options.rateLimit ?? {},
          (event) => ctx.managedEvents.has(event),
          (event) => ctx.handlerRules.get(event),
        );
  const applyRateLimit = (socket: RealtimeSocket<User>): void => {
    if (!resolveRule) {
      return;
    }

    const limiter = new SocketRateLimiter(resolveRule);

    socket.use((packet, next) => {
      const event = String(packet[0]);
      const retryAfterMs = limiter.check(event);

      if (retryAfterMs === 0) {
        next();

        return;
      }

      // Dropping the packet: next() is not called, so no handler runs.
      const ack: unknown = packet.at(-1);

      if (typeof ack === 'function') {
        (ack as (result: unknown) => void)({
          ok: false,
          error: 'rate_limited',
          details: { retryAfterMs },
        });
      }

      socket.emit(EVENTS.rateLimited, { event, retryAfterMs });
      ctx.obs.metric('rateLimited', {
        scope: socket.data.scope,
        event,
        userId: socket.data.userId,
      });
    });
  };
  const setup = (socket: RealtimeSocket<User>): void => {
    // Listeners are attached synchronously so no early client event is lost.
    applyRateLimit(socket);

    if (socket.data.scope === 'private') {
      auth.attachPrivate(socket);
      chat.attach(socket);
    }

    rooms.attach(socket);
    handlers.attach(socket);

    const { scope, userId } = socket.data;

    ctx.obs.metric('connection', { scope, userId });
    socket.on('disconnect', (reason) => {
      ctx.obs.metric('disconnection', { scope, userId, reason });

      if (options.onDisconnect) {
        try {
          options.onDisconnect(socket, reason);
        } catch (error) {
          ctx.obs.reportError(error, { scope: 'hook', socketId: socket.id, userId });
        }
      }
    });

    void (async () => {
      await welcome.onConnect(socket);

      if (options.onConnect && socket.connected) {
        try {
          options.onConnect(socket);
        } catch (error) {
          ctx.obs.reportError(error, { scope: 'hook', socketId: socket.id, userId });
        }
      }
    })();
  };

  if (ctx.publicNsp) {
    ctx.publicNsp.use(auth.publicMiddleware);
    ctx.publicNsp.on('connection', setup);
  }

  ctx.privateNsp.use(auth.privateMiddleware);
  ctx.privateNsp.on('connection', setup);

  const toSender = (user: User): NotificationSender => {
    const sender: NotificationSender = { id: String(options.getUserId(user)) };
    const name = options.getUserName?.(user);

    if (name !== undefined) {
      sender.name = name;
    }

    return sender;
  };
  const rt: Realtime<User> = {
    io,
    publicNsp: ctx.publicNsp,
    privateNsp: ctx.privateNsp,
    notify,
    rooms,
    chat,
    welcome,
    on: handlers.on.bind(handlers),
    disconnectUser: (userId, reason) => {
      auth.disconnectUser(userId, reason);
    },
    async isOnline(userId) {
      const sockets = await ctx.privateNsp.in(userRoom(userId)).fetchSockets();

      return sockets.length > 0;
    },
    middleware: (middlewareOptions) => createExpressMiddleware(rt, toSender, middlewareOptions),
    close: (closeOptions) => closeRealtime(ctx, closeOptions),
  };

  return rt;
};
