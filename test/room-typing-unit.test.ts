import { EventEmitter } from 'node:events';
import type { Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoomTyping } from '../src/client/room-typing.js';
import { defined } from './helpers.js';

const setup = () => {
  const socket = Object.assign(new EventEmitter(), {
    connected: true,
    volatile: { emit: vi.fn() },
  });
  const activity = createRoomTyping(
    socket as unknown as Socket,
    'lobby',
    { throttleMs: 2000, idleMs: 3000, expireMs: 6000 },
    () => true,
  );

  return { socket, activity };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('room typing timers', () => {
  it('keeps activity alive, ignores offline input and releases all timers on disposal', () => {
    vi.useFakeTimers();
    const { socket, activity } = setup();

    activity.typing(true);
    vi.advanceTimersByTime(1000);
    activity.typing(true);
    expect(socket.volatile.emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    activity.typing(true);
    expect(socket.volatile.emit).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2999);
    expect(socket.volatile.emit).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(socket.volatile.emit).toHaveBeenLastCalledWith('room:typing', {
      room: 'lobby',
      typing: false,
    });
    socket.connected = false;
    socket.emit('disconnect');
    activity.typing(true);
    socket.connected = true;
    vi.advanceTimersByTime(6000);
    expect(socket.volatile.emit).toHaveBeenCalledTimes(3);
    activity.typing(true);
    activity.dispose();
    expect(socket.volatile.emit).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
    expect(socket.listenerCount('room:typing')).toBe(0);
    expect(socket.listenerCount('disconnect')).toBe(0);
  });

  it('refreshes expiry per connection without duplicate lists and unsubscribes immediately', () => {
    vi.useFakeTimers();
    const { socket, activity } = setup();
    const listener = vi.fn();
    const off = activity.onTyping(listener);
    const event = {
      room: 'lobby',
      typing: true,
      socketId: 'tab1',
      participant: { id: '1', kind: 'user' },
    };

    socket.emit('room:typing', event);
    // Mutating a delivered snapshot must not affect internal state.
    const snapshot = listener.mock.lastCall?.[0] as { id: string }[];

    defined(snapshot[0]).id = 'changed';
    socket.emit('room:typing', { ...event, socketId: 'tab2' });
    expect(listener).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5000);
    socket.emit('room:typing', { ...event, socketId: 'tab2' });
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(2);
    const latest = vi.fn();

    activity.onTyping(latest);
    expect(latest).toHaveBeenLastCalledWith([{ id: '1', kind: 'user' }]);
    off();
    vi.advanceTimersByTime(5000);
    expect(latest).toHaveBeenLastCalledWith([]);
    expect(listener).toHaveBeenCalledTimes(2);
    activity.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
