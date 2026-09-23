import type { Request, RequestHandler } from 'express';
import type { Notification, NotificationInput, NotificationSender } from './contract.js';
import type { NotificationService, NotifyTarget } from './notifications.js';
import type { Realtime } from './realtime.js';

/** What the middleware exposes on `req.realtime`. `notify` sets `from` to the request user. */
export interface RequestRealtime {
  notify: NotificationService;
  rooms: Pick<Realtime<unknown>['rooms'], 'join' | 'leave' | 'emit' | 'members'>;
  chat: Realtime<unknown>['chat'];
  disconnectUser: Realtime<unknown>['disconnectUser'];
  isOnline: Realtime<unknown>['isOnline'];
  io: Realtime<unknown>['io'];
}

/** Shortcut on `req.notify`. */
export type RequestNotify = <T = Record<string, unknown>>(
  target: NotifyTarget,
  input: NotificationInput<T>,
) => Notification<T>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express augmentation needs it
  namespace Express {
    interface Request {
      /** Realtime services added by `rt.middleware()`. */
      realtime: RequestRealtime;
      /** Sends a notification with `from` set to the request user. Added by `rt.middleware()`. */
      notify: RequestNotify;
    }
  }
}

/** Options for `rt.middleware()`. */
export interface RealtimeMiddlewareOptions<User> {
  /** Where the core's auth middleware stores the user. Default: `req.user`. */
  getUser?: (req: Request) => User | null | undefined;
}

export const createExpressMiddleware = <User>(
  rt: Realtime<User>,
  toSender: (user: User) => NotificationSender,
  options: RealtimeMiddlewareOptions<User> = {},
): RequestHandler => {
  const getUser =
    options.getUser ?? ((req: Request) => (req as Request & { user?: User | null }).user);

  return (req, _res, next) => {
    const user = getUser(req);
    const notify = rt.notify.from(user ? toSender(user) : undefined);

    req.realtime = {
      notify,
      rooms: rt.rooms,
      chat: rt.chat,
      disconnectUser: (userId, reason) => {
        rt.disconnectUser(userId, reason);
      },
      isOnline: (userId) => rt.isOnline(userId),
      io: rt.io,
    };
    req.notify = (target, input) => notify.send(target, input);
    next();
  };
};
