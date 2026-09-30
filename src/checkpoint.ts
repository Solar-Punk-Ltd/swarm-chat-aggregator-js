import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Topic } from '@ethersphere/bee-js';
import { historyLinkSchema, historyRowSchema } from '@solarpunkltd/swarm-chat-js/message';
import { z } from 'zod';

const recordedEntrySchema = z.strictObject({ index: z.number().int().nonnegative(), bytes: z.base64() });

const checkpointFields = {
  topic: z.string(),
  /** The last slot confirmed in order, -1 before the first. Every slot up to it holds its entry. */
  index: z.number().int().min(-1),
  history: historyLinkSchema.nullable(),
  /** The rows published after `history.toSeq`, which no saved history file holds yet. */
  rows: z.array(historyRowSchema),
};

const checkpointSchema = z.union([
  z.strictObject({
    v: z.literal(3),
    ...checkpointFields,
    /** The entries in flight, one per slot from `index + 1` on, each recorded before its first write. */
    pending: z.array(recordedEntrySchema),
  }),
  z
    .strictObject({ v: z.literal(2), ...checkpointFields, pending: recordedEntrySchema.nullable() })
    .transform((older) => ({ ...older, v: 3 as const, pending: older.pending ? [older.pending] : [] })),
]);

/** What survives a restart for one chat, so resuming it needs no read of the feed. */
export type Checkpoint = z.output<typeof checkpointSchema>;

export class CheckpointDamagedError extends Error {}

/**
 * One small JSON file per chat, written to a temporary file, flushed to disk and renamed over the old one, so a
 * crash leaves the old or the new checkpoint and never half of one.
 */
export class CheckpointStore {
  constructor(private readonly dir: string) {}

  async prepare(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** Undefined when the chat has none. Throws CheckpointDamagedError when the file is there and unreadable. */
  async read(topic: string): Promise<Checkpoint | undefined> {
    const path = this.pathOf(topic);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CheckpointDamagedError(`checkpoint ${path} is not JSON`);
    }
    const checkpoint = checkpointSchema.safeParse(parsed);
    if (!checkpoint.success) {
      throw new CheckpointDamagedError(`checkpoint ${path} has the wrong shape: ${checkpoint.error.message}`);
    }
    if (checkpoint.data.topic !== topic) {
      throw new CheckpointDamagedError(`checkpoint ${path} names another chat`);
    }
    return checkpoint.data;
  }

  async write(checkpoint: Omit<Checkpoint, 'v'>): Promise<void> {
    const path = this.pathOf(checkpoint.topic);
    const temporary = `${path}.tmp`;
    const file = await open(temporary, 'w');
    try {
      await file.writeFile(JSON.stringify({ v: 3, ...checkpoint }));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const folder = await open(dirname(path), 'r');
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  }

  pathOf(topic: string): string {
    return join(this.dir, `${Topic.fromString(topic).toHex()}.json`);
  }
}
