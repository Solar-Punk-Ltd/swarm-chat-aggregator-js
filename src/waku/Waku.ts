import { createEncoder, createLightNode, Encoder, type LightNode, Protocols } from '@waku/sdk';
import { createHash } from 'crypto';

import { Logger } from '../libs/logger.js';
import { WAKU_CLUSTER_ID } from '../utils/constants.js';

export class Waku {
  private readonly logger = Logger.getInstance();
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

  /**
   * Creates a Waku encoder instance for the specified Waku topic.
   *
   * @param wakuTopic - The topic to be used for the Waku encoder.
   * @returns An {@link Encoder} configured with the provided topic and default routing information.
   *
   * @remarks
   * The encoder is configured with a content topic in the format `solarpunk-msrs/1/${wakuTopic}/proto`,
   * is set as ephemeral, and uses predefined routing information including cluster ID, shard ID, and pubsub topic.
   *
   * @example
   * ```typescript
   * const encoder = createWakuEncoder('chat');
   * ```
   */
  public createWakuEncoder(topicName: string): Encoder {
    // Derive shardId from topicName to ensure even distribution across shards
    const hash = createHash('sha256').update(topicName).digest('hex');
    const NUM_SHARDS = 8;
    const hashInt = BigInt('0x' + hash);
    const shardId = Number(hashInt % BigInt(NUM_SHARDS));

    return createEncoder({
      contentTopic: `solarpunk-msrs/1/${topicName}/proto`,
      ephemeral: true,
      routingInfo: {
        clusterId: WAKU_CLUSTER_ID,
        shardId: shardId,
        // The pubsub topic format is `/waku/2/rs/{clusterId}/{shardId}`.
        // See: https://github.com/waku-org/js-waku/blob/master/packages/utils/src/common/sharding/topics.ts
        pubsubTopic: `/waku/2/rs/${WAKU_CLUSTER_ID}/${shardId}`,
      },
    });
  }

  /**
   * Publishes a message using the Waku Light Push protocol.
   *
   * @param encoder - The encoder instance used to encode the message topic and content.
   * @param payload - The message payload as a Uint8Array.
   * @returns A promise that resolves when the message has been sent.
   * @throws {Error} If the Waku node is not running.
   *
   * @example
   * ```typescript
   * await wakuPush.publishMessage(encoder, new Uint8Array([1, 2, 3]));
   * ```
   */
  public async publishMessage(encoder: Encoder, payload: Uint8Array): Promise<void> {
    const node = this.getNode();
    if (!node.isStarted) {
      throw new Error('Waku node is not running');
    }
    await node.lightPush.send(encoder, { payload });
  }
}
