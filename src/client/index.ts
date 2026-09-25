/**
 * Typed browser/Node client for express-realtime.
 *
 * @packageDocumentation
 */

import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import type {
  Ack,
  ChatMessage,
  ChatSendInput,
  Notification,
  ServerToClientEvents,
} from '../contract.js';
import { EVENTS } from '../events.js';

export type {
  Ack,
  ChatMessage,
  ChatSendInput,
  ClientToServerEvents,
  Notification,
  NotificationLevel,
  NotificationSender,
  RealtimeErrorCode,
  ServerToClientEvents,
} from '../contract.js';

/** A value or a promise of it. */
export type MaybePromise<T> = T | Promise<T>;

/** Error thrown when the server answers `{ ok: false }` or does not answer in time. */
export class RealtimeClientError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, details?: unknown) {
    super(code);
    this.name = 'RealtimeClientError';
    this.code = code;
    this.details = details;
  }
}

export interface RealtimeClientOptions {
  /** Token sent in `handshake.auth.token`. Called on every (re)connection. */
  getToken?: () => MaybePromise<string | null | undefined>;
  /** Gets a fresh token when the server sends `auth:expiring`, `auth:expired` or rejects the handshake. */
  refreshToken?: () => MaybePromise<string | null | undefined>;
  /** Must match the server. Default: `/`. `false` skips the public connection. */
  publicNamespace?: string | false;
  /** Must match the server. Default: `/private`. */
  privateNamespace?: string;
  /** Opens the private connection. Default: true when `getToken` is set. */
  connectPrivate?: boolean;
  /** Passed to `socket.io-client`, e.g. `{ transports: ['websocket'] }`. */
  socketOptions?: Partial<ManagerOptions & SocketOptions>;
  /** How long to wait for acks. Default: 10 000 ms. */
  ackTimeoutMs?: number;
  /** How many notification ids are remembered for deduplication. Default: 500. */
  dedupeSize?: number;
  /** Called when the server revokes the session with `rt.disconnectUser()`. */
  onSessionRevoked?: (reason?: string) => void;
}

/** Connection a call goes through. */
export type Scope = 'public' | 'private';
/** Event listener. */
export type Listener<T> = (value: T) => void;

export interface RealtimeClient {
  /** Public connection, or `null` when disabled. */
  readonly public: Socket | null;
  /** Private connection, or `null` when not opened. */
  readonly private: Socket | null;
  /** Subscribes to notifications from both connections, deduplicated by id. */
  onNotification: (listener: Listener<Notification>) => () => void;
  rooms: {
    /**
     * Joins through the private connection when connected, otherwise the public one.
     * The room is joined again after every reconnection until `leave()` is called or the
     * server refuses it.
     */
    join: (room: string) => Promise<{ room: string }>;
    leave: (room: string) => Promise<{ room: string }>;
  };
  chat: {
    send: <T = Record<string, unknown>>(
      to: string,
      input: Omit<ChatSendInput<T>, 'to'>,
    ) => Promise<ChatMessage<T>>;
    onMessage: (listener: Listener<ChatMessage>) => () => void;
    typing: (to: string, typing: boolean) => void;
    onTyping: (listener: Listener<{ from: string; typing: boolean }>) => () => void;
  };
  /** Calls a handler registered with `rt.on()` and unwraps its ack. */
  call: <Result = unknown>(
    event: string,
    data?: unknown,
    options?: { scope?: Scope },
  ) => Promise<Result>;
  /** Asks for a fresh token and sends it with `auth:refresh`. */
  refresh: () => Promise<void>;
  /** Closes both connections. */
  close: () => void;
}

/** Runs a background task, ignoring failures: the next reconnection or refresh retries. */
const background = (task: () => Promise<unknown>): void => {
  void (async () => {
    try {
      await task();
    } catch {
      // Nothing to report to: callers observe the connection state instead.
    }
  })();
};
const joinUrl = (url: string, namespace: string): string =>
  namespace === '/' ? url : `${url.replace(/\/+$/, '')}${namespace}`;

/**
 * Connects to an express-realtime server.
 *
 * @example
 * ```ts
 * const rt = createRealtimeClient('https://api.example.com', { getToken: () => auth.token });
 * rt.onNotification((n) => toast(n.title, n.message));
 * await rt.rooms.join('lobby');
 * ```
 */
