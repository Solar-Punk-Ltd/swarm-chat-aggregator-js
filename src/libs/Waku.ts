import { MessageData, MessageStateRef } from '@solarpunkltd/swarm-chat-js';
import { createLightNode, HealthStatus, type LightNode, ReliableChannel, WakuEvent } from '@solarpunkltd/waku-sdk';
import crypto from 'crypto';
import protobuf from 'protobufjs';

import { ErrorHandler } from '../libs/error.js';
import { Logger } from '../libs/logger.js';
import { getEnvVariableWithDefault, getShortMessageId, sleep } from '../utils/common.js';

const WAKU_STATIC_PEER = getEnvVariableWithDefault('WAKU_STATIC_PEER', '');

export enum MessageStatus {
  Sending = 'sending',
  Sent = 'sent',
  Acknowledged = 'acknowledged',
  Failed = 'failed',
}

export enum HealthRecoveryType {
  Minimal = 'minimal',
  Unhealthy = 'unhealthy',
}

interface MessageTracker {
  messageId: string;
  timestamp: number;
  status: MessageStatus;
  retryCount: number;
  payload: Uint8Array;
  topicName: string;
}

interface ChannelInfo {
  channel: ReliableChannel<any>;
  encoder: any;
  decoder: any;
  lastUsed: number;
  listeners: {
    messageSent: (event: Event) => void;
    messageAcknowledged: (event: Event) => void;
    sendError: (event: Event) => void;
  };
}

export enum NodeState {
  Stopped = 'stopped',
  Starting = 'starting',
  Ready = 'ready',
  Stopping = 'stopping',
  Recovering = 'recovering',
}

export class WakuHandler {
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  private static instance: WakuHandler | null = null;
  private node: LightNode | null = null;

  private channels = new Map<string, ChannelInfo>();
  private messagePayloadType: protobuf.Type | null = null;

  private readonly senderId = crypto.randomBytes(8).toString('hex');

  private nodeHealthListener: ((event: Event) => void) | null = null;
  private messageTrackers = new Map<string, MessageTracker>();
  private readonly maxRetries = 5;
  private currentHealth: HealthStatus = HealthStatus.Unhealthy;
  private nodeState: NodeState = NodeState.Stopped;
  private isRecoveryInProgress = false;
  private recoveryTimeoutId: NodeJS.Timeout | null = null;
  private messageCleanupInterval: NodeJS.Timeout | null = null;

  private static readonly RECOVERY_DELAY_MINIMAL = 8000;
  private static readonly RECOVERY_DELAY_UNHEALTHY = 10000;
  private static readonly RECOVERY_DELAY_RETRY = 20000;
  private static readonly NODE_RESTART_DELAY = 2000;
  private static readonly MESSAGE_TRACKER_TIMEOUT = 300000;
  private static readonly MESSAGE_CLEANUP_INTERVAL = 60000;

  private constructor() {
    this.createProtobufSchema();
  }

  public static getInstance(): WakuHandler {
    if (!WakuHandler.instance) {
      WakuHandler.instance = new WakuHandler();
    }
    return WakuHandler.instance;
  }

  private createProtobufSchema(): void {
    const MessageDataType = new protobuf.Type('MessageData')
      .add(new protobuf.Field('id', 1, 'string'))
      .add(new protobuf.Field('targetMessageId', 2, 'string', 'optional'))
      .add(new protobuf.Field('type', 3, 'string'))
      .add(new protobuf.Field('message', 4, 'string'))
      .add(new protobuf.Field('username', 5, 'string'))
      .add(new protobuf.Field('address', 6, 'string'))
      .add(new protobuf.Field('timestamp', 7, 'uint64'))
      .add(new protobuf.Field('signature', 8, 'string'))
      .add(new protobuf.Field('index', 9, 'uint32'))
      .add(new protobuf.Field('chatTopic', 10, 'string'))
      .add(new protobuf.Field('userTopic', 11, 'string'))
      .add(new protobuf.Field('additionalProps', 12, 'string', 'optional'));

    const MessageStateRefType = new protobuf.Type('MessageStateRef')
      .add(new protobuf.Field('reference', 1, 'string'))
      .add(new protobuf.Field('timestamp', 2, 'uint64'));

    this.messagePayloadType = new protobuf.Type('MessagePayload')
      .add(MessageDataType)
      .add(MessageStateRefType)
      .add(new protobuf.Field('message', 1, 'MessageData'))
      .add(new protobuf.Field('messageStateRefs', 2, 'MessageStateRef', 'repeated'));

    this.logger.info('Protobuf schema created for chat messages');
  }

