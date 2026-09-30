import {
  type HistoryFile,
  type HistoryLink,
  type HistoryRow,
  MESSAGE_VERSION,
} from '@solarpunkltd/swarm-chat-js/message';

import { sleep } from './utils/sleep.js';

/** A history file as the server uploads it, the shape the library's historyFileSchema reads. */
export type UploadedHistoryFile = {
  v: typeof MESSAGE_VERSION;
  topic: string;
  fromSeq: number;
  toSeq: number;
  messages: HistoryRow[];
  prev: HistoryLink | null;
};

/** Uploads history files as ordinary Swarm data, and reads one back as the library checks it. */
export interface HistoryStore {
  upload(file: UploadedHistoryFile): Promise<string>;
  download(link: HistoryLink, topic: string): Promise<HistoryFile>;
}

/**
 * Where a resumed chat's history continues from: nothing yet, a saved file it keeps appending to, or a file that
 * could not be downloaded, after which a fresh file starts and links back to it.
 */
export type HistoryStart =
  | { kind: 'none' }
  | { kind: 'saved'; link: HistoryLink; file: HistoryFile }
  | { kind: 'lost'; link: HistoryLink };

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
  private lastUploadStartedAt = 0;
  private lastSaveErrorValue: string | null = null;

  constructor(
    private readonly topic: string,
    private readonly store: HistoryStore,
    private readonly saveWithRetries: (save: () => Promise<string>) => Promise<SaveOutcome>,
    private readonly onSaved: (link: HistoryLink) => void,
    private readonly limits: HistoryLimits = DEFAULT_HISTORY_LIMITS,
    /** The least time between the starts of two uploads, so a busy chat saves once per interval, a quiet one at once. */
    private readonly saveIntervalMs = 0,
  ) {
    this.current = emptyFile(0, null);
    this.newest = null;
  }

  /** Continues from a saved file and the rows published after it, as resuming a chat rebuilds them. */
  restore(start: HistoryStart, later: HistoryRow[]): void {
    this.closed.length = 0;
    if (start.kind === 'saved') {
      this.current = {
        fromSeq: start.file.fromSeq,
        rows: [...start.file.rows],
        rowBytes: start.file.rows.reduce((sum, row) => sum + rowSize(row), 0),
        prev: start.file.prev,
        savedAs: start.link,
      };
      this.newest = start.link;
    } else if (start.kind === 'lost') {
      this.current = emptyFile(start.link.toSeq + 1, start.link);
      this.newest = start.link;
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

  /** The rows after `toSeq`, across files not yet saved in their final form. */
  rowsAfter(toSeq: number): HistoryRow[] {
    return [...this.closed, this.current].flatMap((file) => file.rows.filter((row) => row.seq > toSeq));
  }

  /** Why the last save failed, until one succeeds. */
  get lastSaveError(): string | null {
    return this.lastSaveErrorValue;
  }

  /** How many published rows no saved file holds yet, which a restart keeps in the checkpoint meanwhile. */
  get trail(): number {
    return this.rowsAfter(this.newest?.toSeq ?? -1).length;
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
      const wait = this.lastUploadStartedAt + this.saveIntervalMs - Date.now();
      if (wait > 0) {
        // Rows published while this waits ride the same upload.
        await sleep(wait);
      }
      this.dirty = false;
      const pending = this.closed[0] ?? this.current;
      if (pending.prev === undefined || pending.rows.length === 0) {
        return;
      }
      const file = this.snapshot(pending);
      if (pending.savedAs?.toSeq !== file.toSeq) {
        this.lastUploadStartedAt = Date.now();
        const outcome = await this.saveWithRetries(() => this.store.upload(file));
        if (outcome.kind === 'failed') {
          this.lastSaveErrorValue = outcome.error;
          this.dirty = true;
          return;
        }
        this.lastSaveErrorValue = null;
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

  private snapshot(file: OpenFile): UploadedHistoryFile {
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
