import { type Bee, BeeResponseError, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';

import { sleep } from '../utils/sleep.js';

export type SlotRead =
  | { kind: 'found'; payload: Uint8Array }
  | { kind: 'empty' }
  /** The chunk arrived and is not a valid update of this feed, so the slot is taken by something else. */
  | { kind: 'unreadable'; error: string }
  | { kind: 'failed'; error: string };

export type HeadLookup = { kind: 'found'; index: number } | { kind: 'none' } | { kind: 'failed'; error: string };

export type SlotWrite = { kind: 'written' } | { kind: 'failed'; error: string };

/** The feed of one chat under the server's feed key, read and written one explicit slot at a time. */
export interface ChatFeed {
  /** Reads a slot. A slot is empty only when two reads, `recheckMs` apart, both answer 404. */
  readSlot(index: number): Promise<SlotRead>;
  /** Bee's head lookup. Bee answers 404 for a failed lookup as well as for no update, so `none` proves nothing. */
  lookupHead(): Promise<HeadLookup>;
  writeSlot(index: number, payload: Uint8Array): Promise<SlotWrite>;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof BeeResponseError && error.status === 404;
}

export function describeError(error: unknown): string {
  if (error instanceof BeeResponseError) {
    const request = `${error.method?.toUpperCase() ?? 'request'} ${error.url ?? ''}`;
    return error.status ? `${request} answered ${error.status}` : `${request} failed: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export class BeeChatFeed implements ChatFeed {
  private readonly topic: Topic;
  private readonly signer: PrivateKey;

  constructor(
    private readonly bee: Bee,
    topic: string,
    feedKey: string,
    private readonly stamp: string,
    private readonly recheckMs: number,
    private readonly timeoutMs: number,
  ) {
    this.topic = Topic.fromString(topic);
    this.signer = new PrivateKey(feedKey);
  }

  async readSlot(index: number): Promise<SlotRead> {
    const first = await this.readOnce(index);
    if (first.kind !== 'empty') {
      return first;
    }
    await sleep(this.recheckMs);
    return this.readOnce(index);
  }

  async lookupHead(): Promise<HeadLookup> {
    try {
      const reader = this.bee.feed.makeReader(this.topic, this.signer.publicKey().address(), this.requestOptions());
      const update = await reader.downloadPayload();
      return { kind: 'found', index: Number(update.feedIndex.toBigInt()) };
    } catch (error) {
      return isNotFound(error) ? { kind: 'none' } : { kind: 'failed', error: describeError(error) };
    }
  }

  async writeSlot(index: number, payload: Uint8Array): Promise<SlotWrite> {
    try {
      const writer = this.bee.feed.makeWriter(this.topic, this.signer, this.requestOptions());
      // Never deferred: a deferred upload of the same address inside Bee's upload window is dropped.
      await writer.uploadPayload(this.stamp, payload, { index: slotIndex(index), deferred: false });
      return { kind: 'written' };
    } catch (error) {
      return { kind: 'failed', error: describeError(error) };
    }
  }

  /** bee-js sets no timeout of its own, and a request that never answers would hold the chat forever. */
  private requestOptions(): { signal: AbortSignal } {
    return { signal: AbortSignal.timeout(this.timeoutMs) };
  }

  private async readOnce(index: number): Promise<SlotRead> {
    try {
      const reader = this.bee.feed.makeReader(this.topic, this.signer.publicKey().address(), this.requestOptions());
      const update = await reader.downloadPayload({ index: slotIndex(index) });
      return { kind: 'found', payload: update.payload.toUint8Array() };
    } catch (error) {
      if (isNotFound(error)) {
        return { kind: 'empty' };
      }
      // Every transport failure is a BeeResponseError. Anything else was thrown checking the chunk that came back.
      return error instanceof BeeResponseError
        ? { kind: 'failed', error: describeError(error) }
        : { kind: 'unreadable', error: describeError(error) };
    }
  }
}

function slotIndex(index: number): FeedIndex {
  return FeedIndex.fromBigInt(BigInt(index));
}
