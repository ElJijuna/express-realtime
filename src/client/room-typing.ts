import type { Socket } from 'socket.io-client';
import type { RoomTypingEvent, TypingParticipant } from '../contract.js';
import { EVENTS } from '../events.js';

interface Activity {
  participant: TypingParticipant;
  timer: ReturnType<typeof setTimeout>;
}

/** Ephemeral activity for one joined room, on the connection that owns it. */
export const createRoomTyping = (
  socket: Socket,
  room: string,
  timings: { throttleMs: number; idleMs: number; expireMs: number },
  isJoined: () => boolean,
) => {
  const remote = new Map<string, Activity>();
  const listeners = new Set<(participants: TypingParticipant[]) => void>();

  let idle: ReturnType<typeof setTimeout> | undefined;
  let sentAt = Number.NEGATIVE_INFINITY;
  let active = false;
  let disposed = false;
  let signature = '[]';

  const participants = (): TypingParticipant[] => {
    const unique = new Map<string, TypingParticipant>();

    for (const { participant } of remote.values()) {
      unique.set(`${participant.kind}:${participant.id}`, participant);
    }

    return [...unique.values()].sort((a, b) =>
      `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
    );
  };
  const notify = (): void => {
    const current = participants();
    const next = JSON.stringify(current);

    if (next === signature) {
      return;
    }

    signature = next;

    for (const listener of listeners) {
      listener(current.map((participant) => ({ ...participant })));
    }
  };
  const stopped = (socketId: string): void => {
    clearTimeout(remote.get(socketId)?.timer);
    remote.delete(socketId);
    notify();
  };
  const receive = (event: RoomTypingEvent): void => {
    if (event.room !== room || !isJoined() || disposed) {
      return;
    }

    if (!event.typing) {
      stopped(event.socketId);

      return;
    }

    clearTimeout(remote.get(event.socketId)?.timer);
    remote.set(event.socketId, {
      participant: { ...event.participant },
      timer: setTimeout(() => {
        stopped(event.socketId);
      }, timings.expireMs),
    });
    notify();
  };
  const typing = (value: boolean): void => {
    clearTimeout(idle);

    if (disposed || !isJoined() || !socket.connected) {
      active = false;
      sentAt = Number.NEGATIVE_INFINITY;

      return;
    }

    if (!value) {
      if (active) {
        socket.volatile.emit(EVENTS.roomTyping, { room, typing: false });
      }

      active = false;
      sentAt = Number.NEGATIVE_INFINITY;

      return;
    }

    active = true;
    idle = setTimeout(() => {
      typing(false);
    }, timings.idleMs);

    if (Date.now() - sentAt >= timings.throttleMs) {
      socket.volatile.emit(EVENTS.roomTyping, { room, typing: true });
      sentAt = Date.now();
    }
  };
  const reset = (): void => {
    clearTimeout(idle);
    active = false;
    sentAt = Number.NEGATIVE_INFINITY;

    for (const activity of remote.values()) {
      clearTimeout(activity.timer);
    }

    remote.clear();
    notify();
  };

  socket.on(EVENTS.roomTyping, receive);
  socket.on('disconnect', reset);

  return {
    typing,
    onTyping(listener: (participants: TypingParticipant[]) => void): () => void {
      if (!disposed) {
        listeners.add(listener);
      }

      listener(participants().map((participant) => ({ ...participant })));

      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      typing(false);
      disposed = true;
      reset();
      listeners.clear();
      socket.off(EVENTS.roomTyping, receive);
      socket.off('disconnect', reset);
    },
  };
};
