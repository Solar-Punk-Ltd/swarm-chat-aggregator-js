import {
  type ChatMessage,
  type FeedEntry,
  type HistoryFile,
  type HistoryLink,
  type HistoryRow,
  parseFeedEntry,
} from '@solarpunkltd/swarm-chat-js/message';

import { type Checkpoint, CheckpointDamagedError, type CheckpointStore } from './checkpoint.js';
import { encodeFeedEntry, makeFeedEntry, rowOf } from './feed/entry.js';
import type { ChatFeed, SlotRead } from './feed/slots.js';
import type { HistoryBook, HistoryStart, HistoryStore } from './history.js';
import type { Logger } from './libs/logger.js';
import { DropReason, type Stats } from './stats.js';
import { retryDelayMs } from './utils/backoff.js';
import { RecentIds } from './utils/recentIds.js';
import { sleep } from './utils/sleep.js';

export const ChatState = {
  /** Finding where the feed stands. Messages wait in the queue. */
  Resuming: 'resuming',
  Ready: 'ready',
  /** The feed or the checkpoint holds something this server cannot continue from. Nothing more is published. */
  Blocked: 'blocked',
  Stopped: 'stopped',
} as const;

export type ChatState = (typeof ChatState)[keyof typeof ChatState];

export type ChatTimings = {
  queueLimit: number;
  publishAttempts: number;
  retryBaseMs: number;
  resumeRetryMs: number;
};

/** A slot whose entry has not landed yet, and how long the chat has waited on it. */
export type Stall = { slot: number; stuckSeconds: number; attempts: number };

export type ChatHealth = {
  topic: string;
  state: ChatState;
  nextSeq: number | null;
  queued: number;
  lastPublishAt: number | null;
  lastError: string | null;
  failing: boolean;
  stall: Stall | null;
  /** The chat started at slot 0 with no checkpoint, after its controls passed. */
  startedWithoutCheckpoint: boolean;
  historySaving: boolean;
  lastHistoryError: string | null;
  /** A history file that could not be downloaded at resume, which the current file links back to. */
  historyLost: HistoryLink | null;
  historyTrail: number;
  history: HistoryLink | null;
};

type Queued = { msg: ChatMessage; at: number };

/** The one entry allowed into slot `index`, recorded in the checkpoint before it is written. */
type PendingEntry = { index: number; bytes: Uint8Array; row: HistoryRow; persisted: boolean };

class ResumeError extends Error {}

const RECENT_ID_LIMIT = 10_000;

export function messageKey(message: ChatMessage): string {
  return `${message.addr}:${message.id}`;
}

/**
 * Publishes one chat's messages to its feed, one slot per message, in the order they were accepted. Each entry is
 * recorded in the checkpoint before its slot is written and is the only thing ever written there, resent unchanged
 * until it lands, so a restart continues from the checkpoint without having to ask the feed which slots are empty.
 * Each chat runs its own loop, so chats publish in parallel and a slow one holds up only itself.
 */
export class ChatPublisher {
  private stateValue: ChatState = ChatState.Resuming;
  private nextIndex = -1;
  private pending: PendingEntry | undefined;
  private stallSince: number | null = null;
  private stallAttempts = 0;
  private readonly queue: Queued[] = [];
  private readonly queuedIds = new Set<string>();
  private readonly publishedIds = new RecentIds(RECENT_ID_LIMIT);
  private lastPublishAt: number | null = null;
  private lastActivityAt = Date.now();
  private startedWithoutCheckpoint = false;
  private historyDownloadFailures = 0;
  private historyLost: HistoryLink | null = null;
  private lastError: string | null = null;
  private failing = false;
  private accepting = true;
  private draining = false;
  private stopped = false;
  private wake: (() => void) | undefined;
  private signalStop: () => void = () => undefined;
  private readonly stopRequested = new Promise<void>((resolve) => {
    this.signalStop = resolve;
  });
  private loop: Promise<void> | undefined;
  private checkpointWrites: Promise<boolean> = Promise.resolve(true);

  constructor(
    readonly topic: string,
    private readonly feed: ChatFeed,
    private readonly history: HistoryBook,
    private readonly historyStore: HistoryStore,
    private readonly checkpoints: CheckpointStore,
    private readonly timings: ChatTimings,
    private readonly stats: Stats,
    private readonly logger: Logger,
    /**
     * The newest slot of a chat with no checkpoint, -1 for a chat that is new. Throws while that cannot be trusted,
     * and the chat retries later.
     */
    private readonly findHead: (feed: ChatFeed) => Promise<number>,
  ) {}

