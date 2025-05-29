import { Bee, Bytes, FeedIndex, Identifier, PrivateKey, Topic } from '@ethersphere/bee-js';
import PQueue from 'p-queue';

import { DAY } from '../utils/constants.js';
import { getEnvVariable } from '../utils/env.js';

import { ErrorHandler } from './error.js';
import { Logger } from './logger.js';

const GSOC_BEE_URL = getEnvVariable('GSOC_BEE_URL');
const GSOC_RESOURCE_ID = getEnvVariable('GSOC_RESOURCE_ID');
const GSOC_TOPIC = getEnvVariable('GSOC_TOPIC');

const CHAT_BEE_URL = getEnvVariable('CHAT_BEE_URL');
const CHAT_KEY = getEnvVariable('CHAT_KEY');
const CHAT_STAMP = getEnvVariable('CHAT_STAMP');

type TopicState = {
  index: FeedIndex;
  queue: PQueue;
  lastUsed: number;
  initPromise: Promise<void>;
};

export class SwarmAggregator {
  private gsocBee: Bee;
  private chatBee: Bee;
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();
  private gsocQueue = new PQueue({ concurrency: 1 });

  private topicStates = new Map<string, TopicState>();
  private messageCache = new Map<string, null>();
  private readonly maxCacheSize = 50_000;
  private readonly minCacheSize = 1_000;
  private readonly maxTopicStateAge = 2 * DAY;
  private readonly topicStateCleanupInterval = 1 * DAY;

  constructor() {
    this.gsocBee = new Bee(GSOC_BEE_URL);
    this.chatBee = new Bee(CHAT_BEE_URL);
  }

  private async initializeTopic(topicName: string): Promise<void> {
    const topic = Topic.fromString(topicName);
    const signer = new PrivateKey(CHAT_KEY);
    const publicKey = signer.publicKey().address();
    const feedReader = this.chatBee.makeFeedReader(topic, publicKey);

    try {
      const data = await feedReader.downloadPayload();
      this.logger.info(`Init topic ${topicName} feed index: ${data.feedIndex.toString()}`);

      const topicState = this.topicStates.get(topicName);
      if (topicState) {
        topicState.index = data.feedIndex.next();
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        this.logger.warn(`Topic ${topicName} not found, starting fresh.`);

        const topicState = this.topicStates.get(topicName);
        if (topicState) {
          topicState.index = FeedIndex.fromBigInt(BigInt(0));
        }
      } else {
        this.errorHandler.handleError(error, `initializeTopic:${topicName}`);
      }
    }
  }

  //TODO: process requests in a batch
  public subscribeToGsoc() {
    const key = new PrivateKey(GSOC_RESOURCE_ID);
    const identifier = Identifier.fromString(GSOC_TOPIC);

    const gsocSub = this.gsocBee.gsocSubscribe(key.publicKey().address(), identifier, {
      onMessage: (message: Bytes) => this.gsocQueue.add(() => this.gsocCallback(message)),
      onError: console.error,
    });

    this.logger.info(`Subscribed to gsoc. Topic: ${GSOC_TOPIC} Resource ID: ${GSOC_RESOURCE_ID}`);

    return gsocSub;
  }

  private async gsocCallback(message: Bytes) {
    const parsed = this.parseIncomingMessage(message);
    if (!parsed) return;

    const { topicName } = parsed;
    const topicState = await this.getOrCreateTopicState(topicName);

    topicState.queue.add(() => this.processMessageForTopic(topicName, topicState, message));
  }

  // TODO: process requests in a batch and add more sophisticated validation
  private parseIncomingMessage(message: Bytes): { topicName: string; message: Bytes } | null {
    try {
      if (!this.shouldProcessMessage(message)) {
        this.logger.debug('Duplicate message dropped.');
        return null;
      }

      const parsed = message.toJSON() as any;

      if (!parsed.chatTopic) {
        this.logger.error('Invalid message format: missing topic');
        return null;
      }

      return { topicName: parsed.chatTopic, message };
    } catch (error) {
      this.logger.error('Failed to parse incoming message:', error);
      return null;
    }
  }

  private async getOrCreateTopicState(topicName: string): Promise<TopicState> {
    if (!this.topicStates.has(topicName)) {
      this.topicStates.set(topicName, {
        index: FeedIndex.fromBigInt(BigInt(0)),
        queue: new PQueue({ concurrency: 1 }),
        lastUsed: Date.now(),
        initPromise: this.initializeTopic(topicName),
      });
    }

    const topicState = this.topicStates.get(topicName)!;
    topicState.lastUsed = Date.now();
    await topicState.initPromise;
    return topicState;
  }

  private async processMessageForTopic(topicName: string, topicState: TopicState, message: Bytes): Promise<void> {
    const topic = Topic.fromString(topicName);
    const signer = new PrivateKey(CHAT_KEY);
    const feedWriter = this.chatBee.makeFeedWriter(topic, signer);

    const res = await feedWriter.uploadPayload(CHAT_STAMP, message.toUint8Array(), {
      index: topicState.index,
    });

    this.logger.info(`Feed write success on topic ${topicName}: ${res.reference}`);

    topicState.index = topicState.index.next();
  }

  public startTopicCleaner() {
    setInterval(() => {
      const now = Date.now();
      for (const [topic, state] of this.topicStates) {
        if (now - state.lastUsed > this.maxTopicStateAge) {
          this.logger.info(`Removing inactive topic queue: ${topic}`);
          this.topicStates.delete(topic);
        }
      }
    }, this.topicStateCleanupInterval);
  }

  private shouldProcessMessage(message: Bytes): boolean {
    const key = message.toHex();

    if (this.messageCache.has(key)) {
      return false;
    }

    this.messageCache.set(key, null);

    if (this.messageCache.size > this.maxCacheSize) {
      const excess = this.messageCache.size - this.minCacheSize;
      const keys = this.messageCache.keys();

      for (let i = 0; i < excess; i++) {
        const oldestKey = keys.next().value;
        if (oldestKey !== undefined) {
          this.messageCache.delete(oldestKey);
        }
      }

      this.logger.info(`Message cache pruned. Kept last ${this.minCacheSize} entries.`);
    }

    return true;
  }
}
