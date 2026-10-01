import { encodeSlotNote, noteSlotEnd, noteSlotOf } from '@solarpunkltd/swarm-chat-js/message';

import type { Logger } from '../libs/logger.js';
import type { ChatFeed } from './slots.js';

export type NoteTimings = { slotMs: number; heartbeatMs: number };

export type NoteHealth = {
  written: number;
  failed: number;
  lastWrittenAt: number | null;
  lastError: string | null;
};

/** The newest slot no note has named yet, apart from a chat that has had no note at all. */
const NOTHING_NAMED = -2;

/**
 * Writes one chat's slot notes. Once a time slot ends, its note names the newest feed slot confirmed, when that is
 * newer than what the last note written named, or when a heartbeat has passed since that note. Only confirmed slots
 * are named, so an entry's own write has finished before any note names it.
 *
 * A note that fails is never written again at its own address, where a viewer may already have asked and been
 * refused. What it would have said stays unnamed, so the next slot's note says it, and the one after that, until a
 * write succeeds.
 */
export class SlotNoteWriter {
  private named = NOTHING_NAMED;
  private lastWrittenAt: number | null = null;
  private lastTickedSlot = Number.NEGATIVE_INFINITY;
  private written = 0;
  private failed = 0;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | undefined;
  private writing = false;
  private running = false;

  constructor(
    private readonly topic: string,
    private readonly feed: Pick<ChatFeed, 'writeNote'>,
    private readonly timings: NoteTimings,
    /** The newest feed slot confirmed, -1 for a chat with none. */
    private readonly newest: () => number,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduleNextSlotEnd();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  health(): NoteHealth {
    return {
      written: this.written,
      failed: this.failed,
      lastWrittenAt: this.lastWrittenAt,
      lastError: this.lastError,
    };
  }

  private scheduleNextSlotEnd(): void {
    if (!this.running) {
      return;
    }
    const now = this.now();
    const delay = noteSlotEnd(noteSlotOf(now, this.timings.slotMs), this.timings.slotMs) - now;
    this.timer = setTimeout(() => void this.slotEnded(), delay);
    this.timer.unref();
  }

  private async slotEnded(): Promise<void> {
    const now = this.now();
    const ended = noteSlotOf(now, this.timings.slotMs) - 1;
    // A timer that fires a moment before the wall clock reaches the boundary would tick the same slot twice.
    if (ended <= this.lastTickedSlot || this.writing) {
      this.scheduleNextSlotEnd();
      return;
    }
    this.lastTickedSlot = ended;
    const newest = this.newest();
    if (newest > this.named || this.heartbeatDue(now)) {
      this.writing = true;
      try {
        await this.write(ended, newest, now);
      } finally {
        this.writing = false;
      }
    }
    this.scheduleNextSlotEnd();
  }

  private heartbeatDue(now: number): boolean {
    return this.lastWrittenAt === null || now - this.lastWrittenAt >= this.timings.heartbeatMs;
  }

  private async write(slot: number, newest: number, writtenAt: number): Promise<void> {
    const outcome = await this.feed.writeNote(slot, encodeSlotNote({ newest, writtenAt }));
    if (outcome.kind === 'written') {
      this.named = Math.max(this.named, newest);
      this.lastWrittenAt = writtenAt;
      this.written += 1;
      this.lastError = null;
      return;
    }
    this.failed += 1;
    if (this.lastError === null) {
      this.logger.warn(
        `[chat ${this.topic}] the note of time slot ${slot} was not written, the next slot's carries it`,
        outcome.error,
      );
    }
    this.lastError = outcome.error;
  }
}
