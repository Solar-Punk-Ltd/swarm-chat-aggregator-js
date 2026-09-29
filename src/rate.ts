/** At most `limit` events per key in any window of `windowMs`, counted from the events themselves. */
export class RateLimiter {
  private readonly events = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Whether one more event for `key` fits, without counting it. */
  fits(key: string, now = Date.now()): boolean {
    const since = now - this.windowMs;
    const recent = (this.events.get(key) ?? []).filter((at) => at > since);
    this.events.set(key, recent);
    return recent.length < this.limit;
  }

  record(key: string, now = Date.now()): void {
    const recent = this.events.get(key) ?? [];
    recent.push(now);
    this.events.set(key, recent);
  }

  /** Forgets keys whose events have all left the window, so senders who stopped cost nothing. */
  prune(now = Date.now()): void {
    const since = now - this.windowMs;
    for (const [key, events] of this.events) {
      if (events.every((at) => at <= since)) {
        this.events.delete(key);
      }
    }
  }
}
