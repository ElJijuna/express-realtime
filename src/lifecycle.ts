import type { RealtimeContext } from './context.js';
import { EVENTS } from './events.js';

/** Options for `rt.close()`. */
export interface CloseOptions {
  /** How long to wait for clients to leave by themselves. Default: 5000 ms. */
  timeoutMs?: number;
  /** Delay clients should wait before reconnecting, sent in `server:shutdown`. Default: 1000 ms. */
  reconnectInMs?: number;
  /** Also close the core's Socket.io server. Default: false. */
  closeIo?: boolean;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/**
 * Graceful shutdown for this pod: rejects new connections, asks local clients to reconnect
 * elsewhere, waits for them to leave and disconnects the rest.
 */
export const closeRealtime = async <User>(
  ctx: RealtimeContext<User>,
  options: CloseOptions = {},
): Promise<void> => {
  const { timeoutMs = 5000, reconnectInMs = 1000, closeIo = false } = options;

  ctx.state.closing = true;
  const namespaces = [ctx.publicNsp, ctx.privateNsp].filter((nsp) => nsp !== null);
  const localSockets = (): number => namespaces.reduce((sum, nsp) => sum + nsp.sockets.size, 0);

  ctx.obs.logger.info('express-realtime: closing', { sockets: localSockets() });

  for (const nsp of namespaces) {
    nsp.local.emit(EVENTS.serverShutdown, { reconnectInMs });
  }

  const deadline = Date.now() + timeoutMs;

  while (localSockets() > 0 && Date.now() < deadline) {
    await wait(50);
  }

  for (const nsp of namespaces) {
    nsp.local.disconnectSockets(true);
  }

  if (closeIo) {
    await ctx.io.close();
  }
};