  public async initializeNode(): Promise<void> {
    this.nodeState = NodeState.Starting;
    this.logger.info('Starting Waku Light Node...');

    if (!WAKU_STATIC_PEER) {
      throw new Error('WAKU_STATIC_PEER environment variable is required when Waku is enabled');
    }

    this.node = await createLightNode({
      defaultBootstrap: true,
      bootstrapPeers: [WAKU_STATIC_PEER],
    });

    this.setupNodeEventListeners();
    this.startMessageCleanup();

    this.nodeState = NodeState.Ready;
    this.logger.info('Waku Light Node started with reliable channel support');
  }

  private setupNodeEventListeners(): void {
    if (!this.node || !this.node.events) return;

    if (this.nodeHealthListener) {
      this.node.events.removeEventListener(WakuEvent.Health, this.nodeHealthListener);
    }

    this.nodeHealthListener = (event) => {
      this.handleHealthChange((event as CustomEvent).detail);
    };

    this.node.events.addEventListener(WakuEvent.Health, this.nodeHealthListener);
  }

  private cleanupNodeListeners(): void {
    if (this.node?.events && this.nodeHealthListener) {
      this.node.events.removeEventListener(WakuEvent.Health, this.nodeHealthListener);
      this.nodeHealthListener = null;
    }
  }

  private startMessageCleanup(): void {
    if (this.messageCleanupInterval) {
      clearInterval(this.messageCleanupInterval);
    }

    this.messageCleanupInterval = setInterval(() => {
      this.cleanupOrphanedMessageTrackers();
    }, WakuHandler.MESSAGE_CLEANUP_INTERVAL);
  }

  private cleanupOrphanedMessageTrackers(): void {
    const now = Date.now();
    let orphanedCount = 0;

    for (const [messageId, tracker] of this.messageTrackers) {
      const age = now - tracker.timestamp;

      if (age > WakuHandler.MESSAGE_TRACKER_TIMEOUT) {
        this.logger.warn(
          `Removing orphaned message tracker for ${getShortMessageId(messageId)}... (age: ${Math.round(
            age / 1000,
          )}s, status: ${tracker.status})`,
        );
        this.messageTrackers.delete(messageId);
        orphanedCount++;
      }
    }

    if (orphanedCount > 0) {
      this.logger.info(`Cleaned up ${orphanedCount} orphaned message trackers`);
    }
  }

  public async getOrCreateChannel(topicName: string): Promise<ChannelInfo> {
    if (this.nodeState !== NodeState.Ready) {
      throw new Error(`Cannot create channel: node is ${this.nodeState}`);
    }

    let channelInfo = this.channels.get(topicName);

    if (!channelInfo) {
      channelInfo = await this.createChannel(topicName);
      this.channels.set(topicName, channelInfo);
    }

    channelInfo.lastUsed = Date.now();
    return channelInfo;
  }

  private async createChannel(topicName: string): Promise<ChannelInfo> {
    if (!this.node) {
      throw new Error('Waku node not initialized');
    }

    const contentTopic = `/solarpunk-msrs/1/${topicName}/proto`;
    const channelName = `chat-channel-${topicName}`;

    const encoder = this.node.createEncoder({ contentTopic });
    const decoder = this.node.createDecoder({ contentTopic });

    const channel = await ReliableChannel.create(this.node, channelName, this.senderId, encoder, decoder, {
      maxRetryAttempts: 5,
      retrieveFrequencyMs: 8000,
    });

    const listeners = this.setupChannelEventListeners(channel, topicName);

    this.logger.info(`Created reliable channel for topic: ${topicName}`);

    return {
      channel,
      encoder,
      decoder,
      lastUsed: Date.now(),
      listeners,
    };
  }

