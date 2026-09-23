import { describe, expect, it, vi } from 'vitest';
import {
  type Broadcaster,
  dmRoom,
  isReservedRoom,
  NotificationService,
  normalizeNotification,
  RealtimeValidationError,
} from '../src/index.js';
import { createRuleResolver, SocketRateLimiter, TokenBucket } from '../src/rate-limit.js';

describe('normalizeNotification', () => {
  it('fills id, type, level and an ISO date', () => {
    const notification = normalizeNotification({ title: 'Hi', message: 'There' });

    expect(notification.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(notification.type).toBe('generic');
    expect(notification.level).toBe('info');
    expect(new Date(notification.date).toISOString()).toBe(notification.date);
  });

  it('keeps the user payload { title, message, icon, date, data }', () => {
    const date = new Date('2026-01-02T03:04:05.000Z');

    expect(
      normalizeNotification({ title: 'T', message: 'M', icon: 'bell', date, data: { a: 1 } }),
    ).toMatchObject({
      title: 'T',
      message: 'M',
      icon: 'bell',
      date: '2026-01-02T03:04:05.000Z',
      data: { a: 1 },
    });
  });

  it.each([
    [{ title: '', message: 'm' }],
    [{ title: 't', message: '   ' }],
    [{ title: 't', message: 'm', date: 'not a date' }],
    [{ title: 't', message: 'm', level: 'fatal' }],
    [{ title: 'x'.repeat(201), message: 'm' }],
  ])('rejects %j', (input) => {
    expect(() => normalizeNotification(input as never)).toThrow(RealtimeValidationError);
  });
});

describe('NotificationService', () => {
  const setup = () => {
    const emit = vi.fn<Broadcaster['emit']>();

    return { emit, service: new NotificationService({ emit }) };
  };

  it('sends users and roles to the private namespace only', () => {
    const { emit, service } = setup();

    service.send({ user: ['1', 2], role: 'admin' }, { title: 't', message: 'm' });
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0]?.slice(0, 3)).toEqual([
      'private',
      ['user:1', 'user:2', 'role:admin'],
      [],
    ]);
  });

  it('sends rooms to both namespaces', () => {
    const { emit, service } = setup();

    service.room('lobby', { title: 't', message: 'm' });
    expect(emit.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['private', ['lobby']],
      ['public', ['lobby']],
    ]);
  });

  it('applies except() and from() without mutating the original service', () => {
    const { emit, service } = setup();
    const scoped = service.except('1').from({ id: '9', name: 'Bot' });
    const sent = scoped.user('2', { title: 't', message: 'm' });

    expect(sent.from).toEqual({ id: '9', name: 'Bot' });
    expect(emit.mock.calls[0]?.[2]).toEqual(['user:1']);
    service.user('2', { title: 't', message: 'm' });
    expect(emit.mock.calls[1]?.[2]).toEqual([]);
  });

  it('broadcasts to the whole namespace', () => {
    const { emit, service } = setup();

    service.broadcastPublic({ title: 't', message: 'm' });
    expect(emit.mock.calls[0]?.slice(0, 2)).toEqual(['public', null]);
  });
});

describe('rooms helpers', () => {
  it('builds the same dm room regardless of order', () => {
    expect(dmRoom('2', '1')).toBe(dmRoom(1, 2));
    expect(dmRoom('a', 'b')).toBe('dm:a:b');
  });

  it('flags library rooms as reserved', () => {
    expect(isReservedRoom('user:1')).toBe(true);
    expect(isReservedRoom('authenticated')).toBe(true);
    expect(isReservedRoom('lobby')).toBe(false);
  });
});

describe('rate limit', () => {
  it('refills tokens continuously', () => {
    let now = 0;

    const bucket = new TokenBucket({ points: 2, perMs: 1000 }, () => now);

    expect(bucket.take()).toBe(0);
    expect(bucket.take()).toBe(0);
    expect(bucket.take()).toBe(500);
    now = 500;
    expect(bucket.take()).toBe(0);
  });

  it('limits managed events by default and others only when listed', () => {
    const resolve = createRuleResolver(
      { default: { points: 1, perMs: 1000 }, events: { custom: { points: 1, perMs: 1000 } } },
      (event) => event === 'chat:send',
      () => undefined,
    );
    const limiter = new SocketRateLimiter(resolve, () => 0);

    expect(limiter.check('chat:send')).toBe(0);
    expect(limiter.check('chat:send')).toBeGreaterThan(0);
    expect(limiter.check('custom')).toBe(0);
    expect(limiter.check('custom')).toBeGreaterThan(0);
    expect(limiter.check('core:event')).toBe(0);
    expect(limiter.check('core:event')).toBe(0);
  });

  it('lets a handler rule override the default and false disable it', () => {
    const resolve = createRuleResolver(
      {},
      () => true,
      (event) => (event === 'free' ? false : undefined),
    );

    expect(resolve('free')).toBe(false);
    expect(resolve('other')).toEqual({ points: 20, perMs: 1000 });
  });
});
