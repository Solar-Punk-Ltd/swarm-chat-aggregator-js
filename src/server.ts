import { type AddressInfo } from 'node:net';
import * as http from 'node:http';

import { Bee, RedundancyLevel } from '@ethersphere/bee-js';
import { type HistoryFile, type HistoryLink, parseHistoryFile } from '@solarpunkltd/swarm-chat-js/message';

import { type ChatHealth, ChatPublisher } from './chat.js';
import { CheckpointStore } from './checkpoint.js';
import { BeeChatFeed, describeError } from './feed/slots.js';
import { SentNonces } from './heartbeat.js';
import {
  type HistoryLimits,
  HistoryBook,
  type HistoryStore,
  type SaveOutcome,
  type UploadedHistoryFile,
} from './history.js';
import { Intake } from './intake.js';
import { findHeadWithoutCheckpoint } from './newChat.js';
import type { Logger } from './libs/logger.js';
import { GsocListener } from './listener.js';
import { FolderLock } from './lock.js';
import type { Settings } from './settings.js';
import { Stats } from './stats.js';
import { retryDelayMs } from './utils/backoff.js';
import { sleep } from './utils/sleep.js';
import type { PublishTimingSummary } from './utils/timings.js';

export type HealthReport = {
  healthy: boolean;
  problems: string[];
  uptimeSeconds: number;
  secondsSinceFrame: number | null;
  secondsSinceHeartbeatSent: number | null;
  secondsSinceHeartbeatReceived: number | null;
  lastHeartbeatSendError: string | null;
  lastSubscribeError: string | null;
  subscribed: boolean;
  resubscribes: number;
  activeChats: number;
  evictions: number;
  counts: { received: number; published: number; heartbeats: number; dropped: Record<string, number> };
  chats: (ChatHealth & { secondsSinceLastPublish: number | null })[];
  /** Measured and reported, never asserted and never used to decide anything. */
  observations: { publishTimings: ({ topic: string } & PublishTimingSummary)[] };
};

export type ServerOptions = {
  logger: Logger;
  /** Called when the server can no longer publish safely, such as when another instance took the lock. */
  onFatal: (reason: string) => void;
  historyLimits?: HistoryLimits;
};

const PRUNE_INTERVAL_MS = 60_000;

/** The chat server: the GSOC listener, the checks, one publisher per chat, the lock and the health check. */
export class AggregatorServer {
  readonly stats = new Stats();
  private readonly startedAt = Date.now();
  private readonly sentNonces = new SentNonces();
  private readonly chats = new Map<string, ChatPublisher>();
  private readonly checkpoints: CheckpointStore;
  private readonly lock: FolderLock;
  private readonly writeBee: Bee;
  private readonly listenBee: Bee;
  private readonly historyStore: HistoryStore;
  private readonly listener: GsocListener;
  private readonly intake: Intake;
  private readonly logger: Logger;
  private health: http.Server | undefined;
  private pruneTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private evictions = 0;
  private lastCapRefusalAt: number | null = null;

  constructor(
    private readonly settings: Settings,
    private readonly options: ServerOptions,
  ) {
    this.logger = options.logger;
    this.checkpoints = new CheckpointStore(settings.checkpointDir);
    this.lock = new FolderLock(
      settings.checkpointDir,
      { refreshMs: settings.lockRefreshMs, staleMs: settings.lockStaleMs },
      (reason) => this.fail(`lost the checkpoint lock: ${reason}`),
    );
    this.writeBee = new Bee(settings.writeBeeUrl);
    this.listenBee = new Bee(settings.listenBeeUrl);
    this.historyStore = new BeeHistoryStore(this.writeBee, settings.writeStamp, settings.historyTimeoutMs);
    this.intake = new Intake(
      settings.allowedChats,
      settings.rates,
      this.sentNonces,
      (topic) => this.chatFor(topic),
      this.stats,
      this.logger,
    );
    this.listener = new GsocListener(
      this.listenBee,
      new Bee(settings.heartbeatBeeUrl),
      settings.heartbeatStamp,
      settings.gsocKey,
      settings.gsocIdentifier,
      this.sentNonces,
      {
        resubscribeIdleMs: settings.resubscribeIdleMs,
        heartbeatIntervalMs: settings.heartbeatIntervalMs,
        requestTimeoutMs: settings.requestTimeoutMs,
      },
      (payload) => this.intake.receive(payload),
      this.logger,
    );
  }

  /** The port the health check listens on, once started. */
  get healthPort(): number | undefined {
    const address = this.health?.address();
    return typeof address === 'object' && address ? (address as AddressInfo).port : undefined;
  }