  private setupChannelEventListeners(channel: ReliableChannel<any>, topicName: string): ChannelInfo['listeners'] {
    const messageSentListener = (event: Event) => {
      this.handleMessageSent((event as CustomEvent).detail, topicName);
    };

    const messageAcknowledgedListener = (event: Event) => {
      this.handleMessageAcknowledged((event as CustomEvent).detail, topicName);
    };

    const sendErrorListener = (event: Event) => {
      this.handleSendError((event as CustomEvent).detail, topicName);
    };

    channel.addEventListener('message-sent', messageSentListener);
    channel.addEventListener('message-acknowledged', messageAcknowledgedListener);
    channel.addEventListener('sending-message-irrecoverable-error', sendErrorListener);

    return {
      messageSent: messageSentListener,
      messageAcknowledged: messageAcknowledgedListener,
      sendError: sendErrorListener,
    };
  }

  private cleanupChannelListeners(channelInfo: ChannelInfo): void {
    const { channel, listeners } = channelInfo;

    channel.removeEventListener('message-sent', listeners.messageSent);
    channel.removeEventListener('message-acknowledged', listeners.messageAcknowledged);
    channel.removeEventListener('sending-message-irrecoverable-error', listeners.sendError);
  }

  private async cleanupChannel(channelInfo: ChannelInfo): Promise<void> {
    this.cleanupChannelListeners(channelInfo);
    await channelInfo.channel.stop();
  }

  private handleHealthChange(health: HealthStatus): void {
    if (this.currentHealth === health) {
      return;
    }

    this.currentHealth = health;

    switch (health) {
      case HealthStatus.SufficientlyHealthy:
        this.logger.info('Node health: Sufficiently healthy - fully operational');
        this.retryPendingMessages();
        break;
      case HealthStatus.MinimallyHealthy:
        this.logger.warn('Node health: Minimally healthy - may experience issues');
        this.attemptHealthRecovery(HealthRecoveryType.Minimal);
        break;
      case HealthStatus.Unhealthy:
        this.logger.error('Node health: Not healthy - disconnected from network');
        this.attemptHealthRecovery(HealthRecoveryType.Unhealthy);
        break;
    }
  }

  private async attemptHealthRecovery(healthType: HealthRecoveryType): Promise<void> {
    if (this.isRecoveryInProgress) {
      this.logger.warn(`Health recovery already in progress, skipping new recovery attempt for ${healthType}`);
      return;
    }

    if (this.recoveryTimeoutId) {
      clearTimeout(this.recoveryTimeoutId);
      this.recoveryTimeoutId = null;
    }

    const recoveryDelay =
      healthType === HealthRecoveryType.Unhealthy
        ? WakuHandler.RECOVERY_DELAY_UNHEALTHY
        : WakuHandler.RECOVERY_DELAY_MINIMAL;

    this.logger.info(`Attempting health recovery in ${recoveryDelay}ms for ${healthType} health status...`);

    this.recoveryTimeoutId = setTimeout(async () => {
      this.recoveryTimeoutId = null;

      try {
        if (!this.node) {
          this.logger.error('Cannot recover: Node is null');
          return;
        }

        if (this.currentHealth === HealthStatus.Unhealthy || this.currentHealth === HealthStatus.MinimallyHealthy) {
          this.isRecoveryInProgress = true;
          this.nodeState = NodeState.Recovering;
          this.logger.info('Attempting to reconnect to Waku network...');

          for (const [topicName, channelInfo] of this.channels) {
            this.logger.debug(`Cleaning up channel for topic: ${topicName} during health recovery`);
            await this.cleanupChannel(channelInfo);
          }
          this.channels.clear();

          this.logger.info(`Clearing ${this.messageTrackers.size} message trackers during health recovery`);
          this.messageTrackers.clear();

          this.cleanupNodeListeners();

          this.nodeState = NodeState.Stopping;
          await this.node.stop();
          await sleep(WakuHandler.NODE_RESTART_DELAY);

          await this.initializeNode();

          this.logger.info('Health recovery attempt completed - node restarted');
        } else {
          this.logger.info('Health recovered naturally, no intervention needed');
        }
      } catch (error) {
        this.errorHandler.handleError(error, 'Health recovery failed');
        this.nodeState = NodeState.Stopped;

        if (healthType === HealthRecoveryType.Unhealthy) {
          this.logger.info(`Scheduling another recovery attempt in ${WakuHandler.RECOVERY_DELAY_RETRY}ms...`);
          this.recoveryTimeoutId = setTimeout(
            () => this.attemptHealthRecovery(HealthRecoveryType.Unhealthy),
            WakuHandler.RECOVERY_DELAY_RETRY,
          );
        }
      } finally {
        this.isRecoveryInProgress = false;
      }
    }, recoveryDelay);
  }

