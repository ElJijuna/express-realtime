import type { Broadcaster, BroadcastScope } from './notifications.js';
import type { Observability } from './observability.js';
import type { RateLimitRule } from './rate-limit.js';
import type { AnyNamespace, AnyServer, RealtimeOptions } from './types.js';

/** State shared by the library modules. Internal. */
export interface RealtimeContext<User> {
  io: AnyServer;
  publicNsp: AnyNamespace | null;
  privateNsp: AnyNamespace;
  options: RealtimeOptions<User>;
  obs: Observability;
  state: { closing: boolean };
  /** Events whose rate limit falls back to `rateLimit.default`. */
  managedEvents: Set<string>;
  /** Rate limit rules declared per handler with `rt.on()`. */
  handlerRules: Map<string, RateLimitRule | false>;
}

export const namespacesFor = <User>(
  ctx: RealtimeContext<User>,
  scope: BroadcastScope,
): AnyNamespace[] => {
  const list =
    scope === 'both'
      ? [ctx.publicNsp, ctx.privateNsp]
      : scope === 'public'
        ? [ctx.publicNsp]
        : [ctx.privateNsp];

  return list.filter((nsp): nsp is AnyNamespace => nsp !== null);
};

/** Broadcaster over the core's Socket.io server. Works across pods through its adapter. */
export const createServerBroadcaster = <User>(ctx: RealtimeContext<User>): Broadcaster => ({
  emit(scope, rooms, except, event, payload) {
    for (const nsp of namespacesFor(ctx, scope)) {
      let operator = rooms ? nsp.to(rooms) : nsp.except([]);

      if (except.length > 0) {
        operator = operator.except(except);
      }

      operator.emit(event, payload);
    }
  },
});
