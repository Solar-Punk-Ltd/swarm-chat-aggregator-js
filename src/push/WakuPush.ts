import { createEncoder, createLightNode, Encoder, type LightNode, Protocols } from '@waku/sdk';

import { Logger } from '../libs/logger.js';
import { WAKU_CLUSTER_ID, WAKU_CONTENT_TOPIC, WAKU_PUB_SUB_TOPIC, WAKU_SHARD_ID } from '../utils/constants.js';

export class WakuPush {
  private readonly logger = Logger.getInstance();
  private readonly encoder = this.createWakuEncoder();
  private wakuNode: LightNode | null = null;

  constructor() {
    this.init();
  }

  private async init() {
    this.wakuNode = await this.createWakuLightNode();
  }

  /**
   * Returns the initialized Waku LightNode instance.
   *
   * @returns {LightNode} The initialized Waku node.
   * @throws {Error} If the Waku node has not been initialized.
   */
  public getNode(): LightNode {
    if (!this.wakuNode) {
      throw new Error('Waku node not initialized.');
    }
    return this.wakuNode;
  }

  private async createWakuLightNode(): Promise<LightNode> {
    const node = await createLightNode({
      defaultBootstrap: true,
      networkConfig: { clusterId: 1 },
    });
    this.logger.info('Light Node created');
    await node.start();
    this.logger.info('Waku Light Node started');
    await node.waitForPeers([Protocols.LightPush, Protocols.Filter], 30000);
    this.logger.info('Connected to peers supporting LightPush and Filter');
    this.logger.info('Node ID:', node.libp2p.peerId.toString());

    return node;
  }

  private createWakuEncoder(): Encoder {
    return createEncoder({
      contentTopic: WAKU_CONTENT_TOPIC,
      ephemeral: true,
      routingInfo: {
        clusterId: WAKU_CLUSTER_ID,
        shardId: WAKU_SHARD_ID,
        pubsubTopic: WAKU_PUB_SUB_TOPIC,
      },
    });
  }
  /**
   * Publishes a message to a Waku content topic using LightPush.
   *
   * @param node - The started Waku LightNode instance.
   * @param payload - The message payload as Uint8Array.
   * @returns {Promise<void>}
   */
  public async publishMessage(payload: Uint8Array): Promise<void> {
    const node = this.getNode();
    if (!node.isStarted) {
      throw new Error('Waku node is not running');
    }
    await node.lightPush.send(this.encoder, { payload });
  }
}