  async start(): Promise<void> {
    await this.checkpoints.prepare();
    await this.lock.acquire();
    this.health = http.createServer((request, response) => this.answerHealth(request, response));
    await new Promise<void>((resolve) => this.health?.listen(this.settings.healthPort, resolve));
    this.listener.start();
    // A listed chat is opened at once rather than on its first message, so its viewers find a note from the start.
    for (const topic of this.settings.allowedChats.topics) {
      this.chatFor(topic);
    }
    this.pruneTimer = setInterval(() => this.intake.prune(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
    this.logger.info(`[server] started, health on port ${this.healthPort}, lock instance ${this.lock.instance}`);
  }

  /** Stops intake, publishes what is queued until the deadline, then releases the lock. */
  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.listener.stop();
    clearInterval(this.pruneTimer);
    await Promise.all([...this.chats.values()].map((chat) => chat.drain(this.settings.shutdownDeadlineMs)));
    await this.lock.release();
    await new Promise<void>((resolve) => (this.health ? this.health.close(() => resolve()) : resolve()));
    this.health?.closeAllConnections();
    this.logger.info('[server] stopped');
  }

  healthReport(now = Date.now()): HealthReport {
    const listener = this.listener.health();
    const intake = this.intake.health();
    const stale = this.settings.heartbeatStaleMs;
    const age = (at: number | null) => (at === null ? null : Math.round((now - at) / 1000));
    const overdue = (at: number | null) => (at === null ? now - this.startedAt > stale : now - at > stale);

    const problems: string[] = [];
    if (!listener.subscribed) {
      problems.push(
        `not subscribed on the listener${listener.lastSubscribeError ? `, ${listener.lastSubscribeError}` : ''}`,
      );
    }
    if (overdue(listener.lastFrameAt)) {
      problems.push('no GSOC frame received recently');
    }
    if (overdue(listener.lastHeartbeatSentAt)) {
      problems.push(
        `no heartbeat sent recently${listener.lastHeartbeatSendError ? `, ${listener.lastHeartbeatSendError}` : ''}`,
      );
    }
    if (overdue(intake.lastHeartbeatReceivedAt)) {
      problems.push('no heartbeat received back on the listener recently');
    }
    if (this.lastCapRefusalAt !== null && now - this.lastCapRefusalAt < this.settings.chatIdleEvictMs) {
      problems.push('a new chat was refused recently at MAX_ACTIVE_CHATS, with no quiet chat to evict');
    }
    const chats = [...this.chats.values()].map((chat) => {
      const health = chat.health();
      if (health.lastHistoryError) {
        problems.push(`chat ${health.topic}: history save failed: ${health.lastHistoryError}`);
      }
      if (health.historyTrail > this.settings.historyTrailLimit) {
        problems.push(
          `chat ${health.topic}: ${health.historyTrail} rows since the last saved history file, over HISTORY_TRAIL_LIMIT`,
        );
      }
      if (health.failing) {
        const stall = health.stall
          ? `, slot ${health.stall.slot} stuck for ${health.stall.stuckSeconds} s after ${health.stall.attempts} attempts`
          : '';
        problems.push(`chat ${health.topic}: ${health.lastError ?? health.state}${stall}`);
      }
      return { ...health, secondsSinceLastPublish: age(health.lastPublishAt) };
    });

    return {
      healthy: problems.length === 0,
      problems,
      uptimeSeconds: age(this.startedAt) ?? 0,
      secondsSinceFrame: age(listener.lastFrameAt),
      secondsSinceHeartbeatSent: age(listener.lastHeartbeatSentAt),
      secondsSinceHeartbeatReceived: age(intake.lastHeartbeatReceivedAt),
      lastHeartbeatSendError: listener.lastHeartbeatSendError,
      lastSubscribeError: listener.lastSubscribeError,
      subscribed: listener.subscribed,
      resubscribes: listener.resubscribes,
      activeChats: this.chats.size,
      evictions: this.evictions,
      counts: {
        received: this.stats.received,
        published: this.stats.published,
        heartbeats: this.stats.heartbeatsReceived,
        dropped: this.stats.droppedByReason(),
      },
      chats,
      observations: {
        publishTimings: [...this.chats.values()].flatMap((chat) => {
          const summary = chat.publishTimingSummary();
          return summary ? [{ topic: chat.topic, ...summary }] : [];
        }),
      },
    };
  }

  /** The chat's publisher, made on its first message while fewer than the cap are active. */
  private chatFor(topic: string): ChatPublisher | undefined {
    const existing = this.chats.get(topic);
    if (existing || this.stopping) {
      return existing;
    }
    if (!this.settings.allowedChats.topics.has(topic) && !this.makeRoomForPatternChat()) {
      this.lastCapRefusalAt = Date.now();
      return undefined;
    }
    const settings = this.settings;
    let chat: ChatPublisher | undefined;
    const book = new HistoryBook(
      topic,
      this.historyStore,
      (save) => this.saveWithRetries(topic, save),
      () => void chat?.recordHistory(),
      this.options.historyLimits,
      settings.historySaveIntervalMs,
    );
    chat = new ChatPublisher(
      topic,
      new BeeChatFeed(
        this.writeBee,
        topic,
        settings.feedKey,
        settings.writeStamp,
        settings.readRecheckMs,
        settings.requestTimeoutMs,
        settings.noteSlotMs,
      ),
      book,
      this.historyStore,
      this.checkpoints,
      {
        queueLimit: settings.queueLimit,
        publishWindow: settings.publishWindow,
        publishAttempts: settings.publishAttempts,
        retryBaseMs: settings.retryBaseMs,
        resumeRetryMs: settings.resumeRetryMs,
        notes: { slotMs: settings.noteSlotMs, heartbeatMs: settings.noteHeartbeatMs },
      },
      this.stats,
      this.logger,
      (feed) =>
        findHeadWithoutCheckpoint(feed, {
          writer: this.writeBee,
          minConnectedPeers: settings.minConnectedPeers,
          requestTimeoutMs: settings.requestTimeoutMs,
          secondFeed: new BeeChatFeed(
            this.listenBee,
            topic,
            settings.feedKey,
            settings.writeStamp,
            settings.readRecheckMs,
            settings.crossCheckTimeoutMs,
            settings.noteSlotMs,
          ),
        }),
    );
    this.chats.set(topic, chat);
    chat.start();
    return chat;
  }

  /**
   * Whether one more chat outside CHAT_TOPICS fits under MAX_ACTIVE_CHATS. At the cap the least recently active
   * such chat that has been quiet for CHAT_IDLE_EVICT_MS is evicted, so topics invented to fill the cap cannot
   * hold out a real chat for ever. An evicted chat resumes from its checkpoint on its next message.
   */
  private makeRoomForPatternChat(now = Date.now()): boolean {
    const patternChats = [...this.chats.values()].filter((chat) => !this.settings.allowedChats.topics.has(chat.topic));
    if (patternChats.length < this.settings.allowedChats.maxActive) {
      return true;
    }
    const quiet = patternChats
      .map((chat) => ({ chat, since: chat.idleSince() }))
      .filter((candidate): candidate is { chat: ChatPublisher; since: number } => candidate.since !== undefined)
      .filter((candidate) => now - candidate.since >= this.settings.chatIdleEvictMs)
      .sort((a, b) => a.since - b.since)[0];
    if (!quiet) {
      return false;
    }
    quiet.chat.stop();
    this.chats.delete(quiet.chat.topic);
    this.evictions += 1;
    this.logger.info(`[server] evicted the quiet chat ${quiet.chat.topic} to make room at MAX_ACTIVE_CHATS`);
    return true;
  }

  private async saveWithRetries(topic: string, save: () => Promise<string>): Promise<SaveOutcome> {
    let error = 'no attempt made';
    for (let attempt = 0; attempt < this.settings.publishAttempts; attempt++) {
      if (attempt > 0) {
        await sleep(retryDelayMs(attempt - 1, this.settings.retryBaseMs));
      }
      try {
        return { kind: 'saved', ref: await save() };
      } catch (caught) {
        error = describeError(caught);
      }
    }
    this.logger.error(`[chat ${topic}] history save failed after ${this.settings.publishAttempts} attempts`, error);
    return { kind: 'failed', error };
  }

  private fail(reason: string): void {
    this.logger.error(`[server] ${reason}, stopping`);
    this.stopping = true;
    this.listener.stop();
    for (const chat of this.chats.values()) {
      chat.stop();
    }
    this.options.onFatal(reason);
  }

  private answerHealth(request: http.IncomingMessage, response: http.ServerResponse): void {
    if (request.method !== 'GET' || request.url !== '/health') {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found');
      return;
    }
    const report = this.healthReport();
    response.writeHead(report.healthy ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(report));
  }
}

/**
 * History files as ordinary Swarm data at today's redundancy level, uploaded directly and never deferred. A direct
 * upload answers only once every chunk and its parity is pushed, so a file gets its own timeout, not a chunk's.
 */
export class BeeHistoryStore implements HistoryStore {
  constructor(
    private readonly bee: Bee,
    private readonly stamp: string,
    private readonly timeoutMs: number,
  ) {}

  async upload(file: UploadedHistoryFile): Promise<string> {
    const result = await this.bee.data.upload(
      this.stamp,
      new TextEncoder().encode(JSON.stringify(file)),
      {
        redundancyLevel: RedundancyLevel.INSANE,
        deferred: false,
      },
      { signal: AbortSignal.timeout(this.timeoutMs) },
    );
    return result.reference.toHex();
  }

  async download(link: HistoryLink, topic: string): Promise<HistoryFile> {
    const data = await this.bee.data.download(link.ref, undefined, { signal: AbortSignal.timeout(this.timeoutMs) });
    const file = parseHistoryFile(data.toUint8Array(), topic, link);
    if (!file.ok) {
      throw new Error(`history file ${link.ref} refused, ${file.reason}: ${file.detail}`);
    }
    return file.value;
  }
}
