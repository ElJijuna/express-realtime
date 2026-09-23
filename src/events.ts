/**
 * Event names and room naming conventions.
 *
 * @module
 */

/** Event names used by the library. */
export const EVENTS = {
  notification: 'notification',
  chatMessage: 'chat:message',
  chatSend: 'chat:send',
  chatTyping: 'chat:typing',
  roomJoin: 'room:join',
  roomLeave: 'room:leave',
  authRefresh: 'auth:refresh',
  authExpiring: 'auth:expiring',
  authExpired: 'auth:expired',
  sessionRevoked: 'session:revoked',
  rateLimited: 'rate:limited',
  serverShutdown: 'server:shutdown',
} as const;

/** Internal server-to-server event used to sync hot configuration changes across pods. */
export const SYNC_EVENT = 'express-realtime:sync';

/** Room every authenticated socket joins. */
export const AUTHENTICATED_ROOM = 'authenticated';

/** Room prefixes managed by the library. Clients can never join these through `room:join`. */
export const RESERVED_ROOM_PREFIXES = ['user:', 'role:', 'dm:'] as const;

/** Room holding every socket of a user. */
export const userRoom = (userId: string | number): string => `user:${String(userId)}`;

/** Room holding every socket of a role, joined through `getUserRooms`. */
export const roleRoom = (role: string): string => `role:${role}`;

/** Deterministic conversation id for two users, independent of who writes first. */
export const dmRoom = (a: string | number, b: string | number): string => {
  const [first, second] = [String(a), String(b)].sort();

  return `dm:${first ?? ''}:${second ?? ''}`;
};

/** Whether a room name is managed by the library and must not be joined by clients. */
export const isReservedRoom = (room: string): boolean =>
  room === AUTHENTICATED_ROOM || RESERVED_ROOM_PREFIXES.some((prefix) => room.startsWith(prefix));
