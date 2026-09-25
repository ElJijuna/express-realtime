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
  /** Opens the private connection on creation. Default: true when `getToken` is set. See `login()`. */
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
/**
 * State of the client as a whole:
 * - `connecting`: before the first connection.
 * - `connected`: every connection that is still in use is connected.
 * - `reconnecting`: a connection dropped and the client is getting it back.
 * - `offline`: `close()` was called, or no connection will come back on its own
 *   (revoked session, rejected handshake, reconnection attempts exhausted).
 *
 * A connection that is given up (e.g. `/private` after `session:revoked`) stops counting
 * while the other one is still in use.
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';
/** Passed to `onReconnect()` listeners. */
export interface ReconnectInfo {
  /**
   * True when every dropped connection recovered its server session (connection state
   * recovery), so the events sent meanwhile were replayed. When false, refetch what the
   * UI shows: the library keeps no history.
   */
  recovered: boolean;
}
/** Event listener. */
export type Listener<T> = (value: T) => void;
/** Listener for a custom server event: receives every argument the server emitted. */
export type EventListener<Args extends unknown[] = unknown[]> = (...args: Args) => void;

export interface OnOptions {
  /** Listen on this connection only. Default: both. */
  scope?: Scope;
}

/** A room joined with `rooms.join()`. */
export interface JoinedRoom {
  readonly room: string;
  /**
   * Listens to a server event on the connection that joined the room, until `leave()`.
   *
   * Socket.io does not tag events with the room they were sent to, so an event with the same
   * name sent to another room this client is in also arrives here. Use distinct event names per
   * room type, or include the room in the payload.
   */
  on: <Args extends unknown[] = unknown[]>(
    event: string,
    listener: EventListener<Args>,
  ) => () => void;
  /** Leaves the room and removes the listeners added with `on()`. */
  leave: () => Promise<{ room: string }>;
}