  get state(): ChatState {
    return this.stateValue;
  }

  start(): void {
    this.loop ??= this.run().catch((error: unknown) => {
      this.logger.error(`[chat ${this.topic}] publisher stopped on an unexpected error`, errorText(error));
      this.stateValue = ChatState.Stopped;
      this.failing = true;
      this.lastError = errorText(error);
    });
  }

  /**
   * The time the chat last took or published a message, or undefined while it holds work (a queue, a pending
   * entry, a history save or a resume). Only a chat with nothing to lose may be evicted to make room for another.
   */
  idleSince(): number | undefined {
    const settled = this.stateValue === ChatState.Ready || this.stateValue === ChatState.Blocked;
    const busy = this.queue.length > 0 || this.pending !== undefined || this.history.isSaving;
    return settled && !busy ? this.lastActivityAt : undefined;
  }

  isDuplicate(message: ChatMessage): boolean {
    const key = messageKey(message);
    return this.publishedIds.has(key) || this.queuedIds.has(key);
  }

  /** Queues a checked message. Returns the reason when it is dropped instead. */
  offer(message: ChatMessage, at: number): DropReason | undefined {
    if (!this.accepting) {
      return DropReason.Shutdown;
    }
    if (this.stateValue === ChatState.Blocked || this.stateValue === ChatState.Stopped) {
      return DropReason.ChatBlocked;
    }
    if (this.isDuplicate(message)) {
      return DropReason.Duplicate;
    }
    if (this.queue.length >= this.timings.queueLimit) {
      this.logger.error(`[chat ${this.topic}] dead letter, the queue is full`, deadLetterLine(message));
      return DropReason.QueueFull;
    }
    this.queue.push({ msg: message, at });
    this.lastActivityAt = Date.now();
    this.queuedIds.add(messageKey(message));
    this.wake?.();
    return undefined;
  }

  /** Stops taking messages, publishes what is queued and saves the history until the deadline, then stops. */
  async drain(deadlineMs: number): Promise<void> {
    this.accepting = false;
    this.draining = true;
    this.wake?.();
    const deadline = sleep(deadlineMs).then(() => 'deadline' as const);
    const published = (this.loop ?? Promise.resolve()).then(() => this.history.settled());
    const outcome = await Promise.race([published, deadline]);
    if (outcome === 'deadline') {
      this.logger.warn(`[chat ${this.topic}] drain deadline passed with ${this.queue.length} messages unpublished`);
    }
    this.stop();
    // A write already sent can still land, so the lock is not released until the loop has seen the stop.
    await this.loop;
    await this.checkpointWrites;
  }

  stop(): void {
    this.accepting = false;
    this.stopped = true;
    if (this.stateValue !== ChatState.Blocked) {
      this.stateValue = ChatState.Stopped;
    }
    this.signalStop();
    if (this.pending && !this.pending.persisted) {
      this.stats.drop(DropReason.Shutdown);
      this.logger.warn(`[chat ${this.topic}] dropped at shutdown`, deadLetterLine(this.pending.row.msg));
    }
    for (const queued of this.queue.splice(0)) {
      this.stats.drop(DropReason.Shutdown);
      this.logger.warn(`[chat ${this.topic}] dropped at shutdown`, deadLetterLine(queued.msg));
    }
    this.queuedIds.clear();
    this.wake?.();
  }

  health(now = Date.now()): ChatHealth {
    return {
      topic: this.topic,
      state: this.stateValue,
      nextSeq: this.nextIndex >= 0 ? this.nextIndex : null,
      queued: this.queue.length,
      lastPublishAt: this.lastPublishAt,
      lastError: this.lastError,
      failing: this.failing,
      stall:
        this.pending && this.stallSince !== null
          ? {
              slot: this.pending.index,
              stuckSeconds: Math.round((now - this.stallSince) / 1000),
              attempts: this.stallAttempts,
            }
          : null,
      startedWithoutCheckpoint: this.startedWithoutCheckpoint,
      historySaving: this.history.isSaving,
      lastHistoryError: this.history.lastSaveError,
      historyLost: this.historyLost,
      historyTrail: this.history.trail,
      history: this.history.newestLink,
    };
  }

