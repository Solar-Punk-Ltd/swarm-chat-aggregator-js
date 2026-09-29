import { Bee, FeedIndex, Topic } from '@ethersphere/bee-js';

import { FeedLedger } from './ledger.mjs';
import { messageIdOf } from './payloads.mjs';

const NOT_FOUND = /\b404\b|not found/i;
/** bee-js 13.1 ignores its timeout option, so every read carries a signal of its own. */
const READ_TIMEOUT_MS = 20_000;

/**
 * Reads one chat's feed slot by slot into a ledger. It follows the feed forward while a scenario runs, and reads
 * every known slot again at the end, which is how an overwritten slot shows.
 */
export class FeedFollower {
  /** @param {{format: string, reader?: {downloadPayload: Function}, beeUrl?: string, owner?: string, topic?: string}} options */
  constructor({ format, reader, beeUrl, owner, topic }) {
    const feed = reader ? null : new Bee(beeUrl).feed;
    this.readerForOneCall = reader
      ? () => reader
      : () => feed.makeReader(Topic.fromString(topic), owner, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    this.format = format;
    this.ledger = new FeedLedger();
  }

  /** The id in a slot, null for an entry holding no readable message, undefined for an empty slot. */
  async readSlot(index) {
    try {
      const { payload } = await this.readerForOneCall().downloadPayload({ index: FeedIndex.fromBigInt(BigInt(index)) });
      let entry;
      try {
        entry = payload.toJSON();
      } catch {
        return null;
      }
      return messageIdOf(this.format, entry);
    } catch (error) {
      if (NOT_FOUND.test(String(error?.message)) || error?.status === 404) return undefined;
      throw error;
    }
  }

  async catchUp() {
    for (let index = this.ledger.nextIndex; ; index++) {
      const id = await this.readSlot(index);
      if (id === undefined) return;
      this.ledger.record(index, id);
    }
  }

  async rereadAll() {
    for (const index of [...this.ledger.slots.keys()]) {
      const id = await this.readSlot(index);
      this.ledger.record(index, id === undefined ? null : id);
    }
    await this.catchUp();
  }
}
