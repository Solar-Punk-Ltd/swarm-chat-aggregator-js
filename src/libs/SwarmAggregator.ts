import { Bee, Bytes, FeedIndex, Identifier, PrivateKey, RedundancyLevel, Topic } from '@ethersphere/bee-js';
import { MessageData, MessageStateRef, StatefulMessage } from '@solarpunkltd/swarm-chat-js';
import PQueue from 'p-queue';

import { DAY } from '../utils/constants.js';
import { getEnvVariable } from '../utils/env.js';

import { ErrorHandler } from './error.js';
import { Logger } from './logger.js';
import { NodeManager } from './NodeManager.js';

const GSOC_BEE_URL = getEnvVariable('GSOC_BEE_URL');
const GSOC_RESOURCE_ID = getEnvVariable('GSOC_RESOURCE_ID');
const GSOC_TOPIC = getEnvVariable('GSOC_TOPIC');

const CHAT_BEE_URL = getEnvVariable('CHAT_BEE_URL');
const CHAT_KEY = getEnvVariable('CHAT_KEY');
const CHAT_STAMP = getEnvVariable('CHAT_STAMP');

const NGINX_ADMIN_SECRET = getEnvVariable('NGINX_ADMIN_SECRET');

type TopicState = {
  index: FeedIndex;
  queue: PQueue;
  lastUsed: number;
  initPromise: Promise<void>;
  messageState: MessageData[] | null;
  messageStateRefs: MessageStateRef[];
};

// TODO tech debt: make types optional for non gateway solutions
export class SwarmAggregator {
  private chatWriterBee: Bee | undefined;
  private readonly gsocBee: Bee;
  private readonly chatReaderBee: Bee;
  private readonly logger = Logger.getInstance();
  private readonly errorHandler = ErrorHandler.getInstance();
  private readonly gsocQueue = new PQueue({ concurrency: 1 });

  private readonly topicStates = new Map<string, TopicState>();
  private readonly messageCache = new Map<string, string | null>();

  private readonly maxCacheSize = 1000;
  private readonly minCacheSize = 100;
  private readonly maxTopicStateAge = 2 * DAY;
  private readonly topicStateCleanupInterval = 1 * DAY;
  private readonly maxMessageStateSize = 10 * 1024 * 1024; // 10MB in bytes

  private readonly nodeManager = new NodeManager(CHAT_BEE_URL, NGINX_ADMIN_SECRET);

  constructor() {
    this.gsocBee = new Bee(GSOC_BEE_URL, {
      headers: {
        'X-MSRS-Admin-Token': NGINX_ADMIN_SECRET,
      },
    });
    this.chatReaderBee = new Bee(`${CHAT_BEE_URL}/read`);
  }

  public subscribeToGsoc() {
    const key = new PrivateKey(GSOC_RESOURCE_ID);
    const identifier = Identifier.fromString(GSOC_TOPIC);

    const gsocSub = this.gsocBee.gsocSubscribe(key.publicKey().address(), identifier, {
      onMessage: (message: Bytes) => this.gsocQueue.add(() => this.handleGsocMessage(message)),
      onError: console.error,
    });

    this.logger.info(`Subscribed to gsoc. Topic: ${GSOC_TOPIC} Resource ID: ${GSOC_RESOURCE_ID}`);

    return gsocSub;
  }

  public startTopicCleaner() {
    setInterval(() => {
      this.cleanupInactiveTopics();
    }, this.topicStateCleanupInterval);
  }

  private async handleGsocMessage(message: Bytes): Promise<void> {
    const parsed = this.parseIncomingMessage(message);
    if (!parsed) return;

    const { topicName } = parsed;
    const topicState = await this.getOrCreateTopicState(topicName);

    await topicState.queue.add(() => this.processMessageForTopic(topicName, topicState, message));
  }

  private parseIncomingMessage(message: Bytes): { topicName: string; message: Bytes } | null {
    try {
      if (!this.shouldProcessMessage(message)) {
        this.logger.debug('Duplicate message dropped.');
        return null;
      }

      const parsed = message.toJSON() as MessageData;

      if (!parsed.chatTopic) {
        this.logger.error('Invalid message format: missing topic');
        return null;
      }

      if (!parsed?.additionalProps?.streamId) {
        this.logger.error('Invalid message format: missing streamId in additionalProps');
        return null;
      }

      return { topicName: parsed.chatTopic, message };
    } catch (error) {
      this.logger.error('Failed to parse incoming message:', error);
      return null;
    }
  }

  private async getOrCreateTopicState(topicName: string): Promise<TopicState> {
    let topicState = this.topicStates.get(topicName);

    if (!topicState) {
      topicState = this.createNewTopicState(topicName);
      this.topicStates.set(topicName, topicState);
    }

    topicState.lastUsed = Date.now();
    await topicState.initPromise;
    return topicState;
  }

  private createNewTopicState(topicName: string): TopicState {
    return {
      index: FeedIndex.fromBigInt(BigInt(0)),
      queue: new PQueue({ concurrency: 1 }),
      lastUsed: Date.now(),
      initPromise: this.initializeTopic(topicName),
      messageState: null,
      messageStateRefs: [],
    };
  }

