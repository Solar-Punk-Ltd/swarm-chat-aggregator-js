import { MessageData, MessageStateRef } from '@solarpunkltd/swarm-chat-js';
import { createLightNode, HealthStatus, type LightNode, ReliableChannel, WakuEvent } from '@solarpunkltd/waku-sdk';
import crypto from 'crypto';
import protobuf from 'protobufjs';

import { ErrorHandler } from '../libs/error.js';
import { Logger } from '../libs/logger.js';
import { getEnvVariable, getShortMessageId, sleep } from '../utils/common.js';

const WAKU_STATIC_PEER = getEnvVariable('WAKU_STATIC_PEER');

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
}

export class WakuHandler {
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  private static instance: WakuHandler | null = null;
  private node: LightNode | null = null;

  private channels = new Map<string, ChannelInfo>();
  private messagePayloadType: protobuf.Type | null = null;

  private readonly senderId = crypto.randomBytes(8).toString('hex');

  private messageTrackers = new Map<string, MessageTracker>();
  private readonly maxRetries = 5;
  private currentHealth: HealthStatus = HealthStatus.Unhealthy;

  private static readonly RECOVERY_DELAY_MINIMAL = 8000;
  private static readonly RECOVERY_DELAY_UNHEALTHY = 10000;
  private static readonly RECOVERY_DELAY_RETRY = 20000;
  private static readonly NODE_RESTART_DELAY = 2000;

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
    this.node = await createLightNode({
      defaultBootstrap: true,
      bootstrapPeers: [WAKU_STATIC_PEER],
    });

    this.setupNodeEventListeners();

    this.logger.info('Waku Light Node started with reliable channel support');
  }

  private setupNodeEventListeners(): void {
    if (!this.node || !this.node.events) return;

    this.node.events.addEventListener(WakuEvent.Health, (event) => {
      this.handleHealthChange((event as CustomEvent).detail);
    });
  }

  public async getOrCreateChannel(topicName: string): Promise<ChannelInfo> {
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

    this.setupChannelEventListeners(channel, topicName);
    this.logger.info(`Created reliable channel for topic: ${topicName}`);

    return {
      channel,
      encoder,
      decoder,
      lastUsed: Date.now(),
    };
  }

  private setupChannelEventListeners(channel: ReliableChannel<any>, topicName: string): void {
    channel.addEventListener('message-sent', (event) => {
      this.handleMessageSent((event as CustomEvent).detail, topicName);
    });

    channel.addEventListener('message-acknowledged', (event) => {
      this.handleMessageAcknowledged((event as CustomEvent).detail, topicName);
    });

    channel.addEventListener('sending-message-irrecoverable-error', (event) => {
      this.handleSendError((event as CustomEvent).detail, topicName);
    });
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
    const recoveryDelay =
      healthType === HealthRecoveryType.Unhealthy
        ? WakuHandler.RECOVERY_DELAY_UNHEALTHY
        : WakuHandler.RECOVERY_DELAY_MINIMAL;

    this.logger.info(`Attempting health recovery in ${recoveryDelay}ms for ${healthType} health status...`);

    setTimeout(async () => {
      try {
        if (!this.node) {
          this.logger.error('Cannot recover: Node is null');
          return;
        }

        if (this.currentHealth === HealthStatus.Unhealthy || this.currentHealth === HealthStatus.MinimallyHealthy) {
          this.logger.info('Attempting to reconnect to Waku network...');

          this.channels.clear();

          await this.node.stop();
          await sleep(WakuHandler.NODE_RESTART_DELAY);

          await this.initializeNode();

          this.logger.info('Health recovery attempt completed - node restarted');
          this.retryPendingMessages();
        } else {
          this.logger.info('Health recovered naturally, no intervention needed');
        }
      } catch (error) {
        this.logger.error('Health recovery failed:', error);

        if (healthType === HealthRecoveryType.Unhealthy) {
          this.logger.info(`Scheduling another recovery attempt in ${WakuHandler.RECOVERY_DELAY_RETRY}ms...`);
          setTimeout(() => this.attemptHealthRecovery(HealthRecoveryType.Unhealthy), WakuHandler.RECOVERY_DELAY_RETRY);
        }
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
    const channelInfo = await this.getOrCreateChannel(tracker.topicName);
    if (!channelInfo) return;

    tracker.retryCount++;
    tracker.status = MessageStatus.Sending;

    const delay = Math.min(1000 * Math.pow(2, tracker.retryCount), 10000);
    await sleep(delay);

    this.logger.info(
      `[${tracker.topicName}] Retrying message ${getShortMessageId(tracker.messageId)}... (attempt ${
        tracker.retryCount
      }/${this.maxRetries})`,
    );

    try {
      const newMessageId = channelInfo.channel.send(tracker.payload);

      this.messageTrackers.delete(tracker.messageId);
      tracker.messageId = newMessageId;
      this.messageTrackers.set(newMessageId, tracker);
    } catch (error) {
      this.logger.error(`Retry failed for message ${tracker.messageId}:`, error);
      tracker.status = MessageStatus.Failed;
    }
  }

  private async retryPendingMessages(): Promise<void> {
    const pendingMessages = Array.from(this.messageTrackers.values()).filter(
      (t) => t.status === MessageStatus.Failed && t.retryCount < this.maxRetries,
    );

    for (const tracker of pendingMessages) {
      this.retryMessage(tracker);
    }
  }

  public async publishMessageUpdate(
    topicName: string,
    messageData: MessageData,
    refs: MessageStateRef[],
  ): Promise<void> {
    if (!this.messagePayloadType) {
      throw new Error('WakuHandler not initialized');
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
        await channelInfo.channel.stop();
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
    this.messageTrackers.clear();
    this.channels.clear();

    if (this.node) {
      await this.node.stop();
      this.node = null;
    }
  }
}
