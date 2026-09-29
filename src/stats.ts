export const DropReason = {
  TooLarge: 'too-large',
  NotUtf8: 'not-utf8',
  NotJson: 'not-json',
  Shape: 'shape',
  Signature: 'signature',
  ChatNotAllowed: 'chat-not-allowed',
  ChatLimit: 'chat-limit',
  Clock: 'clock',
  Duplicate: 'duplicate',
  RateChat: 'rate-chat',
  RateSender: 'rate-sender',
  QueueFull: 'queue-full',
  ChatBlocked: 'chat-blocked',
  Shutdown: 'shutdown',
  HeartbeatUnknown: 'heartbeat-unknown',
  HeartbeatRepeat: 'heartbeat-repeat',
} as const;

export type DropReason = (typeof DropReason)[keyof typeof DropReason];

/** Counts since the process started. */
export class Stats {
  received = 0;
  published = 0;
  heartbeatsReceived = 0;
  readonly dropped = new Map<DropReason, number>();

  drop(reason: DropReason): void {
    this.dropped.set(reason, (this.dropped.get(reason) ?? 0) + 1);
  }

  droppedByReason(): Record<string, number> {
    return Object.fromEntries(this.dropped);
  }
}