  private async initializeTopic(topicName: string): Promise<void> {
    const topic = Topic.fromString(topicName);
    const signer = new PrivateKey(CHAT_KEY);
    const publicKey = signer.publicKey().address();
    const feedReader = this.chatReaderBee.makeFeedReader(topic, publicKey);

    try {
      const data = await feedReader.downloadPayload();
      this.logger.info(`Init topic ${topicName} feed index: ${data.feedIndex.toString()}`);

      await this.updateTopicStateFromFeedData(topicName, data);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        this.logger.warn(`Topic ${topicName} not found, starting fresh.`);
        this.initializeTopicStateAsEmpty(topicName);
      } else {
        this.errorHandler.handleError(error, `initializeTopic:${topicName}`);
      }
    }
  }

  private async updateTopicStateFromFeedData(topicName: string, data: any): Promise<void> {
    const topicState = this.topicStates.get(topicName);
    if (!topicState) return;

    topicState.index = data.feedIndex.next();

    try {
      const lastMessageState = data.payload.toJSON() as StatefulMessage;
      if (lastMessageState?.messageStateRefs && Array.isArray(lastMessageState.messageStateRefs)) {
        topicState.messageStateRefs = lastMessageState.messageStateRefs as MessageStateRef[];

        if (topicState.messageStateRefs.length > 0) {
          const latestRef = topicState.messageStateRefs.reduce((latest, current) =>
            current.timestamp > latest.timestamp ? current : latest,
          );
          const state = await this.chatReaderBee.downloadData(latestRef.reference);
          topicState.messageState = state.toJSON() as MessageData[];
        }
      }
    } catch (error) {
      this.logger.error(`Failed to parse last message state for topic ${topicName}:`, error);
    }
  }

  private initializeTopicStateAsEmpty(topicName: string): void {
    const topicState = this.topicStates.get(topicName);
    if (topicState) {
      topicState.index = FeedIndex.fromBigInt(BigInt(0));
    }
  }

  private isNotFoundError(error: unknown): boolean {
    return error instanceof Error && error.message.includes('404');
  }

  private async processMessageForTopic(topicName: string, topicState: TopicState, message: Bytes): Promise<void> {
    const data = message.toJSON() as MessageData;
    const stateRefs = await this.handleMessageState(topicState, data);

    const newData = {
      message: data,
      messageStateRefs: stateRefs && stateRefs.length > 0 ? stateRefs : null,
    };

    const nodeInfo = await this.nodeManager.getRequiredChatNode(data?.additionalProps?.streamId);

    this.chatWriterBee = nodeInfo
      ? new Bee(`${CHAT_BEE_URL}/admin/direct/${nodeInfo.port}`, {
          headers: {
            'X-MSRS-Admin-Token': NGINX_ADMIN_SECRET,
          },
        })
      : new Bee(`${CHAT_BEE_URL}/write`);

    const topic = Topic.fromString(topicName);
    const signer = new PrivateKey(CHAT_KEY);
    const feedWriter = this.chatWriterBee.makeFeedWriter(topic, signer);

    const res = await feedWriter.uploadPayload(CHAT_STAMP, JSON.stringify(newData), {
      index: topicState.index,
    });

    this.logger.info(`Feed write success on topic ${topicName}: ${res.reference}`);
    topicState.index = topicState.index.next();
  }

  private async handleMessageState(topicState: TopicState, message: MessageData): Promise<MessageStateRef[] | null> {
    if (!this.chatWriterBee) {
      this.logger.error('Chat writer bee is not initialized.');
      return null;
    }

    const currState = topicState.messageState || [];
    currState.push(message);

    const stateString = JSON.stringify(currState);
    const stateSize = new TextEncoder().encode(stateString).length;

    if (stateSize > this.maxMessageStateSize) {
      const newState = [message];
      const newStateString = JSON.stringify(newState);

      const uploadResult = await this.chatWriterBee.uploadData(CHAT_STAMP, newStateString, {
        redundancyLevel: RedundancyLevel.INSANE,
      });

      const newRef: MessageStateRef = {
        reference: uploadResult.reference.toString(),
        timestamp: Date.now(),
      };

      topicState.messageStateRefs.push(newRef);
      topicState.messageState = newState;

      this.logger.info(
        `Created new message state reference due to size limit. Total refs: ${topicState.messageStateRefs.length}`,
      );

      return topicState.messageStateRefs;
    } else {
      const uploadResult = await this.chatWriterBee.uploadData(CHAT_STAMP, stateString, {
        redundancyLevel: RedundancyLevel.INSANE,
      });

      const newRef: MessageStateRef = {
        reference: uploadResult.reference.toString(),
        timestamp: Date.now(),
      };

      if (topicState.messageStateRefs.length > 0) {
        const latestIndex = topicState.messageStateRefs.reduce(
          (latestIdx, current, idx, arr) => (current.timestamp > arr[latestIdx].timestamp ? idx : latestIdx),
          0,
        );
        topicState.messageStateRefs[latestIndex] = newRef;
      } else {
        topicState.messageStateRefs.push(newRef);
      }

      topicState.messageState = currState;

      return topicState.messageStateRefs;
    }
  }

  private cleanupInactiveTopics(): void {
    const now = Date.now();
    for (const [topic, state] of this.topicStates) {
      if (now - state.lastUsed > this.maxTopicStateAge) {
        this.logger.info(`Removing inactive topic queue: ${topic}`);
        this.topicStates.delete(topic);
      }
    }
  }

  private shouldProcessMessage(message: Bytes): boolean {
    const key = message.toHex();

    if (this.messageCache.has(key)) {
      return false;
    }

    this.messageCache.set(key, null);
    this.pruneMessageCacheIfNeeded();

    return true;
  }

  private pruneMessageCacheIfNeeded(): void {
    if (this.messageCache.size <= this.maxCacheSize) {
      return;
    }

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
}
