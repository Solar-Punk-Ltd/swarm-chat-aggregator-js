import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Bee, Identifier, PrivateKey } from '@ethersphere/bee-js';
import { type ChatMessageDraft, type SignedChatMessage, createChatMessage } from '@solarpunkltd/swarm-chat-js/message';

import type { FeedEntry } from '../../src/feed/entry.js';
import type { HistoryFile, HistoryLimits } from '../../src/history.js';
import { consoleLogger, silentLogger } from '../../src/libs/logger.js';
import { AggregatorServer } from '../../src/server.js';
import { type Environment, type Settings, parseSettings } from '../../src/settings.js';
import { FakeBeeNode, FakeSwarm } from './fakeBee.js';

/** Test-only keys and stamps, made fresh for every run and never used anywhere real. */
export function testKey(): string {
  return randomBytes(32).toString('hex');
}

export const CHAT = 'chat-test-stream';

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  what = 'condition',
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Three fake nodes sharing one fake network, as the server's listening, writing and heartbeat nodes. */
export class Rig {
  readonly feedKey = testKey();
  readonly gsocKey = testKey();
  readonly gsocIdentifier = 'chat-inbox-test';
  readonly stamp = randomBytes(32).toString('hex');
  readonly servers: AggregatorServer[] = [];
  fatal: string[] = [];

  private constructor(
    readonly swarm: FakeSwarm,
    readonly listener: FakeBeeNode,
    readonly writer: FakeBeeNode,
    readonly heartbeat: FakeBeeNode,
    readonly checkpointDir: string,
  ) {}

  static async start(): Promise<Rig> {
    const swarm = new FakeSwarm();
    const [listener, writer, heartbeat] = await Promise.all([
      FakeBeeNode.start(swarm),
      FakeBeeNode.start(swarm),
      FakeBeeNode.start(swarm),
    ]);
    const dir = await mkdtemp(join(tmpdir(), 'aggregator-test-'));
    return new Rig(swarm, listener, writer, heartbeat, dir);
  }

  get feedOwner(): string {
    return new PrivateKey(this.feedKey).publicKey().address().toHex();
  }

  environment(overrides: Partial<Environment> = {}): Environment {
    return {
      LISTEN_BEE_URL: this.listener.url,
      WRITE_BEE_URL: this.writer.url,
      HEARTBEAT_BEE_URL: this.heartbeat.url,
      WRITE_STAMP: this.stamp,
      HEARTBEAT_STAMP: this.stamp,
      FEED_KEY: this.feedKey,
      GSOC_KEY: this.gsocKey,
      GSOC_IDENTIFIER: this.gsocIdentifier,
      CHAT_TOPICS: CHAT,
      CHAT_TOPIC_PATTERN: 'chat-pattern-.*',
      RATE_WINDOW_MS: '60000',
      RATE_PER_CHAT: '1000',
      RATE_PER_SENDER: '1000',
      RESUBSCRIBE_IDLE_MS: '60000',
      HEARTBEAT_INTERVAL_MS: '60000',
      HEARTBEAT_STALE_MS: '120000',
      READ_RECHECK_MS: '20',
      REQUEST_TIMEOUT_MS: '3000',
      RESUME_RETRY_MS: '50',
      PUBLISH_ATTEMPTS: '3',
      RETRY_BASE_MS: '10',
      SHUTDOWN_DEADLINE_MS: '3000',
      LOCK_REFRESH_MS: '50',
      LOCK_STALE_MS: '400',
      CHECKPOINT_DIR: this.checkpointDir,
      HEALTH_PORT: '0',
      ...overrides,
    } as Environment;
  }

  settings(overrides: Partial<Environment> = {}): Settings {
    return parseSettings(this.environment(overrides) as Record<string, string>);
  }

  server(overrides: Partial<Environment> = {}, historyLimits?: HistoryLimits): AggregatorServer {
    const server = new AggregatorServer(this.settings(overrides), {
      logger: process.env.TEST_LOG ? consoleLogger : silentLogger,
      onFatal: (reason) => this.fatal.push(reason),
      historyLimits,
    });
    this.servers.push(server);
    return server;
  }

  /** Starts a server and waits until its subscription reaches the listening node, as a send before that is lost. */
  async startServer(overrides: Partial<Environment> = {}, historyLimits?: HistoryLimits): Promise<AggregatorServer> {
    const server = this.server(overrides, historyLimits);
    await waitFor(() => this.listener.subscriberCount === 0, 5000, 'earlier subscriptions to close');
    await server.start();
    await waitFor(() => this.listener.subscriberCount > 0, 5000, 'the subscription');
    return server;
  }

  /** A browser's send: a signed message written to the GSOC inbox through the heartbeat node. */
  async send(message: SignedChatMessage | Uint8Array): Promise<void> {
    const bytes = message instanceof Uint8Array ? message : message.bytes;
    await new Bee(this.heartbeat.url).messaging.gsocSend(
      this.stamp,
      this.gsocKey,
      Identifier.fromString(this.gsocIdentifier),
      bytes,
      { deferred: false },
    );
  }

  entry(index: number, topic = CHAT): FeedEntry | undefined {
    return this.swarm.slotJson(this.feedOwner, topic, index) as FeedEntry | undefined;
  }

  history(ref: string): HistoryFile {
    const data = this.swarm.data.get(ref);
    if (!data) {
      throw new Error(`no history file ${ref}`);
    }
    return JSON.parse(new TextDecoder().decode(data)) as HistoryFile;
  }

  async stop(): Promise<void> {
    await Promise.all(this.servers.map((server) => server.stop().catch(() => undefined)));
    await Promise.all([this.listener.stop(), this.writer.stop(), this.heartbeat.stop()]);
    await rm(this.checkpointDir, { recursive: true, force: true });
  }
}

export function message(overrides: Partial<ChatMessageDraft> = {}, key = testKey()): SignedChatMessage {
  return createChatMessage(key, { topic: CHAT, type: 'text', text: 'hello', name: 'tester', ...overrides });
}
