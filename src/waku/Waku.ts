import { createEncoder, createLightNode, Encoder, type LightNode, Protocols } from '@waku/sdk';
import { createRoutingInfo } from '@waku/utils';

import { ErrorHandler } from '../libs/error.js';
import { Logger } from '../libs/logger.js';
import { WAKU_CLUSTER_ID } from '../utils/constants.js';
import { getEnvVariable } from '../utils/env.js';

const WAKU_STATIC_PEER = getEnvVariable('WAKU_STATIC_PEER');

export class Waku {
  private readonly logger = Logger.getInstance();
  private readonly errorHandler = ErrorHandler.getInstance();

  private static instance: Waku | null = null;
  private wakuNode: LightNode | null = null;
  private initPromise: Promise<void> | null = null;

  private consecutiveSendFailures = 0;

  private constructor() {}

  public static getInstance(): Waku {
    if (!Waku.instance) {
      Waku.instance = new Waku();
    }
    return Waku.instance;
  }

  public async init(): Promise<void> {
    if (this.wakuNode) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.createWakuLightNode().then((node) => {
      this.wakuNode = node;
    });

    return this.initPromise;
  }

  public getNode(): LightNode {
    if (!this.wakuNode) {
      throw new Error('Waku node not initialized.');
    }
    return this.wakuNode;
  }

  private async createWakuLightNode(): Promise<LightNode> {
    const networkConfig = {
      clusterId: WAKU_CLUSTER_ID,
      numShardsInCluster: 8,
    };

    const node = await createLightNode({
      networkConfig,
      bootstrapPeers: WAKU_STATIC_PEER ? [WAKU_STATIC_PEER] : undefined,
      defaultBootstrap: !WAKU_STATIC_PEER,
    });

    this.logger.info('Light Node created');
    await node.start();
    this.logger.info('Waku Light Node started');

    await node.waitForPeers([Protocols.LightPush], 30000);

    this.logger.info('Connected to peers supporting LightPush');
    this.logger.info('Node ID:', node.libp2p.peerId.toString());

    return node;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.wakuNode) {
      throw new Error('Waku node not initialized');
    }

    try {
      if (!this.wakuNode.isStarted()) {
        this.logger.warn('Waku node stopped unexpectedly. Reinitializing...');
        await this.reinitialize();
        return;
      }

      const peers = await this.wakuNode.getConnectedPeers();

      if (peers.length === 0) {
        this.logger.warn('No peers connected. Attempting to reconnect...');
        await this.attemptReconnect();
      }
    } catch (error) {
      this.errorHandler.handleError(error, 'WakuEnsureConnected');
      throw error;
    }
  }

  private async attemptReconnect(): Promise<void> {
    if (!this.wakuNode) {
      return;
    }

    try {
      if (WAKU_STATIC_PEER) {
        this.logger.info('Attempting to redial static peer...');
        try {
          await this.wakuNode.dial(WAKU_STATIC_PEER);
        } catch (error) {
          this.errorHandler.handleError(error, 'WakuReconnect.DialStaticPeer');
        }
      }

      await this.wakuNode.waitForPeers([Protocols.LightPush], 15000);
      this.logger.info('Reconnected to peers');
    } catch (error) {
      this.errorHandler.handleError(error, 'WakuReconnect');
    }
  }

  private async reinitialize(): Promise<void> {
    this.logger.info('Reinitializing Waku node...');

    if (this.wakuNode) {
      try {
        await this.wakuNode.stop();
      } catch (error) {
        this.errorHandler.handleError(error, 'WakuReinitialize.StopOldNode');
      }
      this.wakuNode = null;
    }

    this.initPromise = null;
    this.consecutiveSendFailures = 0;

    await this.init();
  }

  public createWakuEncoder(topicName: string): Encoder {
    const networkConfig = {
      clusterId: WAKU_CLUSTER_ID,
      numShardsInCluster: 8,
    };

    const contentTopic = `solarpunk-msrs/1/${topicName}/proto`;
    const routingInfo = createRoutingInfo(networkConfig, { contentTopic });

    return createEncoder({
      contentTopic,
      routingInfo,
      ephemeral: true,
    });
  }

  public async publishMessage(encoder: Encoder, payload: Uint8Array): Promise<void> {
    await this.ensureConnected();

    const node = this.getNode();

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await node.lightPush.send(encoder, { payload });

        this.consecutiveSendFailures = 0;
        return;
      } catch (error) {
        lastError = error as Error;
        this.consecutiveSendFailures++;
        this.logger.warn(`Failed to send message (attempt ${attempt}/${maxRetries}):`, error);

        if (attempt < maxRetries) {
          await this.ensureConnected();
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    throw new Error(`Failed to publish message after ${maxRetries} attempts: ${lastError?.message}`);
  }

  public async cleanup(): Promise<void> {
    if (this.wakuNode) {
      await this.wakuNode.stop();
      this.wakuNode = null;
    }
  }
}
