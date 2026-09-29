import { BeeResponseError } from '@ethersphere/bee-js';
import { describe, expect, test } from 'vitest';

import { describeError } from '../src/feed/slots.js';

import { SentNonces, encodeHeartbeat, heartbeatNonce, newHeartbeat } from '../src/heartbeat.js';
import { RateLimiter } from '../src/rate.js';
import { message } from './helpers/harness.js';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('heartbeat shape', () => {
  test('recognises exactly the heartbeat shape and nothing else', () => {
    const heartbeat = newHeartbeat();
    expect(heartbeatNonce(encodeHeartbeat(heartbeat))).toBe(heartbeat.nonce);
    expect(heartbeatNonce(bytes({ ...heartbeat, extra: 1 }))).toBeUndefined();
    expect(heartbeatNonce(bytes({ ...heartbeat, v: 6 }))).toBeUndefined();
    expect(heartbeatNonce(bytes({ ...heartbeat, nonce: 'short' }))).toBeUndefined();
    expect(heartbeatNonce(message().bytes)).toBeUndefined();
    expect(heartbeatNonce(new TextEncoder().encode('not json'))).toBeUndefined();
  });

  test('matches each sent nonce once, then as a repeat, and never a foreign one', () => {
    const nonces = new SentNonces(2);
    nonces.add('a');
    expect(nonces.match('a')).toBe('ours');
    expect(nonces.match('a')).toBe('repeat');
    expect(nonces.match('b')).toBe('unknown');
    nonces.add('c');
    nonces.add('d');
    nonces.add('e');
    expect(nonces.match('c')).toBe('unknown');
    expect(nonces.match('e')).toBe('ours');
  });
});

describe('rate limiter', () => {
  test('lets `limit` events through per window and frees them as the window moves', () => {
    const limiter = new RateLimiter(2, 1000);
    for (const at of [0, 10]) {
      expect(limiter.fits('k', at)).toBe(true);
      limiter.record('k', at);
    }
    expect(limiter.fits('k', 20)).toBe(false);
    expect(limiter.fits('other', 20)).toBe(true);
    expect(limiter.fits('k', 1001)).toBe(true);
  });
});

describe('error text', () => {
  test("keeps Bee's own reason beside the status", () => {
    const error = new BeeResponseError(
      'POST',
      'http://writer.example.com/soc/a/b',
      'Payment Required: batch not usable',
      undefined,
      402,
      'Payment Required',
    );
    expect(describeError(error)).toBe(
      'POST http://writer.example.com/soc/a/b answered 402: Payment Required: batch not usable',
    );
  });
});
