import type { CheckpointStore } from './checkpoint.js';
import { encodeFeedEntry, makeFeedEntry, rowOf } from './feed/entry.js';
import type { ChatFeed, SlotRead } from './feed/slots.js';
import type { HistoryBook, HistoryStore } from './history.js';
import type { Logger } from './libs/logger.js';
import {
  type ChatMessage,
  type FeedEntry,
  type HistoryFile,
  type HistoryLink,
  type HistoryRow,
  parseFeedEntry,
} from '@solarpunkltd/swarm-chat-js/message';
import { DropReason, type Stats } from './stats.js';
import { RecentIds } from './utils/recentIds.js';
import { retryDelayMs } from './utils/backoff.js';
import { sleep } from './utils/sleep.js';

export const ChatState = {
  /** Finding the head of the feed. Messages wait in the queue. */
  Resuming: 'resuming',
  Ready: 'ready',
  /** Another writer is at this feed. Nothing more is published to it. */
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

export type ChatHealth = {
  topic: string;
  state: ChatState;
  nextSeq: number | null;
  queued: number;
  lastPublishAt: number | null;
  lastError: string | null;
  failing: boolean;
  historySaving: boolean;
  history: HistoryLink | null;
};

type Pending = { msg: ChatMessage; at: number };

/** A write that ran out of attempts. It may have landed anyway, which the next write to its slot finds out. */
type Unconfirmed = { index: number; bytes: Uint8Array; row: HistoryRow };

class ResumeError extends Error {}

const RECENT_ID_LIMIT = 10_000;

export function messageKey(message: ChatMessage): string {
  return `${message.addr}:${message.id}`;
}

/**
 * Publishes one chat's messages to its feed, one slot per message, in the order they were accepted.
 * Each chat runs its own loop, so chats publish in parallel and a slow one holds up only itself.
 */
export class ChatPublisher {
  private stateValue: ChatState = ChatState.Resuming;
  private nextIndex = -1;
  private readonly queue: Pending[] = [];
  private readonly queuedIds = new Set<string>();
  private readonly publishedIds = new RecentIds(RECENT_ID_LIMIT);
  private unconfirmed: Unconfirmed | undefined;
  private lastPublishAt: number | null = null;
  private lastError: string | null = null;
  private failing = false;
  private accepting = true;
  private draining = false;
  private stopped = false;
  private wake: (() => void) | undefined;
  private loop: Promise<void> | undefined;
  private checkpointWrites: Promise<void> = Promise.resolve();

  constructor(
    readonly topic: string,
    private readonly feed: ChatFeed,
    private readonly history: HistoryBook,
    private readonly historyStore: HistoryStore,
    private readonly checkpoints: CheckpointStore,
    private readonly timings: ChatTimings,
    private readonly stats: Stats,
    private readonly logger: Logger,
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
      return DropReason.QueueFull;
    }
    this.queue.push({ msg: message, at });
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
  }

  stop(): void {
    this.accepting = false;
    this.stopped = true;
    for (const pending of this.queue.splice(0)) {
      this.stats.drop(DropReason.Shutdown);
      this.logger.warn(`[chat ${this.topic}] dropped at shutdown`, deadLetterLine(pending.msg));
    }
    this.queuedIds.clear();
    this.wake?.();
  }

  health(): ChatHealth {
    return {
      topic: this.topic,
      state: this.stateValue,
      nextSeq: this.nextIndex >= 0 ? this.nextIndex : null,
      queued: this.queue.length,
      lastPublishAt: this.lastPublishAt,
      lastError: this.lastError,
      failing: this.failing,
      historySaving: this.history.isSaving,
      history: this.history.newestLink,
    };
  }

  /** Called by the history book after each save, so a restart finds the newest file. */
  async recordHistory(link: HistoryLink): Promise<void> {
    if (this.nextIndex > 0) {
      await this.writeCheckpoint(this.nextIndex - 1, link);
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
      const pending = this.queue.shift();
      if (!pending) {
        if (this.draining) {
          return;
        }
        await this.pause();
        continue;
      }
      if (this.publishedIds.has(messageKey(pending.msg))) {
        this.queuedIds.delete(messageKey(pending.msg));
        this.stats.drop(DropReason.Duplicate);
        continue;
      }
      await this.publish(pending);
    }
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
      await this.resumeOrThrow();
      this.lastError = null;
      this.failing = false;
      return true;
    } catch (error) {
      if (this.stateValue === ChatState.Blocked) {
        return true;
      }
      this.lastError = `resume: ${errorText(error)}`;
      this.failing = true;
      this.logger.warn(`[chat ${this.topic}] could not find the head of its feed, retrying later:`, errorText(error));
      return false;
    }
  }

  private async resumeOrThrow(): Promise<void> {
    const checkpoint = await this.checkpoints.read(this.topic);
    const start = checkpoint ? checkpoint.index : await this.headFromLookup();
    const entries = new Map<number, FeedEntry>();

    let head = -1;
    if (start >= 0) {
      entries.set(start, await this.readEntry(start, 'a slot this chat already wrote'));
      head = start;
      for (;;) {
        const read = await this.feed.readSlot(head + 1);
        if (read.kind === 'empty') {
          break;
        }
        entries.set(head + 1, this.entryOrThrow(head + 1, read, 'the slot after the last one found'));
        head += 1;
      }
    }

    const links = [checkpoint?.history ?? null, entries.get(head)?.history ?? null].filter(
      (link): link is HistoryLink => link !== null && link.toSeq <= head,
    );
    const link = links.sort((a, b) => b.toSeq - a.toSeq)[0] ?? null;
    const saved = link ? { link, file: await this.downloadHistory(link) } : null;

    const later: HistoryRow[] = [];
    for (let seq = (link?.toSeq ?? -1) + 1; seq <= head; seq++) {
      const entry = entries.get(seq) ?? (await this.readEntry(seq, 'a slot the history has not caught up with'));
      later.push(rowOf(entry));
    }

    this.history.restore(saved, later);
    for (const row of this.history.rows) {
      this.publishedIds.add(messageKey(row.msg));
    }
    this.nextIndex = head + 1;
    this.stateValue = ChatState.Ready;
    if (head >= 0) {
      await this.writeCheckpoint(head, this.history.newestLink);
    }
    if (later.length > 0) {
      void this.history.requestSave();
    }
    this.logger.info(`[chat ${this.topic}] resumed, next slot ${this.nextIndex}`);
  }

  /** The newest slot Bee's lookup names, or -1 for a chat that is provably new. */
  private async headFromLookup(): Promise<number> {
    const head = await this.feed.lookupHead();
    if (head.kind === 'found') {
      return head.index;
    }
    if (head.kind === 'failed') {
      throw new ResumeError(`head lookup: ${head.error}`);
    }
    const first = await this.feed.readSlot(0);
    if (first.kind === 'empty') {
      return -1;
    }
    this.entryOrThrow(0, first, 'slot 0 after a 404 lookup');
    return 0;
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

  private async downloadHistory(link: HistoryLink): Promise<HistoryFile> {
    let file: HistoryFile;
    try {
      file = await this.historyStore.download(link, this.topic);
    } catch (error) {
      throw new ResumeError(`history file ${link.ref}: ${errorText(error)}`, { cause: error });
    }
    if (file.skipped > 0) {
      this.logger.warn(
        `[chat ${this.topic}] history file ${link.ref} had ${file.skipped} rows that failed their check`,
      );
    }
    return file;
  }

  private async publish(pending: Pending): Promise<void> {
    const key = messageKey(pending.msg);
    if (this.unconfirmed?.index === this.nextIndex && !(await this.settleUnconfirmed())) {
      if (this.stateValue === ChatState.Blocked) {
        this.queuedIds.delete(key);
        this.stats.drop(DropReason.ChatBlocked);
      } else {
        this.queue.unshift(pending);
      }
      return;
    }

    const index = this.nextIndex;
    const row: HistoryRow = { seq: index, at: pending.at, msg: pending.msg };
    const bytes = encodeFeedEntry(makeFeedEntry(row, this.history.newestLink));
    const outcome = await this.writeOnce(index, bytes);
    this.queuedIds.delete(key);

    if (outcome === 'blocked') {
      this.stats.drop(DropReason.ChatBlocked);
      return;
    }
    if (outcome !== 'written') {
      this.unconfirmed = { index, bytes, row };
      this.failing = true;
      this.lastError = `slot ${index}: ${outcome.error}`;
      this.stats.drop(DropReason.DeadLetter);
      this.logger.error(`[chat ${this.topic}] dead letter after ${this.timings.publishAttempts} attempts`, {
        ...deadLetterLine(pending.msg),
        slot: index,
        error: outcome.error,
      });
      return;
    }
    await this.recordPublished(row);
  }

  /**
   * Writes the entry for slot `index`, resending the same bytes on every retry. Reads the slot first:
   * our own bytes there mean an earlier attempt landed, anything else means another writer.
   */
  private async writeOnce(index: number, bytes: Uint8Array): Promise<'written' | 'blocked' | { error: string }> {
    let checked = false;
    let error = 'no attempt made';
    for (let attempt = 0; attempt < this.timings.publishAttempts && !this.stopped; attempt++) {
      if (attempt > 0) {
        await sleep(retryDelayMs(attempt - 1, this.timings.retryBaseMs));
      }
      if (!checked) {
        const read = await this.feed.readSlot(index);
        if (read.kind === 'failed') {
          error = `read before write: ${read.error}`;
          continue;
        }
        checked = true;
        if (read.kind === 'unreadable') {
          this.block(`slot ${index} holds a chunk that is not an update of this feed: ${read.error}`);
          return 'blocked';
        }
        if (read.kind === 'found') {
          if (sameBytes(read.payload, bytes)) {
            return 'written';
          }
          this.block(`slot ${index} already holds an entry this server did not write`);
          return 'blocked';
        }
      }
      const write = await this.feed.writeSlot(index, bytes);
      if (write.kind === 'written') {
        return 'written';
      }
      error = write.error;
    }
    return { error };
  }

  /** Resolves a write given up on at the slot about to be used. False while the slot cannot be read. */
  private async settleUnconfirmed(): Promise<boolean> {
    const unconfirmed = this.unconfirmed;
    if (!unconfirmed) {
      return true;
    }
    const read = await this.feed.readSlot(unconfirmed.index);
    if (read.kind === 'failed') {
      this.lastError = `slot ${unconfirmed.index}: ${read.error}`;
      await sleep(this.timings.retryBaseMs);
      return false;
    }
    this.unconfirmed = undefined;
    if (read.kind === 'unreadable' || (read.kind === 'found' && !sameBytes(read.payload, unconfirmed.bytes))) {
      this.block(`slot ${unconfirmed.index}, given up on, now holds something else`);
      return false;
    }
    if (read.kind === 'found') {
      this.logger.warn(`[chat ${this.topic}] slot ${unconfirmed.index}, given up on, had landed after all`);
      await this.recordPublished(unconfirmed.row);
    }
    return true;
  }

  private async recordPublished(row: HistoryRow): Promise<void> {
    this.nextIndex = row.seq + 1;
    this.publishedIds.add(messageKey(row.msg));
    this.history.append(row);
    this.stats.published += 1;
    this.lastPublishAt = Date.now();
    this.lastError = null;
    this.failing = false;
    await this.writeCheckpoint(row.seq, this.history.newestLink);
    void this.history.requestSave();
  }

  /** Checkpoint writes run one after another, so a later state never lands under an earlier one. */
  private writeCheckpoint(index: number, history: HistoryLink | null): Promise<void> {
    this.checkpointWrites = this.checkpointWrites.then(async () => {
      try {
        await this.checkpoints.write({ topic: this.topic, index, history });
      } catch (error) {
        this.logger.error(`[chat ${this.topic}] checkpoint write failed`, errorText(error));
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
    this.lastError = `another writer: ${reason}`;
    this.logger.error(`[chat ${this.topic}] stopped publishing, ${reason}`);
    for (const pending of this.queue.splice(0)) {
      this.stats.drop(DropReason.ChatBlocked);
      this.logger.warn(`[chat ${this.topic}] dropped, chat blocked`, deadLetterLine(pending.msg));
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