export interface RealtimeClient {
  /** Public connection, or `null` when disabled. */
  readonly public: Socket | null;
  /** Private connection, or `null` while logged out. */
  readonly private: Socket | null;
  /** True between `login()` (or `connectPrivate`) and `logout()` or a revoked session. */
  readonly loggedIn: boolean;
  /**
   * Opens the private connection, e.g. after the user signs in. Resolves once connected and
   * rejects with a `RealtimeClientError` when the server refuses the token. Pass `getToken` to
   * replace the one given in the options. Does nothing when already logged in.
   */
  login: (getToken?: RealtimeClientOptions['getToken']) => Promise<void>;
  /**
   * Closes the private connection and keeps the public one. Rooms joined through the private
   * connection are forgotten. Listeners (`chat.onMessage`, ...) are kept for the next `login()`.
   */
  logout: () => void;
  /** Current connection status. */
  readonly status: ConnectionStatus;
  /** Called whenever `status` changes. */
  onStatusChange: (listener: Listener<ConnectionStatus>) => () => void;
  /** Called when the client is connected again after `reconnecting` or `offline`. */
  onReconnect: (listener: Listener<ReconnectInfo>) => () => void;
  /** Subscribes to notifications from both connections, deduplicated by id. */
  onNotification: (listener: Listener<Notification>) => () => void;
  rooms: {
    /**
     * Joins through the private connection when connected, otherwise the public one.
     * The room is joined again after every reconnection until `leave()` is called or the
     * server refuses it.
     */
    join: (room: string) => Promise<JoinedRoom>;
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
  /**
   * Listens to a server event, e.g. one sent with `rt.rooms.emit()` or the core's own `io`.
   * Listeners are kept across reconnections, `logout()` and `login()`. When the server emits
   * the same event on both namespaces, it arrives twice unless `scope` is set.
   */
  on: <Args extends unknown[] = unknown[]>(
    event: string,
    listener: EventListener<Args>,
    options?: OnOptions,
  ) => () => void;
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
/** Emitted by socket.io-client itself: observe them with `onStatusChange()`. */
const CONNECTION_EVENTS = new Set([
  'connect',
  'connect_error',
  'disconnect',
  'disconnecting',
  'newListener',
  'removeListener',
]);
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

  let { getToken } = options;

  const auth = (callback: (data: object) => void): void => {
    void (async () => {
      let token: string | null | undefined;

      try {
        token = await getToken?.();
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
  // Created up front so listeners survive login() and logout(); it connects only when logged in.
  const privateSocket = io(joinUrl(url, options.privateNamespace ?? '/private'), {
    ...options.socketOptions,
    autoConnect: connectPrivate && (options.socketOptions?.autoConnect ?? true),
    auth,
  });

  let loggedIn = connectPrivate;

  const sessionSocket = (): Socket | null => (loggedIn ? privateSocket : null);
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
    privateSocket.connected && loggedIn ? privateSocket : (publicSocket ?? sessionSocket());
  const on = <Args extends unknown[]>(
    event: string,
    listener: EventListener<Args>,
    onOptions: OnOptions = {},
  ): (() => void) => {
    if (CONNECTION_EVENTS.has(event)) {
      throw new Error(`express-realtime: "${event}" is a connection event, use onStatusChange()`);
    }

    const sockets = [
      onOptions.scope === 'private' ? null : publicSocket,
      onOptions.scope === 'public' ? null : privateSocket,
    ].filter((socket): socket is Socket => socket !== null);

    for (const socket of sockets) {
      socket.on(event, listener);
    }

    return () => {
      for (const socket of sockets) {
        socket.off(event, listener);
      }
    };
  };
  // Rooms joined through `rooms.join()`, and the connection each one was joined on.
  const joined = new Map<string, Socket>();
  const leaveRoom = async (room: string): Promise<{ room: string }> => {
    const socket = joined.get(room) ?? preferred();

    joined.delete(room);

    return request(socket, EVENTS.roomLeave, room);
  };
  const joinRoom = async (room: string): Promise<JoinedRoom> => {
    const socket = preferred();

    await request<{ room: string }>(socket, EVENTS.roomJoin, room);

    if (socket) {
      joined.set(room, socket);
    }

    const scope: Scope = socket === privateSocket ? 'private' : 'public';
    const listeners = new Set<() => void>();

    return {
      room,
      on: (event, listener) => {
        const off = on(event, listener, { scope });
        const remove = (): void => {
          off();
          listeners.delete(remove);
        };

        listeners.add(remove);

        return remove;
      },
      leave: () => {
        for (const remove of listeners) {
          remove();
        }

        return leaveRoom(room);
      },
    };
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

    if (!token || !loggedIn || !privateSocket.connected) {
      return;
    }

    await request(privateSocket, EVENTS.authRefresh, token);
  };

  // Reconnect after the server closed the namespace for a recoverable reason.
  let reconnectDelayMs = 0;
  let closed = false;

  /** Whether the library should keep a connection of this scope open. */
  const wanted = (scope: Scope): boolean => !closed && (scope === 'public' || loggedIn);

  interface Connection {
    state: ConnectionStatus;
    everConnected: boolean;
    // Disconnected on purpose by the library, which connects it again.
    resuming: boolean;
    // Last handshake error, reported by login().
    error?: string;
    // Notified on every state change while login() waits.
    settle?: () => void;
  }

  const connections: Connection[] = [];
  const statusListeners = new Set<Listener<ConnectionStatus>>();
  const reconnectListeners = new Set<Listener<ReconnectInfo>>();

  let status: ConnectionStatus = 'connecting';
  let everConnected = false;
  // A connection came back without its server session since the last `connected` status.
  let missedEvents = false;

  const updateStatus = (): void => {
    const previous = status;
    const live = connections.filter((connection) => connection.state !== 'offline');
    const next: ConnectionStatus =
      closed || live.length === 0
        ? 'offline'
        : live.some((connection) => connection.state === 'reconnecting')
          ? 'reconnecting'
          : live.some((connection) => connection.state === 'connecting')
            ? 'connecting'
            : 'connected';

    if (next === status) {
      return;
    }

    status = next;

    for (const listener of statusListeners) {
      listener(next);
    }

    if (next !== 'connected') {
      return;
    }

    // Coming back from `connecting` (first connection, login) is not a reconnection.
    if (everConnected && previous !== 'connecting') {
      const info = { recovered: !missedEvents };

      for (const listener of reconnectListeners) {
        listener(info);
      }
    }

    everConnected = true;
    missedEvents = false;
  };
  const setState = (connection: Connection, state: ConnectionStatus): void => {
    connection.state = state;
    connection.settle?.();
    updateStatus();
  };
  const watch = (socket: Socket, scope: Scope): Connection => {
    const connection: Connection = {
      state: wanted(scope) ? 'connecting' : 'offline',
      everConnected: false,
      resuming: false,
    };

    // Retry a rejected handshake once with a fresh token; getToken() is called again.
    let retriedHandshake = false;

    connections.push(connection);
    socket.on(EVENTS.notification, onNotification);
    socket.on('connect', () => {
      // A recovered session kept its rooms on the server.
      if (!socket.recovered) {
        rejoin(socket);
      }

      if (connection.everConnected && !socket.recovered) {
        missedEvents = true;
      }

      connection.everConnected = true;
      connection.resuming = false;
      retriedHandshake = false;
      setState(connection, 'connected');
    });
    socket.on('connect_error', (error) => {
      connection.error = error.message;

      if (
        scope === 'private' &&
        error.message === 'unauthorized' &&
        options.refreshToken &&
        !retriedHandshake
      ) {
        retriedHandshake = true;
        const { refreshToken } = options;

        background(async () => {
          try {
            await refreshToken();
          } catch {
            loggedIn = false;
            setState(connection, 'offline');

            return;
          }

          if (wanted(scope)) {
            socket.connect();
          }
        });

        return;
      }

      // An inactive socket was rejected by the server and does not retry on its own.
      if (!socket.active) {
        if (scope === 'private') {
          loggedIn = false;
        }

        setState(connection, 'offline');
      }
    });
    socket.io.on('reconnect_failed', () => {
      setState(connection, 'offline');
    });
    socket.on(
      EVENTS.serverShutdown,
      (event: Parameters<ServerToClientEvents['server:shutdown']>[0]) => {
        reconnectDelayMs = event.reconnectInMs;
        connection.resuming = true;
        socket.disconnect();
        setTimeout(() => {
          if (wanted(scope)) {
            socket.connect();
          }
        }, reconnectDelayMs);
      },
    );
    socket.on('disconnect', (reason) => {
      const givenUp = !wanted(scope) || (reason === 'io client disconnect' && !connection.resuming);

      setState(connection, givenUp ? 'offline' : 'reconnecting');

      if (reason === 'io server disconnect' && !givenUp) {
        connection.resuming = true;

        const reconnect = async (): Promise<void> => {
          if (scope === 'private') {
            try {
              await options.refreshToken?.();
            } catch {
              // Reconnect anyway: a rejected handshake gets its own retry.
            }
          }

          if (wanted(scope)) {
            socket.connect();
          }
        };

        setTimeout(() => void reconnect(), reconnectDelayMs);
      }
    });

    return connection;
  };

  if (publicSocket) {
    watch(publicSocket, 'public');
  }

  const session = watch(privateSocket, 'private');
  /** Forgets the private session: its rooms, its recovery state and a pending login(). */
  const endSession = (): void => {
    loggedIn = false;
    session.everConnected = false;
    session.resuming = false;

    for (const [room, owner] of joined) {
      if (owner === privateSocket) {
        joined.delete(room);
      }
    }
  };

  let pendingLogin: Promise<void> | null = null;

  const login = (nextGetToken?: RealtimeClientOptions['getToken']): Promise<void> => {
    if (closed) {
      return Promise.reject(new RealtimeClientError('closed'));
    }

    if (nextGetToken) {
      getToken = nextGetToken;
    }

    if (pendingLogin) {
      return pendingLogin;
    }

    if (loggedIn && privateSocket.connected) {
      return Promise.resolve();
    }

    loggedIn = true;
    session.error = undefined;
    pendingLogin = new Promise<void>((resolve, reject) => {
      session.settle = () => {
        if (session.state === 'connected') {
          resolve();
        } else if (session.state === 'offline') {
          reject(new RealtimeClientError(session.error ?? 'offline'));
        } else {
          return;
        }

        session.settle = undefined;
        pendingLogin = null;
      };
    });
    setState(session, 'connecting');

    if (!privateSocket.active) {
      privateSocket.connect();
    }

    return pendingLogin;
  };
  const logout = (): void => {
    endSession();
    session.error = 'logged_out';
    privateSocket.disconnect();
    // A socket that never connected emits no `disconnect`.
    setState(session, 'offline');
  };

  privateSocket.on(EVENTS.authExpiring, () => {
    background(refresh);
  });
  privateSocket.on(EVENTS.sessionRevoked, (event: { reason?: string }) => {
    endSession();
    session.error = 'session_revoked';
    options.onSessionRevoked?.(event.reason);
  });
  // No connection in use, e.g. no public namespace and logged out.
  updateStatus();

  const subscribe = <T>(event: string, listener: Listener<T>): (() => void) => {
    privateSocket.on(event, listener);

    return () => {
      privateSocket.off(event, listener);
    };
  };

  return {
    public: publicSocket,
    get private() {
      return sessionSocket();
    },
    get loggedIn() {
      return loggedIn;
    },
    login,
    logout,
    get status() {
      return status;
    },
    onStatusChange: (listener) => {
      statusListeners.add(listener);

      return () => {
        statusListeners.delete(listener);
      };
    },
    onReconnect: (listener) => {
      reconnectListeners.add(listener);

      return () => {
        reconnectListeners.delete(listener);
      };
    },
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
      send: (to, input) => request(sessionSocket(), EVENTS.chatSend, { ...input, to }),
      onMessage: (listener) => subscribe(EVENTS.chatMessage, listener),
      typing: (to, typing) => {
        // Volatile: a stale indicator is worse than none, so it is not buffered while offline.
        sessionSocket()?.volatile.emit(EVENTS.chatTyping, { to, typing });
      },
      onTyping: (listener) => subscribe(EVENTS.chatTyping, listener),
    },
    on,
    call: <Result = unknown>(
      event: string,
      data?: unknown,
      callOptions: { scope?: Scope } = {},
    ): Promise<Result> => {
      const socket =
        callOptions.scope === 'public'
          ? publicSocket
          : callOptions.scope === 'private'
            ? sessionSocket()
            : preferred();

      return data === undefined
        ? request<Result>(socket, event)
        : request<Result>(socket, event, data);
    },
    refresh,
    close: () => {
      closed = true;
      session.error = 'closed';
      publicSocket?.disconnect();
      privateSocket.disconnect();
      // A socket that never connected emits no `disconnect`; this also rejects a pending login().
      setState(session, 'offline');
    },
  };
};
