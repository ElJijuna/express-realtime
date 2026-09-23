import { performance } from 'node:perf_hooks';
import type { RealtimeContext } from './context.js';
import type { Ack } from './contract.js';
import { RealtimeError, toClientError } from './errors.js';
import type { RealtimeSocket } from './types.js';

type AckFn = (result: Ack) => void;

/**
 * Wraps a socket event handler: the resolved value becomes `{ ok: true, data }`, a thrown
 * {@link RealtimeError} becomes `{ ok: false, error: code }` and anything else becomes
 * `internal_error` and is reported through `onError`.
 */
export const withAck =
  <User>(
    ctx: RealtimeContext<User>,
    socket: RealtimeSocket<User>,
    event: string,
    handler: (...args: unknown[]) => unknown,
  ) =>
  async (...args: unknown[]): Promise<void> => {
    const last = args.at(-1);
    const ack = typeof last === 'function' ? (args.pop() as AckFn) : undefined;
    const startedAt = performance.now();

    let ok = true;

    try {
      const data = await handler(...args);

      ack?.({ ok: true, data });
    } catch (error) {
      ok = false;

      if (!(error instanceof RealtimeError)) {
        ctx.obs.reportError(error, {
          scope: 'handler',
          event,
          socketId: socket.id,
          userId: socket.data.userId,
        });
      }

      ack?.({ ok: false, ...toClientError(error) });
    } finally {
      ctx.obs.metric('event', {
        scope: socket.data.scope,
        event,
        ok,
        durationMs: performance.now() - startedAt,
      });
    }
  };
