import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Topic } from '@ethersphere/bee-js';
import { z } from 'zod';

import { historyLinkSchema } from '@solarpunkltd/swarm-chat-js/message';

const checkpointSchema = z.strictObject({
  v: z.literal(1),
  topic: z.string(),
  index: z.number().int().nonnegative(),
  history: historyLinkSchema.nullable(),
});

/** What survives a restart for one chat: the last slot written and the newest history file. */
export type Checkpoint = z.infer<typeof checkpointSchema>;

/** One small JSON file per chat, replaced whole on every publish so a crash leaves the old or the new one. */
export class CheckpointStore {
  constructor(private readonly dir: string) {}

  async prepare(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async read(topic: string): Promise<Checkpoint | undefined> {
    let text: string;
    try {
      text = await readFile(this.pathOf(topic), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
    const checkpoint = checkpointSchema.parse(JSON.parse(text));
    if (checkpoint.topic !== topic) {
      throw new Error(`checkpoint ${this.pathOf(topic)} names another chat`);
    }
    return checkpoint;
  }

  async write(checkpoint: Omit<Checkpoint, 'v'>): Promise<void> {
    const path = this.pathOf(checkpoint.topic);
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify({ v: 1, ...checkpoint }));
    await rename(temporary, path);
  }

  private pathOf(topic: string): string {
    return join(this.dir, `${Topic.fromString(topic).toHex()}.json`);
  }
}
