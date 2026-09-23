import type { RealtimeErrorCode } from './contract.js';

/**
 * Error whose `code` is safe to send to clients.
 *
 * Throw it from a handler registered with `rt.on()` to return `{ ok: false, error: code }`.
 * Any other error is reported as `internal_error` so internal messages never leak.
 */
export class RealtimeError extends Error {
  readonly code: RealtimeErrorCode | (string & {});
  readonly details: unknown;

  constructor(code: RealtimeErrorCode | (string & {}), message?: string, details?: unknown) {
    super(message ?? code);
    this.name = 'RealtimeError';
    this.code = code;
    this.details = details;
  }
}

/** Raised when a notification, chat message or handler payload is invalid. */
export class RealtimeValidationError extends RealtimeError {
  constructor(message: string, details?: unknown) {
    super('invalid_payload', message, details);
    this.name = 'RealtimeValidationError';
  }
}

/** Converts any thrown value into the code and details exposed to clients. */
export const toClientError = (error: unknown): { error: string; details?: unknown } => {
  if (error instanceof RealtimeError) {
    return error.details === undefined
      ? { error: error.code }
      : { error: error.code, details: error.details };
  }

  return { error: 'internal_error' };
};
