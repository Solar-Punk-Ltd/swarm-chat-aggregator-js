import { describe, expect, it } from 'vitest';

import { GSOC_RECONNECT_MAX_MS, reconnectDelayMs } from './backoff.js';

describe('reconnectDelayMs', () => {
  it('doubles from one second on each consecutive failure', () => {
    expect([0, 1, 2, 3].map((a) => reconnectDelayMs(a))).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('stops growing at the cap', () => {
    expect(reconnectDelayMs(5)).toBe(GSOC_RECONNECT_MAX_MS);
    expect(reconnectDelayMs(50)).toBe(GSOC_RECONNECT_MAX_MS);
  });

  it('treats a nonsense attempt count as the first attempt', () => {
    expect(reconnectDelayMs(-3)).toBe(1_000);
    expect(reconnectDelayMs(Number.NaN)).toBe(1_000);
  });
});
