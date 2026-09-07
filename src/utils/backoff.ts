export const GSOC_RECONNECT_BASE_MS = 1_000;
export const GSOC_RECONNECT_MAX_MS = 30_000;

/**
 * Delay before the next attempt to reopen a dropped subscription: doubles from the base on every
 * consecutive failure and stops growing at the cap, so a gateway that is down for minutes gets a
 * retry every half minute rather than a storm or a give-up.
 */
export function reconnectDelayMs(
  attempt: number,
  baseMs: number = GSOC_RECONNECT_BASE_MS,
  maxMs: number = GSOC_RECONNECT_MAX_MS,
): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(maxMs, baseMs * 2 ** safeAttempt);
}