export const createRealtimeClient = (
  url: string,
  options: RealtimeClientOptions = {},
): RealtimeClient => {
  const ackTimeoutMs = options.ackTimeoutMs ?? 10_000;
  const dedupeSize = options.dedupeSize ?? 500;
  const publicNamespace = options.publicNamespace ?? '/';
  const connectPrivate = options.connectPrivate ?? options.getToken !== undefined;
  const auth = (callback: (data: object) => void): void => {
    void (async () => {
      let token: string | null | undefined;

      try {
        token = await options.getToken?.();
      } catch {
        token = null;
      }

      callback(token ? { token } : {});
    })();
  };
  const publicSocket =
    publicNamespace === false
      ? null
      : io(joinUrl(url, publicNamespace), { ...options.socketOptions, auth });
  const privateSocket = connectPrivate
    ? io(joinUrl(url, options.privateNamespace ?? '/private'), { ...options.socketOptions, auth })
    : null;
  const notificationListeners = new Set<Listener<Notification>>();
  const seen = new Set<string>();
  const onNotification = (notification: Notification): void => {
    if (seen.has(notification.id)) {
      return;
    }

    seen.add(notification.id);

    if (seen.size > dedupeSize) {
      const oldest = seen.values().next().value;

      if (oldest !== undefined) {
        seen.delete(oldest);
      }
    }

    for (const listener of notificationListeners) {
      listener(notification);
    }
  };
  const request = async <T>(
    socket: Socket | null,
    event: string,
    ...args: unknown[]
  ): Promise<T> => {
    if (!socket) {
      throw new RealtimeClientError('unauthorized');
    }

    let result: Ack<T>;

    try {
      result = (await socket.timeout(ackTimeoutMs).emitWithAck(event, ...args)) as Ack<T>;
    } catch {
      throw new RealtimeClientError('timeout');
    }

    if (!result.ok) {
      throw new RealtimeClientError(result.error, result.details);
    }

    return result.data;
  };
  const preferred = (): Socket | null =>
    privateSocket?.connected ? privateSocket : (publicSocket ?? privateSocket);
  // Rooms joined through `rooms.join()`, and the connection each one was joined on.
  const joined = new Map<string, Socket>();
  const joinRoom = async (room: string): Promise<{ room: string }> => {
    const socket = preferred();
    const result = await request<{ room: string }>(socket, EVENTS.roomJoin, room);

    if (socket) {
      joined.set(room, socket);
    }

    return result;
  };
  const leaveRoom = async (room: string): Promise<{ room: string }> => {
    const socket = joined.get(room) ?? preferred();

    joined.delete(room);

    return request(socket, EVENTS.roomLeave, room);
  };
  /** A new server session starts with no rooms: join them again, dropping the refused ones. */
  const rejoin = (socket: Socket): void => {
    for (const [room, owner] of joined) {
      if (owner !== socket) {
        continue;
      }

      background(async () => {
        try {
          await request(socket, EVENTS.roomJoin, room);
        } catch (error) {
          // A timeout is retried on the next reconnection; a refusal is final.
          if (error instanceof RealtimeClientError && error.code !== 'timeout') {
            joined.delete(room);
          }
        }
      });
    }
  };
  const refresh = async (): Promise<void> => {
    const token = await options.refreshToken?.();

    if (!token || !privateSocket?.connected) {
      return;
    }

    await request(privateSocket, EVENTS.authRefresh, token);
  };

  // Reconnect after the server closed the namespace for a recoverable reason.
  let reconnectDelayMs = 0;
  let revoked = false;
  let closed = false;

  const watch = (socket: Socket, scope: Scope): void => {
    socket.on(EVENTS.notification, onNotification);
    socket.on('connect', () => {
      // A recovered session kept its rooms on the server.
      if (!socket.recovered) {
        rejoin(socket);
      }
    });
    socket.on(
      EVENTS.serverShutdown,
      (event: Parameters<ServerToClientEvents['server:shutdown']>[0]) => {
        reconnectDelayMs = event.reconnectInMs;
        socket.disconnect();
        setTimeout(() => {
          if (!closed && !revoked) {
            socket.connect();
          }
        }, reconnectDelayMs);
      },
    );
    socket.on('disconnect', (reason) => {
      if (reason === 'io server disconnect' && !closed && !revoked) {
        const reconnect = async (): Promise<void> => {
          if (scope === 'private') {
            await options.refreshToken?.();
          }

          socket.connect();
        };

        setTimeout(() => void reconnect(), reconnectDelayMs);
      }
    });
  };

  if (publicSocket) {
    watch(publicSocket, 'public');
  }

  if (privateSocket) {
    watch(privateSocket, 'private');
    privateSocket.on(EVENTS.authExpiring, () => {
      background(refresh);
    });
    privateSocket.on(EVENTS.sessionRevoked, (event: { reason?: string }) => {
      revoked = true;
      options.onSessionRevoked?.(event.reason);
    });
    let retriedHandshake = false;

    privateSocket.on('connect', () => {
      retriedHandshake = false;
    });
    privateSocket.on('connect_error', (error) => {
      // One retry with a fresh token; getToken() is called again by the auth callback.
      if (error.message === 'unauthorized' && options.refreshToken && !retriedHandshake) {
        retriedHandshake = true;
        const { refreshToken } = options;

        background(async () => {
          await refreshToken();
          privateSocket.connect();
        });
      }
    });
  }

  const subscribe = <T>(event: string, listener: Listener<T>): (() => void) => {
    privateSocket?.on(event, listener);

    return () => {
      privateSocket?.off(event, listener);
    };
  };

  return {
    public: publicSocket,
    private: privateSocket,
    onNotification: (listener) => {
      notificationListeners.add(listener);

      return () => {
        notificationListeners.delete(listener);
      };
    },
    rooms: {
      join: joinRoom,
      leave: leaveRoom,
    },
    chat: {
      send: (to, input) => request(privateSocket, EVENTS.chatSend, { ...input, to }),
      onMessage: (listener) => subscribe(EVENTS.chatMessage, listener),
      typing: (to, typing) => {
        // Volatile: a stale indicator is worse than none, so it is not buffered while offline.
        privateSocket?.volatile.emit(EVENTS.chatTyping, { to, typing });
      },
      onTyping: (listener) => subscribe(EVENTS.chatTyping, listener),
    },
    call: <Result = unknown>(
      event: string,
      data?: unknown,
      callOptions: { scope?: Scope } = {},
    ): Promise<Result> => {
      const socket =
        callOptions.scope === 'public'
          ? publicSocket
          : callOptions.scope === 'private'
            ? privateSocket
            : preferred();

      return data === undefined
        ? request<Result>(socket, event)
        : request<Result>(socket, event, data);
    },
    refresh,
    close: () => {
      closed = true;
      publicSocket?.disconnect();
      privateSocket?.disconnect();
    },
  };
};
