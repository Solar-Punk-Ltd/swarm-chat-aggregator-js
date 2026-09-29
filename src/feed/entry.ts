import { z } from 'zod';

import { type ChatMessage, MESSAGE_VERSION, chatMessageSchema } from '@solarpunkltd/swarm-chat-js/message';

/** Bee wraps a feed payload over this many bytes into a separate chunk, which an entry must never need. */
export const MAX_ENTRY_BYTES = 4096;

export const historyLinkSchema = z.strictObject({
  ref: z.string().regex(/^[0-9a-f]{64}$/),
  toSeq: z.number().int().nonnegative(),
});

/** Where the newest saved history file is, and the last message it holds. */
export type HistoryLink = z.infer<typeof historyLinkSchema>;

export const historyRowSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
  msg: chatMessageSchema,
});

/** One published message: its number in the chat, the server's receive time, and the message. */
export type HistoryRow = z.infer<typeof historyRowSchema>;

const feedEntrySchema = z.strictObject({
  v: z.literal(MESSAGE_VERSION),
  seq: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
  msg: chatMessageSchema,
  history: historyLinkSchema.nullable(),
});

/** What the server writes into feed slot `seq` for each message. */
export type FeedEntry = z.infer<typeof feedEntrySchema>;

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

/** Reads back an entry this server wrote. Undefined for anything else. */
export function decodeFeedEntry(payload: Uint8Array): FeedEntry | undefined {
  try {
    const parsed = feedEntrySchema.safeParse(JSON.parse(new TextDecoder().decode(payload)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function rowOf(entry: FeedEntry): HistoryRow {
  return { seq: entry.seq, at: entry.at, msg: entry.msg satisfies ChatMessage };
}
