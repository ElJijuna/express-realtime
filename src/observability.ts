/**
 * Logger, error and metrics hooks. All of them are optional and never allowed to break the library.
 *
 * @module
 */

/** Minimal logger interface, compatible with `console`, pino and winston. */
export interface RealtimeLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Where an error happened. */
export interface ErrorContext {
  scope:
    | 'auth'
    | 'welcome'
    | 'room'
    | 'chat'
    | 'handler'
    | 'notify'
    | 'sync'
    | 'lifecycle'
    | 'hook';
  event?: string;
  socketId?: string;
  userId?: string | null;
}

/** Namespace a socket belongs to. */
export type SocketScope = 'public' | 'private';

/** Hooks to plug Prometheus, OpenTelemetry or any other metrics backend. */
export interface RealtimeMetrics {
  connection?(event: { scope: SocketScope; userId: string | null }): void;
  disconnection?(event: { scope: SocketScope; userId: string | null; reason: string }): void;
  event?(event: { scope: SocketScope; event: string; ok: boolean; durationMs: number }): void;
  notification?(event: { type: string; targets: number }): void;
  rateLimited?(event: { scope: SocketScope; event: string; userId: string | null }): void;
  error?(event: ErrorContext): void;
}

const noop = (): void => undefined;

/** Logger that discards everything. Used when no logger is configured. */
export const silentLogger: RealtimeLogger = { debug: noop, info: noop, warn: noop, error: noop };

/** Wraps user hooks so a failing logger or metrics backend cannot crash a socket. */
export interface Observability {
  logger: RealtimeLogger;
  metric<K extends keyof RealtimeMetrics>(
    name: K,
    payload: Parameters<NonNullable<RealtimeMetrics[K]>>[0],
  ): void;
  reportError(error: unknown, context: ErrorContext): void;
}

export const createObservability = (options: {
  logger?: RealtimeLogger | undefined;
  metrics?: RealtimeMetrics | undefined;
  onError?: ((error: unknown, context: ErrorContext) => void) | undefined;
}): Observability => {
  const logger = options.logger ?? silentLogger;
  const metrics = options.metrics ?? {};
  const metric: Observability['metric'] = (name, payload) => {
    const hook = metrics[name] as ((value: typeof payload) => void) | undefined;

    if (!hook) {
      return;
    }

    try {
      hook.call(metrics, payload);
    } catch (error) {
      logger.warn('express-realtime: metrics hook failed', { metric: name, error });
    }
  };
  const reportError: Observability['reportError'] = (error, context) => {
    logger.error('express-realtime: error', { ...context, error });
    metric('error', context);

    if (!options.onError) {
      return;
    }

    try {
      options.onError(error, context);
    } catch (hookError) {
      logger.warn('express-realtime: onError hook failed', { error: hookError });
    }
  };

  return { logger, metric, reportError };
};
