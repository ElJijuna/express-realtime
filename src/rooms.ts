import { withAck } from './ack.js';
import { namespacesFor, type RealtimeContext } from './context.js';
import type { NotificationInput } from './contract.js';
import { RealtimeError } from './errors.js';
import { EVENTS, isReservedRoom, userRoom } from './events.js';
import { normalizeNotification } from './notifications.js';
import type { SocketScope } from './observability.js';
import type { Sync } from './sync.js';
import type { RealtimeSocket, RoomDefinition } from './types.js';
import { resolveWelcome } from './welcome.js';

/** A socket in a room, anywhere in the cluster. */
export interface RoomMember {
  socketId: string;
  userId: string | null;
  scope: SocketScope;
}

/** Static welcome and announce patch accepted by `rt.rooms.update()`. */
export interface RoomPatch {
  welcome?: NotificationInput | null;
  announce?: NotificationInput | null;
}

/** Room management. Every operation works across pods through the core's adapter. */
export interface RoomService<User> {
  /**
   * Declares a room or a pattern of rooms. `*` matches any sequence, e.g. `team:*`.
   * Exact names win over patterns; patterns are tried in definition order.
   */
  define(pattern: string, definition: RoomDefinition<User>): void;
  /** Changes the welcome or announce of a declared room on every pod. Static values only. */
  update(pattern: string, patch: RoomPatch): void;
  /** Adds every socket of a user to a room. Does not send the room welcome. */
  join(userId: string | number, room: string): void;
  /** Removes every socket of a user from a room. */
  leave(userId: string | number, room: string): void;
  /** Emits a custom event to the members of a room, in both namespaces. */
  emit(room: string, event: string, ...args: unknown[]): void;
  /** Lists the members of a room. Queries every pod: avoid calling it on every request. */
  members(room: string): Promise<RoomMember[]>;
}

interface Entry<User> {
  pattern: string;
  regex: RegExp | null;
  definition: RoomDefinition<User>;
}

const toRegex = (pattern: string): RegExp | null => {
  if (!pattern.includes('*')) {
    return null;
  }

  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');

  return new RegExp(`^${escaped}$`);
};

export const createRooms = <User>(
  ctx: RealtimeContext<User>,
  sync: Sync,
): RoomService<User> & { attach(socket: RealtimeSocket<User>): void } => {
  const exact = new Map<string, Entry<User>>();
  const patterns: Entry<User>[] = [];
  const maxLength = ctx.options.roomNameMaxLength ?? 128;
  const find = (room: string): Entry<User> | undefined =>
    exact.get(room) ?? patterns.find((entry) => entry.regex?.test(room));
  const byPattern = (pattern: string): Entry<User> | undefined =>
    exact.get(pattern) ?? patterns.find((entry) => entry.pattern === pattern);
  const applyPatch = (pattern: string, patch: RoomPatch): void => {
    const entry = byPattern(pattern);

    if (!entry) {
      return;
    }

    if (patch.welcome !== undefined) {
      entry.definition = { ...entry.definition, welcome: patch.welcome ?? undefined };
    }

    if (patch.announce !== undefined) {
      entry.definition = { ...entry.definition, announce: patch.announce ?? undefined };
    }
  };

  sync.subscribe((message) => {
    if (message.kind === 'room') {
      applyPatch(message.name, message.patch);
    }
  });

  const assertValidName = (room: unknown): string => {
    if (typeof room !== 'string' || room === '' || room.length > maxLength) {
      throw new RealtimeError('invalid_room');
    }

    if (isReservedRoom(room)) {
      throw new RealtimeError('forbidden', 'reserved room');
    }

    return room;
  };
  const canJoin = async (socket: RealtimeSocket<User>, room: string): Promise<boolean> => {
    const { user, scope } = socket.data;
    const entry = find(room);

    try {
      if (!entry) {
        return ctx.options.canJoinRoom ? await ctx.options.canJoinRoom(user, room, socket) : false;
      }

      if (entry.definition.access === 'private' && (scope !== 'private' || user === null)) {
        return false;
      }

      return entry.definition.canJoin ? await entry.definition.canJoin(user, room, socket) : true;
    } catch (error) {
      ctx.obs.reportError(error, {
        scope: 'room',
        event: EVENTS.roomJoin,
        socketId: socket.id,
        userId: socket.data.userId,
      });

      return false;
    }
  };
  const welcomeAndAnnounce = async (socket: RealtimeSocket<User>, room: string): Promise<void> => {
    const definition = find(room)?.definition;

    if (!definition) {
      return;
    }

    const { user, userId, scope } = socket.data;
    const welcomeCtx = { user, userId, socket, scope, room };
    const [welcome, announce] = await Promise.all([
      resolveWelcome(ctx, definition.welcome, welcomeCtx),
      resolveWelcome(ctx, definition.announce, welcomeCtx, 'room.join'),
    ]);

    if (welcome && socket.connected) {
      socket.emit(EVENTS.notification, welcome);
    }

    if (announce) {
      socket.to(room).emit(EVENTS.notification, announce);

      for (const nsp of namespacesFor(ctx, 'both')) {
        if (nsp !== socket.nsp) {
          nsp.to(room).emit(EVENTS.notification, announce);
        }
      }
    }
  };
  const service: RoomService<User> & { attach(socket: RealtimeSocket<User>): void } = {
    define(pattern, definition) {
      const entry: Entry<User> = { pattern, regex: toRegex(pattern), definition };

      if (entry.regex) {
        const index = patterns.findIndex((existing) => existing.pattern === pattern);

        if (index === -1) {
          patterns.push(entry);
        } else {
          patterns[index] = entry;
        }
      } else {
        exact.set(pattern, entry);
      }
    },

    update(pattern, patch) {
      if (!byPattern(pattern)) {
        throw new RealtimeError('invalid_room', `room "${pattern}" is not defined`);
      }

      for (const value of [patch.welcome, patch.announce]) {
        if (value) {
          normalizeNotification(value, ctx.options.limits);
        }
      }

      applyPatch(pattern, patch);
      sync.publish({ kind: 'room', name: pattern, patch });
    },

    join(userId, room) {
      ctx.privateNsp.in(userRoom(userId)).socketsJoin(room);
    },

    leave(userId, room) {
      ctx.privateNsp.in(userRoom(userId)).socketsLeave(room);
    },

    emit(room, event, ...args) {
      for (const nsp of namespacesFor(ctx, 'both')) {
        nsp.to(room).emit(event, ...args);
      }
    },

    async members(room) {
      const lists = await Promise.all(
        namespacesFor(ctx, 'both').map((nsp) => nsp.in(room).fetchSockets()),
      );

      return lists.flat().map((remote) => {
        const data = remote.data as { userId?: string | null; scope?: SocketScope };

        return {
          socketId: remote.id,
          userId: data.userId ?? null,
          scope: data.scope ?? 'public',
        };
      });
    },

    attach(socket) {
      socket.on(
        EVENTS.roomJoin,
        withAck(ctx, socket, EVENTS.roomJoin, async (raw) => {
          const room = assertValidName(raw);

          if (socket.rooms.has(room)) {
            return { room };
          }

          if (!(await canJoin(socket, room))) {
            throw new RealtimeError('forbidden');
          }

          await socket.join(room);
          await welcomeAndAnnounce(socket, room);

          return { room };
        }),
      );

      socket.on(
        EVENTS.roomLeave,
        withAck(ctx, socket, EVENTS.roomLeave, async (raw) => {
          const room = assertValidName(raw);

          await socket.leave(room);

          return { room };
        }),
      );
    },
  };

  return service;
};
