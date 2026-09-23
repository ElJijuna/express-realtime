/**
 * Wire contract shared by the server and the browser client.
 *
 * This module must stay free of runtime imports so the client bundle does not pull server code.
 *
 * @module
 */

/** Visual severity of a notification. */
export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

/** Sender attached to notifications emitted from an authenticated context. */
export interface NotificationSender {
  id: string;
  name?: string;
}

/** Notification as delivered to clients on the `notification` event. */
export interface Notification<T = Record<string, unknown>> {
  /** Unique id, generated when omitted. Use it to deduplicate across tabs and reconnections. */
  id: string;
  /** Routing key for the client, e.g. `order.created`. Defaults to `generic`. */
  type: string;
  /** Visual severity. Defaults to `info`. */
  level: NotificationLevel;
  title: string;
  message: string;
  icon?: string;
  /** ISO 8601 date. Defaults to the moment the notification is created. */
  date: string;
  /** Where the client should navigate when the notification is clicked. */
  link?: string;
  from?: NotificationSender;
  data?: T;
}

/** What callers pass when sending a notification. Only `title` and `message` are required. */
export interface NotificationInput<T = Record<string, unknown>> {
  title: string;
  message: string;
  icon?: string;
  date?: string | number | Date;
  data?: T;
  id?: string;
  type?: string;
  level?: NotificationLevel;
  link?: string;
  from?: NotificationSender;
}

/** 1:1 chat message as delivered on `chat:message`. */
export interface ChatMessage<T = Record<string, unknown>> {
  id: string;
  /** Stable id of the conversation between both users (`dm:{a}:{b}`). */
  conversationId: string;
  from: string;
  to: string;
  text: string;
  date: string;
  data?: T;
}

/** Payload of `chat:send`. The sender is always taken from the authenticated socket. */
export interface ChatSendInput<T = Record<string, unknown>> {
  to: string;
  text: string;
  data?: T;
}

/** Acknowledgement returned by every client → server event that accepts a callback. */
export type Ack<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; details?: unknown };

/** Error codes the library returns in {@link Ack}. Custom handlers may return their own codes. */
export type RealtimeErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_payload'
  | 'invalid_room'
  | 'invalid_recipient'
  | 'user_mismatch'
  | 'rate_limited'
  | 'chat_rejected'
  | 'internal_error'
  | 'server_shutting_down';

/** Events the server emits to clients. */
export interface ServerToClientEvents {
  notification: (notification: Notification) => void;
  'chat:message': (message: ChatMessage) => void;
  'chat:typing': (event: { from: string; typing: boolean }) => void;
  'auth:expiring': (event: { expiresAt: string }) => void;
  'auth:expired': () => void;
  'session:revoked': (event: { reason?: string }) => void;
  'rate:limited': (event: { event: string; retryAfterMs: number }) => void;
  'server:shutdown': (event: { reconnectInMs: number }) => void;
}

/** Events clients emit to the server. */
export interface ClientToServerEvents {
  'room:join': (room: string, ack?: (result: Ack<{ room: string }>) => void) => void;
  'room:leave': (room: string, ack?: (result: Ack<{ room: string }>) => void) => void;
  'chat:send': (input: ChatSendInput, ack?: (result: Ack<ChatMessage>) => void) => void;
  'chat:typing': (event: { to: string; typing: boolean }) => void;
  'auth:refresh': (
    token: string,
    ack?: (result: Ack<{ expiresAt: string | null }>) => void,
  ) => void;
}
