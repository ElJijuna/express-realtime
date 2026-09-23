import type { DefaultEventsMap, Namespace, Server, Socket } from 'socket.io';
import type { ChatMessage, NotificationInput } from './contract.js';
import type { NotificationLimits } from './notifications.js';
import type {
  ErrorContext,
  RealtimeLogger,
  RealtimeMetrics,
  SocketScope,
} from './observability.js';
import type { RateLimitOptions, RateLimitRule } from './rate-limit.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- the core may type its server with any event maps */
/** Any Socket.io server, whatever event maps the core typed it with. */
// biome-ignore lint/suspicious/noExplicitAny: the core may type its server with any event maps
export type AnyServer = Server<any, any, any, any>;
/** Any Socket.io namespace. */
// biome-ignore lint/suspicious/noExplicitAny: see AnyServer
export type AnyNamespace = Namespace<any, any, any, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Socket.io handshake passed to `authenticate`. */
export type Handshake = Socket['handshake'];

/** What the library stores in `socket.data`. */
export interface RealtimeSocketData<User> {
  user: User | null;
  userId: string | null;
  scope: SocketScope;
  /** Extra rooms resolved by `getUserRooms` during the handshake. */
  autoRooms?: string[];
}

/** Socket as seen by library callbacks. */
export type RealtimeSocket<User = unknown> = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  RealtimeSocketData<User>
>;

/** A value or a promise of it. */
export type MaybePromise<T> = T | Promise<T>;

/** Context passed to welcome and announce resolvers. */
export interface WelcomeContext<User> {
  user: User;
  userId: string | null;
  socket: RealtimeSocket<User>;
  scope: SocketScope;
  /** Set for room welcomes and announcements. */
  room?: string;
}

/**
 * Welcome message: a static notification or a function that builds one.
 * Returning `null` or `undefined` sends nothing.
 */
export type WelcomeEntry<User> =
  | NotificationInput
  | ((ctx: WelcomeContext<User>) => MaybePromise<NotificationInput | null | undefined>);

/** Access rule for a room declared with `rt.rooms.define()`. */
export interface RoomDefinition<User> {
  /** `public`: anyone, including guests in the public namespace. `private`: authenticated only. */
  access: 'public' | 'private';
  /** Extra check. Defaults to allowing everyone that satisfies `access`. */
  canJoin?: (
    user: User | null,
    room: string,
    socket: RealtimeSocket<User>,
  ) => MaybePromise<boolean>;
  /** Sent only to the socket that joins. */
  welcome?: WelcomeEntry<User | null>;
  /** Sent to the other members when someone joins. */
  announce?: WelcomeEntry<User | null>;
}

/** Context received by chat hooks. */
export interface ChatContext<User> {
  /** Sender, or `null` when the message was sent server-side with `rt.chat.send()`. */
  user: User | null;
  /** Socket that sent the message, or `null` for server-side sends. */
  socket: RealtimeSocket<User> | null;
}

/** Context received by handlers registered with `rt.on()`. */
export interface HandlerContext<User, Data> {
  data: Data;
  user: User | null;
  userId: string | null;
  socket: RealtimeSocket<User>;
}

/** Options for handlers registered with `rt.on()`. */
export interface HandlerOptions<Data> {
  /**
   * Validates and parses the raw payload. Throw to reject it, e.g. pass `schema.parse` from zod.
   * The thrown error's `issues` (zod) or message is returned as `details`.
   */
  validate?: (input: unknown) => Data;
  /** Rate limit for this event. Overrides `rateLimit.default`. */
  rateLimit?: RateLimitRule | false;
}

/** Options for {@link createRealtime}. */
export interface RealtimeOptions<User> {
  /**
   * Resolves the user from the handshake. Return `null` to reject private connections.
   * The same callback authenticates `auth:refresh`, receiving the new token in `handshake.auth.token`.
   */
  authenticate: (handshake: Handshake) => MaybePromise<User | null | undefined>;
  /** Stable id of the user. Used for `user:{id}` rooms and chat. */
  getUserId: (user: User) => string | number;
  /** Display name used as `from.name` in notifications. */
  getUserName?: (user: User) => string | undefined;
  /** Rooms the user joins automatically, e.g. `role:admin` or `team:42`. */
  getUserRooms?: (user: User) => MaybePromise<string[]>;
  /**
   * Token expiry as a Date or epoch ms. When set, the server emits `auth:expiring` before it
   * and disconnects with `auth:expired` unless the client sends `auth:refresh` in time.
   */
  getTokenExpiry?: (user: User, handshake: Handshake) => Date | number | null | undefined;
  /** How long before expiry `auth:expiring` is sent. Default: 60 000 ms. */
  expiryWarningMs?: number;

  /** Public namespace, or `false` to disable it. Default: `/`. */
  publicNamespace?: string | false;
  /** Private namespace. Default: `/private`. */
  privateNamespace?: string;

  /** Fallback for rooms that were not declared with `rt.rooms.define()`. Default: deny. */
  canJoinRoom?: (
    user: User | null,
    room: string,
    socket: RealtimeSocket<User>,
  ) => MaybePromise<boolean>;
  /** Maximum room name length. Default: 128. */
  roomNameMaxLength?: number;

  /** Welcome notifications sent on connection. */
  welcome?: {
    public?: WelcomeEntry<User | null>;
    private?: WelcomeEntry<User>;
  };

  /** Enables `chat:send` and `chat:typing`. Default: true. */
  chat?: boolean;
  /** Maximum chat text length. Default: 4000. */
  chatMaxLength?: number;
  /** Authorizes a conversation, e.g. to block users. Default: allow. */
  canChat?: (from: User, toUserId: string) => MaybePromise<boolean>;
  /** Awaited before a chat message is emitted, e.g. to persist it. Throw to reject the message. */
  onChatMessage?: (message: ChatMessage, ctx: ChatContext<User>) => MaybePromise<void>;

  /** Per-socket rate limit, or `false` to disable it. */
  rateLimit?: RateLimitOptions | false;
  /** Notification length limits. */
  limits?: NotificationLimits;

  /**
   * Sync hot configuration changes (`rt.welcome.set`, `rt.rooms.update`) across pods with
   * `serverSideEmit`. Default: enabled when the adapter is not the in-memory one.
   */
  clusterSync?: boolean;

  logger?: RealtimeLogger;
  metrics?: RealtimeMetrics;
  onError?: (error: unknown, context: ErrorContext) => void;

  /** Called after the library set up a socket (rooms joined, welcome sent). */
  onConnect?: (socket: RealtimeSocket<User>) => void;
  onDisconnect?: (socket: RealtimeSocket<User>, reason: string) => void;
}
