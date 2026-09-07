import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GSOC_RECONNECT_MAX_MS, reconnectDelayMs } from './backoff.js';

test('doubles from one second on each consecutive failure', () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((a) => reconnectDelayMs(a)),
    [1_000, 2_000, 4_000, 8_000],
  );
});

test('stops growing at the cap', () => {
  assert.equal(reconnectDelayMs(5), GSOC_RECONNECT_MAX_MS);
  assert.equal(reconnectDelayMs(50), GSOC_RECONNECT_MAX_MS);
});

test('treats a nonsense attempt count as the first attempt', () => {
  assert.equal(reconnectDelayMs(-3), 1_000);
  assert.equal(reconnectDelayMs(Number.NaN), 1_000);
});
