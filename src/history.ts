import { z } from 'zod';

import { type HistoryLink, type HistoryRow, historyLinkSchema, historyRowSchema } from './feed/entry.js';
import { MESSAGE_VERSION } from '@solarpunkltd/swarm-chat-js/message';

export const historyFileSchema = z.strictObject({
  v: z.literal(MESSAGE_VERSION),
  topic: z.string(),
  fromSeq: z.number().int().nonnegative(),
  toSeq: z.number().int().nonnegative(),
  messages: z.array(historyRowSchema),
  prev: historyLinkSchema.nullable(),
});

/** One chat's history file as it is uploaded. `prev` links the file it follows once one closed. */
export type HistoryFile = z.infer<typeof historyFileSchema>;

/** Uploads and downloads history files as ordinary Swarm data. */
export interface HistoryStore {
  upload(file: HistoryFile): Promise<string>;
  download(ref: string): Promise<HistoryFile>;
}

export type HistoryLimits = { maxMessages: number; maxBytes: number };

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = { maxMessages: 1000, maxBytes: 512 * 1024 };

/** Room left for the file's own fields around its rows. */
const FILE_OVERHEAD_BYTES = 512;

type OpenFile = {
  fromSeq: number;
  rows: HistoryRow[];
  rowBytes: number;
  /** Set once the file before it is saved in its final form. Undefined while that save is pending. */
  prev: HistoryLink | null | undefined;
  savedAs: HistoryLink | undefined;
};

export type SaveOutcome = { kind: 'saved'; ref: string } | { kind: 'failed'; error: string };

/**
 * A chat's history as today: the current file in memory, saved again after each publish, never before.
 * One save runs at a time, and messages published while it runs ride the next one, so a burst of k
 * messages costs at most two saves. A file closes at the limits and the next one links back to it.
 */
export class HistoryBook {
  private readonly closed: OpenFile[] = [];
  private current: OpenFile;
  private newest: HistoryLink | null;
  private saving: Promise<void> | undefined;
  private dirty = false;

  constructor(
    private readonly topic: string,
    private readonly store: HistoryStore,
    private readonly saveWithRetries: (save: () => Promise<string>) => Promise<SaveOutcome>,
    private readonly onSaved: (link: HistoryLink) => void,
    private readonly limits: HistoryLimits = DEFAULT_HISTORY_LIMITS,
  ) {
    this.current = emptyFile(0, null);
    this.newest = null;
  }

  /** Continues from a saved file and the rows published after it, as resuming a chat rebuilds them. */
  restore(saved: { link: HistoryLink; file: HistoryFile } | null, later: HistoryRow[]): void {
    this.closed.length = 0;
    if (saved) {
      this.current = {
        fromSeq: saved.file.fromSeq,
        rows: [...saved.file.messages],
        rowBytes: saved.file.messages.reduce((sum, row) => sum + rowSize(row), 0),
        prev: saved.file.prev,
        savedAs: saved.link,
      };
      this.newest = saved.link;
    } else {
      this.current = emptyFile(later[0]?.seq ?? 0, null);
      this.newest = null;
    }
    for (const row of later) {
      this.append(row);
    }
    this.dirty = later.length > 0;
  }

  /** The newest saved file, which every new feed entry points to. */
  get newestLink(): HistoryLink | null {
    return this.newest;
  }

  get rows(): readonly HistoryRow[] {
    return this.current.rows;
  }

  get isSaving(): boolean {
    return this.saving !== undefined;
  }

  /** Resolves once no save is running. */
  async settled(): Promise<void> {
    while (this.saving) {
      await this.saving;
    }
  }

  append(row: HistoryRow): void {
    const size = rowSize(row);
    const full =
      this.current.rows.length >= this.limits.maxMessages ||
      FILE_OVERHEAD_BYTES + this.current.rowBytes + this.current.rows.length + size > this.limits.maxBytes;
    if (this.current.rows.length > 0 && full) {
      this.closed.push(this.current);
      this.current = emptyFile(row.seq, undefined);
    }
    this.current.rows.push(row);
    this.current.rowBytes += size;
  }

  /** Starts a save, or marks one to follow the save already running. Resolves when both are done. */
  requestSave(): Promise<void> {
    this.dirty = true;
    this.saving ??= this.saveUntilClean().finally(() => {
      this.saving = undefined;
    });
    return this.saving;
  }

  private async saveUntilClean(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      const pending = this.closed[0] ?? this.current;
      if (pending.prev === undefined || pending.rows.length === 0) {
        return;
      }
      const file = this.snapshot(pending);
      if (pending.savedAs?.toSeq !== file.toSeq) {
        const outcome = await this.saveWithRetries(() => this.store.upload(file));
        if (outcome.kind === 'failed') {
          this.dirty = true;
          return;
        }
        pending.savedAs = { ref: outcome.ref, toSeq: file.toSeq };
        if (this.newest === null || file.toSeq >= this.newest.toSeq) {
          this.newest = pending.savedAs;
        }
        this.onSaved(pending.savedAs);
      }
      if (pending !== this.current) {
        this.closed.shift();
        (this.closed[0] ?? this.current).prev = pending.savedAs;
        this.dirty = true;
      }
    }
  }

  private snapshot(file: OpenFile): HistoryFile {
    const rows = [...file.rows];
    return {
      v: MESSAGE_VERSION,
      topic: this.topic,
      fromSeq: file.fromSeq,
      toSeq: rows.at(-1)?.seq ?? file.fromSeq,
      messages: rows,
      prev: file.prev ?? null,
    };
  }
}

function emptyFile(fromSeq: number, prev: HistoryLink | null | undefined): OpenFile {
  return { fromSeq, rows: [], rowBytes: 0, prev, savedAs: undefined };
}

function rowSize(row: HistoryRow): number {
  return new TextEncoder().encode(JSON.stringify(row)).length;
}