  private handleMessageSent(messageId: string, topicName: string): void {
    const tracker = this.messageTrackers.get(messageId);
    if (tracker) {
      tracker.status = MessageStatus.Sent;
      this.logger.info(`[${topicName}] Message sent: ${getShortMessageId(messageId)}...`);
    }
  }

  private handleMessageAcknowledged(messageId: string, topicName: string): void {
    const tracker = this.messageTrackers.get(messageId);
    if (tracker) {
      tracker.status = MessageStatus.Acknowledged;
      this.logger.info(`[${topicName}] Message acknowledged: ${getShortMessageId(messageId)}...`);

      setTimeout(() => {
        this.messageTrackers.delete(messageId);
      }, 5000);
    }
  }

  private handleSendError(detail: { messageId: string; error: Error }, topicName: string): void {
    const tracker = this.messageTrackers.get(detail.messageId);
    if (tracker) {
      tracker.status = MessageStatus.Failed;
      this.logger.error(
        `[${topicName}] Failed to send message ${getShortMessageId(detail.messageId)}...: ${detail.error.message}`,
      );

      if (tracker.retryCount < this.maxRetries) {
        this.retryMessage(tracker);
      } else {
        this.logger.error(`Message ${detail.messageId} failed after ${this.maxRetries} retries`);
        this.messageTrackers.delete(detail.messageId);
      }
    }
  }

  private async retryMessage(tracker: MessageTracker): Promise<void> {
    try {
      const channelInfo = await this.getOrCreateChannel(tracker.topicName);

      tracker.retryCount++;
      tracker.status = MessageStatus.Sending;

      const delay = Math.min(1000 * Math.pow(2, tracker.retryCount), 10000);
      await sleep(delay);

      this.logger.info(
        `[${tracker.topicName}] Retrying message ${getShortMessageId(tracker.messageId)}... (attempt ${
          tracker.retryCount
        }/${this.maxRetries})`,
      );

      const newMessageId = channelInfo.channel.send(tracker.payload);

      this.messageTrackers.delete(tracker.messageId);
      tracker.messageId = newMessageId;
      this.messageTrackers.set(newMessageId, tracker);
    } catch (error) {
      this.errorHandler.handleError(error, `WakuHandler.retryMessage:${tracker.messageId}`);
      tracker.status = MessageStatus.Failed;

      if (tracker.retryCount >= this.maxRetries) {
        this.logger.error(`Message ${tracker.messageId} exceeded max retries, removing from tracker`);
        this.messageTrackers.delete(tracker.messageId);
      }
    }
  }

