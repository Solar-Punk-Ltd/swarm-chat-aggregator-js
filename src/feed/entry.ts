import {
  type FeedEntry,
  type HistoryLink,
  type HistoryRow,
  MAX_ENTRY_BYTES,
  MESSAGE_VERSION,
} from '@solarpunkltd/swarm-chat-js/message';

export function makeFeedEntry(row: HistoryRow, history: HistoryLink | null): FeedEntry {
  return { v: MESSAGE_VERSION, seq: row.seq, at: row.at, msg: row.msg, history };
}

export function encodeFeedEntry(entry: FeedEntry): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(entry));
  if (bytes.length >= MAX_ENTRY_BYTES) {
    throw new Error(`feed entry ${entry.seq} is ${bytes.length} bytes, over the ${MAX_ENTRY_BYTES} a slot holds`);
  }
  return bytes;
}

export function rowOf(entry: FeedEntry): HistoryRow {
  return { seq: entry.seq, at: entry.at, msg: entry.msg };
}
