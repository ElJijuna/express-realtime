import { randomUUID } from 'node:crypto';
import type {
  Notification,
  NotificationInput,
  NotificationLevel,
  NotificationSender,
} from './contract.js';
import { RealtimeValidationError } from './errors.js';
import { EVENTS, roleRoom, userRoom } from './events.js';
import type { Observability } from './observability.js';

/** Length limits applied to notifications. */
export interface NotificationLimits {
  /** Default: 200. */
  titleMaxLength?: number;
  /** Default: 2000. */
  messageMaxLength?: number;
}

const LEVELS: ReadonlySet<NotificationLevel> = new Set(['info', 'success', 'warning', 'error']);
const toIsoDate = (value: NotificationInput['date']): string => {
  if (value === undefined) {
    return new Date().toISOString();
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new RealtimeValidationError('notification.date is not a valid date');
  }

  return date.toISOString();
};
const requireText = (value: unknown, field: string, maxLength: number): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RealtimeValidationError(`notification.${field} is required`);
  }

  if (value.length > maxLength) {
    throw new RealtimeValidationError(`notification.${field} exceeds ${String(maxLength)} chars`);
  }

  return value;
};

/**
 * Validates a notification input and fills the defaults (`id`, `type`, `level`, `date`).
 *
 * @throws {@link RealtimeValidationError} when `title` or `message` are missing or too long,
 * or when `level` or `date` are invalid.
 */
export const normalizeNotification = <T = Record<string, unknown>>(
  input: NotificationInput<T>,
  limits: NotificationLimits = {},
): Notification<T> => {
  if (typeof input !== 'object' || input === null) {
    throw new RealtimeValidationError('notification must be an object');
  }

  const level = input.level ?? 'info';

  if (!LEVELS.has(level)) {
    throw new RealtimeValidationError(
      `notification.level must be one of ${[...LEVELS].join(', ')}`,
    );
  }

  const notification: Notification<T> = {
    id: input.id ?? randomUUID(),
    type: input.type ?? 'generic',
    level,
    title: requireText(input.title, 'title', limits.titleMaxLength ?? 200),
    message: requireText(input.message, 'message', limits.messageMaxLength ?? 2000),
    date: toIsoDate(input.date),
  };

  if (input.icon !== undefined) {
    notification.icon = input.icon;
  }

  if (input.link !== undefined) {
    notification.link = input.link;
  }

  if (input.from !== undefined) {
    notification.from = input.from;
  }

  if (input.data !== undefined) {
    notification.data = input.data;
  }

  return notification;
};

/** Namespace a broadcast goes to. Rooms may have members in both namespaces. */
export type BroadcastScope = 'public' | 'private' | 'both';

/**
 * Transport used by {@link NotificationService}. Implemented over a Socket.io `Server`
 * and over a `@socket.io/redis-emitter` `Emitter`.
 */
export interface Broadcaster {
  /** `rooms: null` targets the whole namespace. */
  emit(
    scope: BroadcastScope,
    rooms: string[] | null,
    except: string[],
    event: string,
    payload: unknown,
  ): void;
}