  private async retryPendingMessages(): Promise<void> {
    const pendingMessages = Array.from(this.messageTrackers.values()).filter(
      (t) => t.status === MessageStatus.Failed && t.retryCount < this.maxRetries,
    );

    if (pendingMessages.length > 0) {
      this.logger.info(`Retrying ${pendingMessages.length} pending messages...`);
    }

    for (const tracker of pendingMessages) {
      try {
        await this.retryMessage(tracker);
      } catch (error) {
        this.errorHandler.handleError(error, `WakuHandler.retryPendingMessages:${tracker.messageId}`);
      }
    }
  }

  public async publishMessageUpdate(
    topicName: string,
    messageData: MessageData,
    refs: MessageStateRef[],
  ): Promise<void> {
    if (this.nodeState !== NodeState.Ready) {
      throw new Error(`Cannot publish message: node is ${this.nodeState}`);
    }

    if (!this.messagePayloadType) {
      throw new Error('Protobuf schema not initialized');
    }

    const channelInfo = await this.getOrCreateChannel(topicName);
    const timestamp = Date.now();

    const dataToEncode = {
      message: {
        ...messageData,
        additionalProps:
          messageData.additionalProps && typeof messageData.additionalProps === 'object'
            ? JSON.stringify(messageData.additionalProps)
            : messageData.additionalProps,
      },
      messageStateRefs: refs,
    };

    const payload = this.messagePayloadType.create(dataToEncode);
    const encodedPayload = this.messagePayloadType.encode(payload).finish();
    const payloadArray = new Uint8Array(encodedPayload);

    try {
      const messageId = channelInfo.channel.send(payloadArray);

      const tracker: MessageTracker = {
        messageId,
        timestamp,
        status: MessageStatus.Sending,
        retryCount: 0,
        payload: payloadArray,
        topicName,
      };
      this.messageTrackers.set(messageId, tracker);

      this.logger.info(
        `[${topicName}] Publishing message with ID: ${getShortMessageId(messageId)}..., state refs: ${refs.length}`,
      );
    } catch (error) {
      this.errorHandler.handleError(error, 'WakuHandler.publishMessageUpdate');
      throw error;
    }
  }

  public async cleanupSpecificTopics(topicsToCleanup: string[]): Promise<void> {
    for (const topicName of topicsToCleanup) {
      this.logger.info(`Cleaning up channel for inactive topic: ${topicName}`);
      const channelInfo = this.channels.get(topicName);

      if (channelInfo) {
        await this.cleanupChannel(channelInfo);
      }

      this.channels.delete(topicName);

      for (const [messageId, tracker] of this.messageTrackers) {
        if (tracker.topicName === topicName) {
          this.messageTrackers.delete(messageId);
        }
      }
    }

    if (topicsToCleanup.length > 0) {
      this.logger.info(`Cleaned up ${topicsToCleanup.length} specific topic channels`);
    }
  }

  public async cleanup(): Promise<void> {
    this.logger.info('Starting WakuHandler cleanup...');

    if (this.recoveryTimeoutId) {
      clearTimeout(this.recoveryTimeoutId);
      this.recoveryTimeoutId = null;
      this.logger.debug('Cleared recovery timeout');
    }

    if (this.messageCleanupInterval) {
      clearInterval(this.messageCleanupInterval);
      this.messageCleanupInterval = null;
      this.logger.debug('Cleared message cleanup interval');
    }

    this.messageTrackers.clear();

    for (const [topicName, channelInfo] of this.channels) {
      this.logger.debug(`Cleaning up channel for topic: ${topicName}`);
      await this.cleanupChannel(channelInfo);
    }
    this.channels.clear();

    if (this.node) {
      this.nodeState = NodeState.Stopping;
      this.cleanupNodeListeners();
      await this.node.stop();
      this.node = null;
      this.logger.debug('Node stopped');
    }

    this.nodeState = NodeState.Stopped;
    this.isRecoveryInProgress = false;
    this.currentHealth = HealthStatus.Unhealthy;

    this.logger.info('WakuHandler cleanup completed');
  }
}
