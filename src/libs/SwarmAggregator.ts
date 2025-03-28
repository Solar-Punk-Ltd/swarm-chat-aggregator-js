import { Bee, Bytes, FeedIndex, Identifier, PrivateKey, Topic } from '@ethersphere/bee-js';

import { ChainEmitter } from './ChainEmitter';
import { ErrorHandler } from './error';
import { Logger } from './logger';
import { Queue } from './queue';

const GSOC_BEE_URL = process.env.GSOC_BEE_URL!;
const GSOC_RESOURCE_ID = process.env.GSOC_RESOURCE_ID!;
const GSOC_TOPIC = process.env.GSOC_TOPIC!;

const CHAT_BEE_URL = process.env.CHAT_BEE_URL!;
const CHAT_TOPIC = process.env.CHAT_TOPIC!;
const CHAT_KEY = process.env.CHAT_KEY!;
const CHAT_STAMP = process.env.CHAT_STAMP!;

export class SwarmAggregator {
  private gsocBee: Bee;
  private chatBee: Bee;
  private index: FeedIndex;
  private chainEmitter: ChainEmitter;
  private logger = Logger.getInstance();
  private errorHandler = new ErrorHandler();
  private queue = new Queue();

  private messageCache = new Map<string, null>();
  private readonly maxCacheSize = 50_000;
  private readonly minCacheSize = 1_000;

  constructor() {
    this.chainEmitter = new ChainEmitter();
    this.gsocBee = new Bee(GSOC_BEE_URL);
    this.chatBee = new Bee(CHAT_BEE_URL);
  }

  public async init() {
    try {
      const topic = Topic.fromString(CHAT_TOPIC);

      const signer = new PrivateKey(CHAT_KEY);
      const publicKey = signer.publicKey().address();
      const feedReader = this.chatBee.makeFeedReader(topic, publicKey);

      const data = await feedReader.downloadPayload();

      this.logger.info(`init feed index: ${data.feedIndex.toString()}`);
      this.index = data.feedIndex.next();
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        this.index = FeedIndex.fromBigInt(BigInt(0));
      } else {
        this.errorHandler.handleError(error, 'SwarmAggregator.init');
      }
    }
  }

  //TODO: process requests in a batch
  public subscribeToGsoc() {
    const key = new PrivateKey(GSOC_RESOURCE_ID);
    const identifier = Identifier.fromString(GSOC_TOPIC);

    const gsocSub = this.gsocBee.gsocSubscribe(key.publicKey().address(), identifier, {
      onMessage: (message: Bytes) => this.queue.enqueue(() => this.gsocCallback(message)),
      onError: this.logger.error,
    });

    this.logger.info(`Subscribed to gsoc. Topic: ${GSOC_TOPIC} Resource ID: ${GSOC_RESOURCE_ID}`);

    return gsocSub;
  }

  // TODO: validation
  private async gsocCallback(message: Bytes) {
    if (!this.shouldProcessMessage(message)) {
      this.logger.debug('Duplicate message dropped.');
      return;
    }

    this.logger.info(`gsocCallback message: ${message.toUtf8()}`);
    const topic = Topic.fromString(CHAT_TOPIC);
    const signer = new PrivateKey(CHAT_KEY);

    const feedWriter = this.chatBee.makeFeedWriter(topic, signer);

    const data = message.toUint8Array();
    const res = await feedWriter.uploadPayload(CHAT_STAMP, data, {
      index: this.index,
    });

    this.logger.info(`gsocCallback feed write result: ${res.reference}`);

    this.chainEmitter.emitEventWithRetry(`${CHAT_TOPIC}_${this.index.toString()}`);
    this.index = this.index.next();
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