/** A user id as accepted by the API; it is always converted to a string. */
export type Id = string | number;
const toArray = <V>(value: V | V[] | undefined): V[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** Who receives a notification. Every field is optional and they can be combined. */
export interface NotifyTarget {
  /** Every socket (tab or device) of these users. */
  user?: Id | Id[];
  /** Members of these rooms, in both namespaces. */
  room?: string | string[];
  /** Users that joined `role:{name}` through `getUserRooms`. */
  role?: string | string[];
  /** Everyone connected to the private namespace, the public one, or both. */
  broadcast?: 'private' | 'public' | 'all';
}

/**
 * Sends notifications on the `notification` event.
 *
 * Instances are immutable: {@link NotificationService.except} and {@link NotificationService.from}
 * return a new service.
 */
export class NotificationService {
  readonly #broadcaster: Broadcaster;
  readonly #limits: NotificationLimits;
  readonly #observability: Observability | undefined;
  readonly #except: readonly string[];
  readonly #sender: NotificationSender | undefined;

  /** @internal */
  constructor(
    broadcaster: Broadcaster,
    limits: NotificationLimits = {},
    observability?: Observability,
    except: readonly string[] = [],
    sender?: NotificationSender,
  ) {
    this.#broadcaster = broadcaster;
    this.#limits = limits;
    this.#observability = observability;
    this.#except = except;
    this.#sender = sender;
  }

  /** Returns a service that skips every socket of these users. */
  except(...userIds: Id[]): NotificationService {
    return new NotificationService(
      this.#broadcaster,
      this.#limits,
      this.#observability,
      [...this.#except, ...userIds.map(userRoom)],
      this.#sender,
    );
  }

  /** Returns a service that sets `from` on every notification it sends. */
  from(sender: NotificationSender | undefined): NotificationService {
    return new NotificationService(
      this.#broadcaster,
      this.#limits,
      this.#observability,
      this.#except,
      sender,
    );
  }

  /** Sends one notification to any combination of users, rooms, roles and broadcasts. */
  send<T = Record<string, unknown>>(
    target: NotifyTarget,
    input: NotificationInput<T>,
  ): Notification<T> {
    const notification = normalizeNotification(
      this.#sender && input.from === undefined ? { ...input, from: this.#sender } : input,
      this.#limits,
    );
    const except = [...this.#except];
    const privateRooms = [
      ...toArray(target.user).map(userRoom),
      ...toArray(target.role).map(roleRoom),
    ];
    const sharedRooms = toArray(target.room);
    const emit = (scope: BroadcastScope, rooms: string[] | null): void => {
      this.#broadcaster.emit(scope, rooms, except, EVENTS.notification, notification);
    };

    if (target.broadcast === 'all') {
      emit('both', null);
    } else if (target.broadcast) {
      emit(target.broadcast, null);

      // A private broadcast already reaches every private room; public rooms still need a pass.
      if (target.broadcast === 'private' && sharedRooms.length > 0) {
        emit('public', sharedRooms);
      }

      if (target.broadcast === 'public' && privateRooms.length + sharedRooms.length > 0) {
        emit('private', [...privateRooms, ...sharedRooms]);
      }
    } else {
      // One emit per namespace so a socket in several target rooms receives it once.
      if (privateRooms.length + sharedRooms.length > 0) {
        emit('private', [...privateRooms, ...sharedRooms]);
      }

      if (sharedRooms.length > 0) {
        emit('public', sharedRooms);
      }
    }

    this.#observability?.metric('notification', {
      type: notification.type,
      targets: privateRooms.length + sharedRooms.length,
    });

    return notification;
  }

  /** Every socket of one or several users. */
  user<T = Record<string, unknown>>(
    userId: Id | Id[],
    input: NotificationInput<T>,
  ): Notification<T> {
    return this.send({ user: userId }, input);
  }

  /** Members of one or several rooms. */
  room<T = Record<string, unknown>>(
    room: string | string[],
    input: NotificationInput<T>,
  ): Notification<T> {
    return this.send({ room }, input);
  }

  /** Users that joined `role:{name}`. */
  role<T = Record<string, unknown>>(
    role: string | string[],
    input: NotificationInput<T>,
  ): Notification<T> {
    return this.send({ role }, input);
  }

  /** Every authenticated socket. */
  broadcastPrivate<T = Record<string, unknown>>(input: NotificationInput<T>): Notification<T> {
    return this.send({ broadcast: 'private' }, input);
  }

  /** Every socket in the public namespace. */
  broadcastPublic<T = Record<string, unknown>>(input: NotificationInput<T>): Notification<T> {
    return this.send({ broadcast: 'public' }, input);
  }
}
