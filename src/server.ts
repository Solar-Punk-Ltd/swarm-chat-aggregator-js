import { type AddressInfo } from 'node:net';
import * as http from 'node:http';

import { Bee, RedundancyLevel } from '@ethersphere/bee-js';

import { type ChatHealth, ChatPublisher } from './chat.js';
import { CheckpointStore } from './checkpoint.js';
import { BeeChatFeed, describeError } from './feed/slots.js';
import { SentNonces } from './heartbeat.js';
import {
  type HistoryFile,
  type HistoryLimits,
  HistoryBook,
  type HistoryStore,
  type SaveOutcome,
  historyFileSchema,
} from './history.js';
import { Intake } from './intake.js';
import type { Logger } from './libs/logger.js';
import { GsocListener } from './listener.js';
import { FolderLock } from './lock.js';
import type { Settings } from './settings.js';
import { Stats } from './stats.js';
import { retryDelayMs } from './utils/backoff.js';
import { sleep } from './utils/sleep.js';

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
  counts: { received: number; published: number; heartbeats: number; dropped: Record<string, number> };
  chats: (ChatHealth & { secondsSinceLastPublish: number | null })[];
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
  private readonly historyStore: HistoryStore;
  private readonly listener: GsocListener;
  private readonly intake: Intake;
  private readonly logger: Logger;
  private health: http.Server | undefined;
  private pruneTimer: NodeJS.Timeout | undefined;
  private stopping = false;

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
    this.historyStore = new BeeHistoryStore(this.writeBee, settings.writeStamp, settings.requestTimeoutMs);
    this.intake = new Intake(
      settings.allowedChats,
      settings.rates,
      this.sentNonces,
      (topic) => this.chatFor(topic),
      this.stats,
      this.logger,
    );
    this.listener = new GsocListener(
      new Bee(settings.listenBeeUrl),
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
    const chats = [...this.chats.values()].map((chat) => {
      const health = chat.health();
      if (health.failing) {
        problems.push(`chat ${health.topic}: ${health.lastError ?? health.state}`);
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
      counts: {
        received: this.stats.received,
        published: this.stats.published,
        heartbeats: this.stats.heartbeatsReceived,
        dropped: this.stats.droppedByReason(),
      },
      chats,
    };
  }

  /** The chat's publisher, made on its first message while fewer than the cap are active. */
  private chatFor(topic: string): ChatPublisher | undefined {
    const existing = this.chats.get(topic);
    if (existing || this.stopping) {
      return existing;
    }
    if (this.chats.size >= this.settings.allowedChats.maxActive) {
      return undefined;
    }
    const settings = this.settings;
    let chat: ChatPublisher | undefined;
    const book = new HistoryBook(
      topic,
      this.historyStore,
      (save) => this.saveWithRetries(topic, save),
      (link) => void chat?.recordHistory(link),
      this.options.historyLimits,
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
      ),
      book,
      this.historyStore,
      this.checkpoints,
      {
        queueLimit: settings.queueLimit,
        publishAttempts: settings.publishAttempts,
        retryBaseMs: settings.retryBaseMs,
        resumeRetryMs: settings.resumeRetryMs,
      },
      this.stats,
      this.logger,
    );
    this.chats.set(topic, chat);
    chat.start();
    return chat;
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

/** History files as ordinary Swarm data at today's redundancy level, uploaded directly and never deferred. */
export class BeeHistoryStore implements HistoryStore {
  constructor(
    private readonly bee: Bee,
    private readonly stamp: string,
    private readonly timeoutMs: number,
  ) {}

  async upload(file: HistoryFile): Promise<string> {
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

  async download(ref: string): Promise<HistoryFile> {
    const data = await this.bee.data.download(ref, undefined, { signal: AbortSignal.timeout(this.timeoutMs) });
    return historyFileSchema.parse(data.toJSON());
  }
}
