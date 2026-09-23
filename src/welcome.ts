import type { RealtimeContext } from './context.js';
import type { Notification, NotificationInput } from './contract.js';
import { EVENTS } from './events.js';
import { normalizeNotification } from './notifications.js';
import type { SocketScope } from './observability.js';
import type { Sync } from './sync.js';
import type { RealtimeSocket, WelcomeContext, WelcomeEntry } from './types.js';

/**
 * Resolves a welcome entry into a notification with `type: 'welcome'` by default.
 * Returns `null` when the entry is missing, returns nothing, or fails (the failure is reported).
 */
export const resolveWelcome = async <User, U>(
  ctx: RealtimeContext<User>,
  entry: WelcomeEntry<U> | undefined,
  welcomeCtx: WelcomeContext<U>,
  defaultType = 'welcome',
): Promise<Notification | null> => {
  if (!entry) {
    return null;
  }

  try {
    const input = typeof entry === 'function' ? await entry(welcomeCtx) : entry;

    if (!input) {
      return null;
    }

    return normalizeNotification({ type: defaultType, ...input }, ctx.options.limits);
  } catch (error) {
    ctx.obs.reportError(error, {
      scope: 'welcome',
      socketId: welcomeCtx.socket.id,
      userId: welcomeCtx.userId,
    });

    return null;
  }
};

/** Controls connection welcomes. Room welcomes live in `rt.rooms`. */
export interface WelcomeController {
  /**
   * Replaces the connection welcome of a namespace on every pod. Pass `null` to disable it.
   * Only static notifications can be synced; set functions in `createRealtime` options.
   */
  set(scope: SocketScope, value: NotificationInput | null): void;
}

export const createWelcome = <User>(
  ctx: RealtimeContext<User>,
  sync: Sync,
): WelcomeController & { onConnect(socket: RealtimeSocket<User>): Promise<void> } => {
  const entries: {
    public: WelcomeEntry<User | null> | undefined;
    private: WelcomeEntry<User> | undefined;
  } = {
    public: ctx.options.welcome?.public,
    private: ctx.options.welcome?.private,
  };
  const apply = (scope: SocketScope, value: NotificationInput | null): void => {
    entries[scope] = value ?? undefined;
  };

  sync.subscribe((message) => {
    if (message.kind === 'welcome') {
      apply(message.scope, message.value);
    }
  });

  return {
    set(scope, value) {
      if (value !== null) {
        normalizeNotification(value, ctx.options.limits);
      }

      apply(scope, value);
      sync.publish({ kind: 'welcome', scope, value });
    },

    async onConnect(socket) {
      // A recovered session already got its welcome before the temporary disconnection.
      if (socket.recovered) {
        return;
      }

      const { scope, user, userId } = socket.data;
      const notification =
        scope === 'private' && user !== null
          ? await resolveWelcome(ctx, entries.private, { user, userId, socket, scope })
          : await resolveWelcome(ctx, entries.public, { user, userId, socket, scope });

      if (notification && socket.connected) {
        socket.emit(EVENTS.notification, notification);
      }
    },
  };
};