  /** Called by the history book after each save, so a restart finds the newest file. */
  async recordHistory(): Promise<void> {
    if (this.stateValue === ChatState.Ready) {
      await this.writeCheckpoint();
    }
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      if (this.stateValue === ChatState.Resuming) {
        if (!(await this.resume())) {
          await this.pause(this.timings.resumeRetryMs);
        }
        continue;
      }
      if (this.stateValue !== ChatState.Ready) {
        return;
      }
      if (this.pending) {
        await this.deliverPending();
        continue;
      }
      const queued = this.queue.shift();
      if (!queued) {
        if (this.draining) {
          return;
        }
        await this.pause();
        continue;
      }
      if (this.publishedIds.has(messageKey(queued.msg))) {
        this.queuedIds.delete(messageKey(queued.msg));
        this.stats.drop(DropReason.Duplicate);
        continue;
      }
      await this.stage(queued);
    }
  }

  /** A retry's wait, cut short by a stop so shutdown never waits out a backoff. */
  private async sleepUnlessStopped(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))), this.stopRequested]);
    clearTimeout(timer);
  }

  /** Waits for a new message, a stop, or `ms` when given. */
  private async pause(ms?: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = ms === undefined ? undefined : setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.wake = undefined;
  }

  private async resume(): Promise<boolean> {
    try {
      const checkpoint = await this.checkpoints.read(this.topic);
      if (checkpoint) {
        await this.resumeFromCheckpoint(checkpoint);
      } else {
        await this.resumeFromFeed();
      }
      this.lastError = null;
      this.failing = false;
      this.logger.info(`[chat ${this.topic}] resumed, next slot ${this.nextIndex}`);
      return true;
    } catch (error) {
      if (error instanceof CheckpointDamagedError) {
        this.block(`its checkpoint is damaged, and the chat will not start again at slot 0: ${error.message}`);
      }
      if (this.stateValue === ChatState.Blocked) {
        return true;
      }
      this.lastError = `resume: ${errorText(error)}`;
      this.failing = true;
      this.logger.warn(`[chat ${this.topic}] could not resume, retrying later:`, errorText(error));
      return false;
    }
  }

  /** Continues exactly where the checkpoint says, reading nothing from the feed. */
  private async resumeFromCheckpoint(checkpoint: Checkpoint): Promise<void> {
    const firstRow = (checkpoint.history?.toSeq ?? -1) + 1;
    const consecutive = checkpoint.rows.every((row, i) => row.seq === firstRow + i);
    if (!consecutive || firstRow + checkpoint.rows.length !== checkpoint.index + 1) {
      throw new CheckpointDamagedError(`its rows do not run from ${firstRow} to slot ${checkpoint.index}`);
    }
    let pending: PendingEntry | undefined;
    if (checkpoint.pending) {
      const bytes = Buffer.from(checkpoint.pending.bytes, 'base64');
      const entry = parseFeedEntry(bytes, checkpoint.pending.index, this.topic);
      if (checkpoint.pending.index !== checkpoint.index + 1 || !entry.ok) {
        throw new CheckpointDamagedError(`its pending entry is not the entry for slot ${checkpoint.index + 1}`);
      }
      pending = { index: checkpoint.pending.index, bytes, row: rowOf(entry.value), persisted: true };
    }

    this.history.restore(await this.historyStart(checkpoint.history), checkpoint.rows);
    this.enterReady(checkpoint.index + 1, pending);
    if (checkpoint.rows.length > 0) {
      void this.history.requestSave();
    }
  }

  /** A chat with no checkpoint: `findHead`'s answer, then the walk forward from it. */
  private async resumeFromFeed(): Promise<void> {
    let head = await this.findHead(this.feed);
    if (head < 0) {
      this.startedWithoutCheckpoint = true;
      this.logger.warn(
        `[chat ${this.topic}] starting as a new chat at slot 0 without a checkpoint, after the lookup, both nodes and the peer check agreed it has no entries`,
      );
    }
    const entries = new Map<number, FeedEntry>();
    if (head >= 0) {
      entries.set(head, await this.readEntry(head, 'the slot the head was found at'));
      for (;;) {
        const read = await this.feed.readSlot(head + 1);
        if (read.kind === 'empty') {
          break;
        }
        entries.set(head + 1, this.entryOrThrow(head + 1, read, 'the slot after the last one found'));
        head += 1;
      }
    }

    const link = entries.get(head)?.history ?? null;
    const start = await this.historyStart(link && link.toSeq <= head ? link : null);
    const later: HistoryRow[] = [];
    for (let seq = (start.kind === 'none' ? -1 : start.link.toSeq) + 1; seq <= head; seq++) {
      const entry = entries.get(seq) ?? (await this.readEntry(seq, 'a slot the history has not caught up with'));
      later.push(rowOf(entry));
    }
    this.history.restore(start, later);
    this.enterReady(head + 1, undefined);
    await this.writeCheckpoint();
    if (later.length > 0) {
      void this.history.requestSave();
    }
  }

  private enterReady(nextIndex: number, pending: PendingEntry | undefined): void {
    for (const row of this.history.rows) {
      this.publishedIds.add(messageKey(row.msg));
    }
    this.nextIndex = nextIndex;
    this.pending = pending;
    if (pending) {
      this.queuedIds.add(messageKey(pending.row.msg));
    }
    this.stateValue = ChatState.Ready;
  }

  private async readEntry(index: number, what: string): Promise<FeedEntry> {
    return this.entryOrThrow(index, await this.feed.readSlot(index), what);
  }

  private entryOrThrow(index: number, read: SlotRead, what: string): FeedEntry {
    switch (read.kind) {
      case 'found':
        return this.decodeOrBlock(index, read.payload);
      case 'empty':
        throw new ResumeError(`slot ${index}, ${what}, reads as empty`);
      case 'unreadable':
        this.block(`slot ${index} holds a chunk that is not an update of this feed: ${read.error}`);
        throw new ResumeError(`slot ${index} is not ours`);
      case 'failed':
        throw new ResumeError(`slot ${index}: ${read.error}`);
    }
  }

  private decodeOrBlock(index: number, payload: Uint8Array): FeedEntry {
    const entry = parseFeedEntry(payload, index, this.topic);
    if (!entry.ok) {
      this.block(`slot ${index} holds something this server did not write (${entry.reason}: ${entry.detail})`);
      throw new ResumeError(`slot ${index} is not ours`);
    }
    return entry.value;
  }

  /**
   * The file the chat's history continues from. A download that fails is retried with the resume, and after
   * PUBLISH_ATTEMPTS failures in a row the file is taken as lost, so an expired file never wedges the chat.
   */
  private async historyStart(link: HistoryLink | null): Promise<HistoryStart> {
    if (!link) {
      return { kind: 'none' };
    }
    let file: HistoryFile;
    try {
      file = await this.historyStore.download(link, this.topic);
    } catch (error) {
      this.historyDownloadFailures += 1;
      if (this.historyDownloadFailures < this.timings.publishAttempts) {
        throw new ResumeError(`history file ${link.ref}: ${errorText(error)}`, { cause: error });
      }
      this.historyLost = link;
      this.logger.error(
        `[chat ${this.topic}] history file ${link.ref} could not be downloaded after ${this.historyDownloadFailures} attempts, so a fresh file starts after seq ${link.toSeq} and links back to it`,
        errorText(error),
      );
      return { kind: 'lost', link };
    }
    this.historyDownloadFailures = 0;
    if (file.skipped > 0) {
      this.logger.warn(
        `[chat ${this.topic}] history file ${link.ref} had ${file.skipped} rows that failed their check`,
      );
    }
    return { kind: 'saved', link, file };
  }

  /** Makes the next message the pending entry and records it before any write, retrying the record until it holds. */
  private async stage(queued: Queued): Promise<void> {
    const row: HistoryRow = { seq: this.nextIndex, at: queued.at, msg: queued.msg };
    const bytes = encodeFeedEntry(makeFeedEntry(row, this.history.newestLink));
    this.pending = { index: this.nextIndex, bytes, row, persisted: false };
    for (let attempt = 0; !this.stopped; attempt++) {
      if (await this.writeCheckpoint()) {
        this.pending.persisted = true;
        return;
      }
      this.failing = true;
      this.lastError = `checkpoint write failed before slot ${row.seq}`;
      await this.sleepUnlessStopped(retryDelayMs(attempt, this.timings.retryBaseMs));
    }
  }

  /**
   * Writes the pending entry, resending the same bytes until one write succeeds, for as long as it takes. Reads the
   * slot first: our own bytes there mean an earlier attempt landed, anything else means the slot is taken.
   */
  private async deliverPending(): Promise<void> {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.stallSince ??= Date.now();
    let checked = false;
    for (let attempt = 0; !this.stopped; attempt++) {
      if (attempt > 0) {
        await this.sleepUnlessStopped(retryDelayMs(attempt - 1, this.timings.retryBaseMs));
        if (this.stopped) {
          return;
        }
      }
      this.stallAttempts += 1;
      const outcome = checked ? undefined : await this.checkSlot(pending);
      if (outcome === 'blocked') {
        return;
      }
      if (outcome === 'landed') {
        await this.confirm(pending);
        return;
      }
      if (outcome !== 'failed') {
        checked = true;
        const write = await this.feed.writeSlot(pending.index, pending.bytes);
        if (write.kind === 'written') {
          await this.confirm(pending);
          return;
        }
        this.lastError = `slot ${pending.index}: ${write.error}`;
      }
      if (this.stallAttempts % this.timings.publishAttempts === 0) {
        this.failing = true;
        this.logger.warn(
          `[chat ${this.topic}] slot ${pending.index} still unwritten after ${this.stallAttempts} attempts`,
          this.lastError,
        );
      }
    }
  }

  /** What the slot holds before its first write. Undefined means empty, so the write goes ahead. */
  private async checkSlot(pending: PendingEntry): Promise<'landed' | 'blocked' | 'failed' | undefined> {
    const read = await this.feed.readSlot(pending.index);
    switch (read.kind) {
      case 'empty':
        return undefined;
      case 'failed':
        this.lastError = `read before writing slot ${pending.index}: ${read.error}`;
        return 'failed';
      case 'unreadable':
        this.block(`slot ${pending.index} holds a chunk that is not an update of this feed: ${read.error}`);
        return 'blocked';
      case 'found':
        if (sameBytes(read.payload, pending.bytes)) {
          return 'landed';
        }
        this.block(`slot ${pending.index} already holds an entry this server did not write, another writer`);
        return 'blocked';
    }
  }

  private async confirm(pending: PendingEntry): Promise<void> {
    const row = pending.row;
    this.pending = undefined;
    this.stallSince = null;
    this.stallAttempts = 0;
    this.nextIndex = row.seq + 1;
    this.publishedIds.add(messageKey(row.msg));
    this.queuedIds.delete(messageKey(row.msg));
    this.history.append(row);
    this.stats.published += 1;
    this.lastPublishAt = Date.now();
    this.lastActivityAt = this.lastPublishAt;
    this.lastError = null;
    this.failing = false;
    await this.writeCheckpoint();
    void this.history.requestSave();
  }

  /**
   * Records where the chat stands. Writes run one after another, so a later state never lands under an earlier one.
   * Resolves false when the write failed.
   */
  private writeCheckpoint(): Promise<boolean> {
    this.checkpointWrites = this.checkpointWrites.then(async () => {
      const link = this.history.newestLink;
      try {
        await this.checkpoints.write({
          topic: this.topic,
          index: this.nextIndex - 1,
          pending: this.pending
            ? { index: this.pending.index, bytes: Buffer.from(this.pending.bytes).toString('base64') }
            : null,
          history: link,
          rows: this.history.rowsAfter(link?.toSeq ?? -1),
        });
        return true;
      } catch (error) {
        this.logger.error(`[chat ${this.topic}] checkpoint write failed`, errorText(error));
        return false;
      }
    });
    return this.checkpointWrites;
  }

  private block(reason: string): void {
    if (this.stateValue === ChatState.Blocked) {
      return;
    }
    this.stateValue = ChatState.Blocked;
    this.failing = true;
    this.lastError = reason;
    this.logger.error(`[chat ${this.topic}] stopped publishing, ${reason}`);
    for (const queued of this.queue.splice(0)) {
      this.stats.drop(DropReason.ChatBlocked);
      this.logger.warn(`[chat ${this.topic}] dropped, chat blocked`, deadLetterLine(queued.msg));
    }
    if (this.pending) {
      this.stats.drop(DropReason.ChatBlocked);
      this.pending = undefined;
    }
    this.queuedIds.clear();
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function deadLetterLine(message: ChatMessage): Record<string, unknown> {
  return { deadLetter: true, topic: message.topic, id: message.id, addr: message.addr, message };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
