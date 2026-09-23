/**
 * Friendly Socket.io layer for Express.
 *
 * @packageDocumentation
 */

export type { ChatService } from './chat.js';
export type {
  Ack,
  ChatMessage,
  ChatSendInput,
  ClientToServerEvents,
  Notification,
  NotificationInput,
  NotificationLevel,
  NotificationSender,
  RealtimeErrorCode,
  ServerToClientEvents,
} from './contract.js';
export {
  createRealtimeEmitter,
  type EmitterLike,
  type EmitterOperatorLike,
  type RealtimeEmitter,
  type RealtimeEmitterOptions,
} from './emitter.js';
export { RealtimeError, RealtimeValidationError } from './errors.js';
export {
  AUTHENTICATED_ROOM,
  dmRoom,
  EVENTS,
  isReservedRoom,
  roleRoom,
  userRoom,
} from './events.js';
export type {
  RealtimeMiddlewareOptions,
  RequestNotify,
  RequestRealtime,
} from './express.js';
export type { HandlerRegistry, HandlerScope, PrivateHandlerContext } from './handlers.js';
export type { CloseOptions } from './lifecycle.js';
export {
  type Broadcaster,
  type BroadcastScope,
  type Id,
  type NotificationLimits,
  NotificationService,
  type NotifyTarget,
  normalizeNotification,
} from './notifications.js';
export type {
  ErrorContext,
  RealtimeLogger,
  RealtimeMetrics,
  SocketScope,
} from './observability.js';
export type { RateLimitOptions, RateLimitRule } from './rate-limit.js';
export { createRealtime, type Realtime } from './realtime.js';
export type { RoomMember, RoomPatch, RoomService } from './rooms.js';
export type {
  AnyNamespace,
  AnyServer,
  ChatContext,
  HandlerContext,
  HandlerOptions,
  Handshake,
  MaybePromise,
  RealtimeOptions,
  RealtimeSocket,
  RealtimeSocketData,
  RoomDefinition,
  WelcomeContext,
  WelcomeEntry,
} from './types.js';
export type { WelcomeController } from './welcome.js';
