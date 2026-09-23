import { withAck } from './ack.js';
import type { RealtimeContext } from './context.js';
import { RealtimeValidationError } from './errors.js';
import { EVENTS } from './events.js';
import type { HandlerContext, HandlerOptions, MaybePromise, RealtimeSocket } from './types.js';

/** Namespaces a handler listens on. */
export type HandlerScope = 'public' | 'private' | 'both';

/** Handler context in the private namespace, where the user is always set. */
export interface PrivateHandlerContext<User, Data> extends HandlerContext<User, Data> {
  user: User;
  userId: string;
}

/** Registers socket event handlers with ack, validation, rate limit and error handling. */
export interface HandlerRegistry<User> {
  on<Data = unknown, Result = unknown>(
    scope: 'private',
    event: string,
    handler: (ctx: PrivateHandlerContext<User, Data>) => MaybePromise<Result>,
    options?: HandlerOptions<Data>,
  ): void;
  on<Data = unknown, Result = unknown>(
    scope: 'public' | 'both',
    event: string,
    handler: (ctx: HandlerContext<User, Data>) => MaybePromise<Result>,
    options?: HandlerOptions<Data>,
  ): void;
}

const RESERVED_EVENTS = new Set<string>([
  'connect',
  'connect_error',
  'disconnect',
  'disconnecting',
  'error',
  'newListener',
  'removeListener',
  ...Object.values(EVENTS),
]);

interface Entry<User> {
  scope: HandlerScope;
  event: string;
  handler: (ctx: HandlerContext<User, unknown>) => unknown;
  options: HandlerOptions<unknown>;
}

const validationDetails = (error: unknown): unknown => {
  if (typeof error === 'object' && error !== null && 'issues' in error) {
    return error.issues;
  }

  return error instanceof Error ? error.message : undefined;
};

export const createHandlers = <User>(
  ctx: RealtimeContext<User>,
): HandlerRegistry<User> & { attach(socket: RealtimeSocket<User>): void } => {
  const entries: Entry<User>[] = [];
  const matches = (entry: Entry<User>, socket: RealtimeSocket<User>): boolean =>
    entry.scope === 'both' || entry.scope === socket.data.scope;
  const register = (socket: RealtimeSocket<User>, entry: Entry<User>): void => {
    socket.on(
      entry.event,
      withAck(ctx, socket, entry.event, (raw) => {
        let data: unknown = raw;

        if (entry.options.validate) {
          try {
            data = entry.options.validate(raw);
          } catch (error) {
            throw new RealtimeValidationError(
              `invalid payload for ${entry.event}`,
              validationDetails(error),
            );
          }
        }

        return entry.handler({
          data,
          user: socket.data.user,
          userId: socket.data.userId,
          socket,
        });
      }),
    );
  };
  const registry = {
    on(
      scope: HandlerScope,
      event: string,
      handler: (ctx: never) => unknown,
      options: HandlerOptions<unknown> = {},
    ) {
      if (RESERVED_EVENTS.has(event)) {
        throw new Error(`express-realtime: "${event}" is reserved`);
      }

      const entry: Entry<User> = {
        scope,
        event,
        handler: handler as Entry<User>['handler'],
        options,
      };

      entries.push(entry);
      ctx.managedEvents.add(event);

      if (options.rateLimit !== undefined) {
        ctx.handlerRules.set(event, options.rateLimit);
      }

      // Sockets already connected to this pod get the handler too.
      const namespaces = [ctx.publicNsp, ctx.privateNsp].filter((nsp) => nsp !== null);

      for (const nsp of namespaces) {
        for (const socket of nsp.sockets.values() as Iterable<RealtimeSocket<User>>) {
          if (matches(entry, socket)) {
            register(socket, entry);
          }
        }
      }
    },

    attach(socket: RealtimeSocket<User>) {
      for (const entry of entries) {
        if (matches(entry, socket)) {
          register(socket, entry);
        }
      }
    },
  };

  return registry as HandlerRegistry<User> & { attach(socket: RealtimeSocket<User>): void };
};
