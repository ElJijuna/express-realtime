import { randomUUID } from 'node:crypto';
import type { ChatMessage } from './contract.js';
import { dmRoom, EVENTS, userRoom } from './events.js';
import { type Broadcaster, type NotificationLimits, NotificationService } from './notifications.js';

/** Structural subset of `@socket.io/redis-emitter`'s broadcast operator. */
export interface EmitterOperatorLike {
  to(room: string | string[]): EmitterOperatorLike;
  except(room: string | string[]): EmitterOperatorLike;
  emit(event: string, ...args: unknown[]): unknown;
  socketsJoin(room: string | string[]): void;
  socketsLeave(room: string | string[]): void;
  disconnectSockets(close?: boolean): void;
}

/** Structural subset of `@socket.io/redis-emitter`'s `Emitter`. */
export interface EmitterLike {
  of(namespace: string): EmitterOperatorLike & { in(room: string | string[]): EmitterOperatorLike };
}

export interface RealtimeEmitterOptions {
  /** Must match `createRealtime`. Default: `/`. Pass `false` if the public namespace is off. */
  publicNamespace?: string | false;
  /** Must match `createRealtime`. Default: `/private`. */
  privateNamespace?: string;
  limits?: NotificationLimits;
}

/** Realtime API for processes without a Socket.io server: workers, crons, queues. */
export interface RealtimeEmitter {
  notify: NotificationService;
  rooms: {
    join(userId: string | number, room: string): void;
    leave(userId: string | number, room: string): void;
    emit(room: string, event: string, ...args: unknown[]): void;
  };
  chat: {
    send<T = Record<string, unknown>>(
      from: string | number,
      to: string | number,
      input: { text: string; data?: T },
    ): ChatMessage<T>;
  };
  disconnectUser(userId: string | number, reason?: string): void;
}

/**
 * Wraps a `@socket.io/redis-emitter` `Emitter` with the same API as `rt.notify`.
 *
 * @example
 * ```ts
 * import { Emitter } from '@socket.io/redis-emitter';
 * const realtime = createRealtimeEmitter(new Emitter(redisClient));
 * realtime.notify.user('42', { title: 'Export ready', message: 'Download it now' });
 * ```
 */
export const createRealtimeEmitter = (
  emitter: EmitterLike,
  options: RealtimeEmitterOptions = {},
): RealtimeEmitter => {
  const privateNsp = emitter.of(options.privateNamespace ?? '/private');
  const publicNsp =
    options.publicNamespace === false ? null : emitter.of(options.publicNamespace ?? '/');
  const pick = (scope: 'public' | 'private' | 'both') =>
    (scope === 'both'
      ? [publicNsp, privateNsp]
      : scope === 'public'
        ? [publicNsp]
        : [privateNsp]
    ).filter((nsp) => nsp !== null);
  const broadcaster: Broadcaster = {
    emit(scope, rooms, except, event, payload) {
      for (const nsp of pick(scope)) {
        let operator: EmitterOperatorLike = rooms ? nsp.to(rooms) : nsp;

        if (except.length > 0) {
          operator = operator.except(except);
        }

        operator.emit(event, payload);
      }
    },
  };

  return {
    notify: new NotificationService(broadcaster, options.limits),
    rooms: {
      join(userId, room) {
        privateNsp.in(userRoom(userId)).socketsJoin(room);
      },
      leave(userId, room) {
        privateNsp.in(userRoom(userId)).socketsLeave(room);
      },
      emit(room, event, ...args) {
        for (const nsp of pick('both')) {
          nsp.to(room).emit(event, ...args);
        }
      },
    },
    chat: {
      send<T>(from: string | number, to: string | number, input: { text: string; data?: T }) {
        const message: ChatMessage<T> = {
          id: randomUUID(),
          conversationId: dmRoom(from, to),
          from: String(from),
          to: String(to),
          text: input.text,
          date: new Date().toISOString(),
        };

        if (input.data !== undefined) {
          message.data = input.data;
        }

        privateNsp.to([userRoom(from), userRoom(to)]).emit(EVENTS.chatMessage, message);

        return message;
      },
    },
    disconnectUser(userId, reason) {
      const room = userRoom(userId);

      privateNsp.to(room).emit(EVENTS.sessionRevoked, reason === undefined ? {} : { reason });
      privateNsp.in(room).disconnectSockets(false);
    },
  };
};
