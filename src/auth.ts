import type { ExtendedError } from 'socket.io';
import { withAck } from './ack.js';
import type { RealtimeContext } from './context.js';
import { RealtimeError } from './errors.js';
import { AUTHENTICATED_ROOM, EVENTS, userRoom } from './events.js';
import type { Handshake, RealtimeSocket } from './types.js';

const MAX_TIMEOUT = 2 ** 31 - 1;
/** `setTimeout` that supports delays beyond ~24.8 days and never keeps the process alive. */
const schedule = (delay: number, run: () => void): (() => void) => {
  let handle: NodeJS.Timeout;

  const arm = (remaining: number): void => {
    handle = setTimeout(
      () => {
        if (remaining > MAX_TIMEOUT) {
          arm(remaining - MAX_TIMEOUT);
        } else {
          run();
        }
      },
      Math.min(Math.max(remaining, 0), MAX_TIMEOUT),
    );
    handle.unref();
  };

  arm(delay);

  return () => {
    clearTimeout(handle);
  };
};
/** Runs an async middleware body and reports unexpected failures as `internal_error`. */
const runMiddleware = (
  task: () => Promise<ExtendedError | undefined>,
  next: (error?: ExtendedError) => void,
  onFailure: (error: unknown) => void,
): void => {
  void (async () => {
    try {
      next(await task());
    } catch (error) {
      onFailure(error);
      next(connectError('internal_error'));
    }
  })();
};
const connectError = (code: string): ExtendedError => {
  const error: ExtendedError = new Error(code);

  error.data = { code };

  return error;
};

type Middleware = (socket: RealtimeSocket, next: (error?: ExtendedError) => void) => void;

export interface Auth<User> {
  publicMiddleware: Middleware;
  privateMiddleware: Middleware;
  /** Joins the user rooms, schedules token expiry and registers `auth:refresh`. */
  attachPrivate(socket: RealtimeSocket<User>): void;
  /** Disconnects every socket of a user, on every pod. */
  disconnectUser(userId: string | number, reason?: string): void;
}

export const createAuth = <User>(ctx: RealtimeContext<User>): Auth<User> => {
  const { options, obs } = ctx;
  const timers = new WeakMap<RealtimeSocket<User>, () => void>();
  const warningMs = options.expiryWarningMs ?? 60_000;
  const identify = (user: User): string => String(options.getUserId(user));
  const scheduleExpiry = (
    socket: RealtimeSocket<User>,
    user: User,
    handshake: Handshake,
  ): string | null => {
    timers.get(socket)?.();
    timers.delete(socket);
    const raw = options.getTokenExpiry?.(user, handshake);

    if (raw === null || raw === undefined) {
      return null;
    }

    const expiresAt = raw instanceof Date ? raw.getTime() : raw;
    const now = Date.now();
    const cancelWarning = schedule(expiresAt - warningMs - now, () => {
      socket.emit(EVENTS.authExpiring, { expiresAt: new Date(expiresAt).toISOString() });
    });
    const cancelExpiry = schedule(expiresAt - now, () => {
      socket.emit(EVENTS.authExpired);
      socket.disconnect();
    });

    timers.set(socket, () => {
      cancelWarning();
      cancelExpiry();
    });

    return new Date(expiresAt).toISOString();
  };
  const authenticate = async (handshake: Handshake): Promise<User | null> =>
    (await options.authenticate(handshake)) ?? null;

  return {
    publicMiddleware(socket, next) {
      if (ctx.state.closing) {
        next(connectError('server_shutting_down'));

        return;
      }

      runMiddleware(
        async () => {
          let user: User | null = null;

          // The public namespace never rejects: an invalid or missing token just means a guest.
          try {
            user = await authenticate(socket.handshake);
          } catch (error) {
            obs.logger.debug('express-realtime: public handshake without user', { error });
          }

          socket.data = { user, userId: user === null ? null : identify(user), scope: 'public' };

          return undefined;
        },
        next,
        (error) => {
          obs.reportError(error, { scope: 'auth', socketId: socket.id });
        },
      );
    },

    privateMiddleware(socket, next) {
      if (ctx.state.closing) {
        next(connectError('server_shutting_down'));

        return;
      }

      const run = async (): Promise<ExtendedError | undefined> => {
        let user: User | null;

        try {
          user = await authenticate(socket.handshake);
        } catch (error) {
          obs.logger.debug('express-realtime: authenticate rejected the handshake', { error });

          return connectError('unauthorized');
        }

        if (user === null) {
          return connectError('unauthorized');
        }

        const autoRooms = (await options.getUserRooms?.(user)) ?? [];

        socket.data = { user, userId: identify(user), scope: 'private', autoRooms };

        return undefined;
      };

      runMiddleware(run, next, (error) => {
        obs.reportError(error, { scope: 'auth', socketId: socket.id });
      });
    },

    attachPrivate(socket) {
      const { user, userId, autoRooms = [] } = socket.data;

      if (user === null || userId === null) {
        return;
      }

      void socket.join([userRoom(userId), AUTHENTICATED_ROOM, ...autoRooms]);
      scheduleExpiry(socket, user, socket.handshake);

      socket.on(
        EVENTS.authRefresh,
        withAck(ctx, socket, EVENTS.authRefresh, async (token) => {
          if (typeof token !== 'string' || token === '') {
            throw new RealtimeError('invalid_payload', 'auth:refresh expects a token string');
          }

          const handshake: Handshake = {
            ...socket.handshake,
            auth: { ...socket.handshake.auth, token },
          };

          let refreshed: User | null;

          try {
            refreshed = await authenticate(handshake);
          } catch {
            throw new RealtimeError('unauthorized');
          }

          if (refreshed === null) {
            throw new RealtimeError('unauthorized');
          }

          if (identify(refreshed) !== userId) {
            throw new RealtimeError('user_mismatch');
          }

          socket.handshake.auth = handshake.auth;
          socket.data.user = refreshed;

          return { expiresAt: scheduleExpiry(socket, refreshed, handshake) };
        }),
      );

      socket.on('disconnect', () => {
        timers.get(socket)?.();
        timers.delete(socket);
      });
    },

    disconnectUser(userId, reason) {
      const room = userRoom(userId);

      ctx.privateNsp.to(room).emit(EVENTS.sessionRevoked, reason === undefined ? {} : { reason });
      // close=false keeps packet order, so clients receive session:revoked before the disconnect.
      ctx.privateNsp.in(room).disconnectSockets(false);
    },
  };
};
