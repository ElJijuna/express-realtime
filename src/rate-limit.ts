/**
 * Per-socket token bucket. Buckets live in memory: a socket is always served by one pod,
 * so the limit holds in a cluster without shared state.
 *
 * @module
 */

/** `points` events allowed per `perMs` window, refilled continuously. */
export interface RateLimitRule {
  points: number;
  perMs: number;
}

/** Rate limit configuration. `false` disables a rule. */
export interface RateLimitOptions {
  /** Applies to library events and handlers registered with `rt.on()`. Default: 20 per second. */
  default?: RateLimitRule | false;
  /**
   * Per-event overrides. Events listed here are limited even when they are not
   * managed by the library, e.g. handlers the core registers directly on the socket.
   */
  events?: Record<string, RateLimitRule | false>;
}

export const DEFAULT_RATE_LIMIT: RateLimitRule = { points: 20, perMs: 1000 };

/** Continuous-refill token bucket. */
export class TokenBucket {
  #tokens: number;
  #updatedAt: number;
  readonly #rule: RateLimitRule;
  readonly #now: () => number;

  constructor(rule: RateLimitRule, now: () => number = Date.now) {
    if (rule.points <= 0 || rule.perMs <= 0) {
      throw new RangeError('rate limit points and perMs must be greater than 0');
    }

    this.#rule = rule;
    this.#now = now;
    this.#tokens = rule.points;
    this.#updatedAt = now();
  }

  /** Takes one token. Returns 0 when allowed, or how long to wait before retrying. */
  take(): number {
    const now = this.#now();
    const refill = ((now - this.#updatedAt) / this.#rule.perMs) * this.#rule.points;

    this.#tokens = Math.min(this.#rule.points, this.#tokens + refill);
    this.#updatedAt = now;

    if (this.#tokens >= 1) {
      this.#tokens -= 1;

      return 0;
    }

    return Math.ceil(((1 - this.#tokens) / this.#rule.points) * this.#rule.perMs);
  }
}

/**
 * Builds the rule resolver used by {@link SocketRateLimiter}.
 *
 * Precedence: `options.events[event]`, then the handler's own rule, then `options.default`
 * for events managed by the library. Other events are not limited.
 */
export const createRuleResolver =
  (
    options: RateLimitOptions,
    isManaged: (event: string) => boolean,
    handlerRule: (event: string) => RateLimitRule | false | undefined,
  ) =>
  (event: string): RateLimitRule | false => {
    const override = options.events?.[event] ?? handlerRule(event);

    if (override !== undefined) {
      return override;
    }

    return isManaged(event) ? (options.default ?? DEFAULT_RATE_LIMIT) : false;
  };

/** Keeps one bucket per event for a single socket. Create one per socket. */
export class SocketRateLimiter {
  readonly #buckets = new Map<string, TokenBucket>();
  readonly #resolveRule: (event: string) => RateLimitRule | false;
  readonly #now: (() => number) | undefined;

  constructor(resolveRule: (event: string) => RateLimitRule | false, now?: () => number) {
    this.#resolveRule = resolveRule;
    this.#now = now;
  }

  /** Returns 0 when the event is allowed, or the retry delay in ms. */
  check(event: string): number {
    const rule = this.#resolveRule(event);

    if (rule === false) {
      return 0;
    }

    let bucket = this.#buckets.get(event);

    if (!bucket) {
      bucket = new TokenBucket(rule, this.#now);
      this.#buckets.set(event, bucket);
    }

    return bucket.take();
  }
}
