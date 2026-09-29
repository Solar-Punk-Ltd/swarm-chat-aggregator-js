import { randomBytes } from 'node:crypto';

import { MESSAGE_VERSION } from '@solarpunkltd/swarm-chat-js/message';

/** The server's own liveness probe, sent through the heartbeat node and recognised before any chat message. */
export type Heartbeat = { v: typeof MESSAGE_VERSION; type: 'heartbeat'; nonce: string };

const NONCE_PATTERN = /^[0-9a-f]{32}$/;

export function newHeartbeat(): Heartbeat {
  return { v: MESSAGE_VERSION, type: 'heartbeat', nonce: randomBytes(16).toString('hex') };
}

export function encodeHeartbeat(heartbeat: Heartbeat): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(heartbeat));
}

/** The nonce when the payload has the heartbeat's shape, undefined for anything else. */
export function heartbeatNonce(payload: Uint8Array): string | undefined {
  if (payload.length > 128) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(payload));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    const { v, type, nonce, ...rest } = value as Record<string, unknown>;
    const exact = Object.keys(rest).length === 0 && v === MESSAGE_VERSION && type === 'heartbeat';
    return exact && typeof nonce === 'string' && NONCE_PATTERN.test(nonce) ? nonce : undefined;
  } catch {
    return undefined;
  }
}

export type NonceMatch = 'ours' | 'repeat' | 'unknown';

/** The nonces this server sent, the oldest forgotten past `limit`. */
export class SentNonces {
  private readonly sent = new Set<string>();
  private readonly matched = new Set<string>();

  constructor(private readonly limit = 64) {}

  add(nonce: string): void {
    remember(this.sent, nonce, this.limit);
  }

  /** `repeat` is a heartbeat that came back before, as two overlapping subscriptions both deliver it. */
  match(nonce: string): NonceMatch {
    if (this.sent.delete(nonce)) {
      remember(this.matched, nonce, this.limit);
      return 'ours';
    }
    return this.matched.has(nonce) ? 'repeat' : 'unknown';
  }
}

function remember(set: Set<string>, value: string, limit: number): void {
  set.add(value);
  for (const oldest of set) {
    if (set.size <= limit) {
      break;
    }
    set.delete(oldest);
  }
}
