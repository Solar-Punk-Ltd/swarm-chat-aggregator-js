import { MessageData, MessageStateRef } from '@solarpunkltd/swarm-chat-js';
import { Encoder } from '@waku/sdk';
import path from 'path';
import protobuf from 'protobufjs';
import { fileURLToPath } from 'url';

import { Logger } from '../libs/logger.js';

import { Waku } from './Waku.js';

// eslint-disable-next-line
const { load } = protobuf;
type Root = protobuf.Root;
type Type = protobuf.Type;

export class ProtoMessage {
  private logger = Logger.getInstance();

  private waku: Waku;
  private encoder: Encoder | null = null;

  private protoRoot: Root | null = null;
  private messagePayloadType: Type | null = null;

  private readonly protoPath = path.join(__dirname, './message.proto');

  constructor(private streamTopic: string) {
    this.waku = Waku.getInstance();
  }

  public async init(): Promise<void> {
    await this.waku.init();

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    this.protoRoot = await load(this.protoPath);
    this.protoRoot.resolveAll();
    this.messagePayloadType = this.protoRoot.lookupType('MessagePayload');

    const wakuTopic = this.streamTopic;
    this.encoder = this.waku.createWakuEncoder(wakuTopic);

    this.logger.info(`WakuPublish initialized for stream: ${wakuTopic}`);
  }

  public async publishMessageUpdate(messageData: MessageData, refs: MessageStateRef[]): Promise<void> {
    if (!this.encoder || !this.messagePayloadType) {
      throw new Error('WakuPublish not initialized');
    }

    const typeMap = { text: 0, thread: 1, reaction: 2 };
    const dataToEncode = {
      message: {
        ...messageData,
        type: typeMap[messageData.type as keyof typeof typeMap] ?? 0,
        additionalProps:
          messageData.additionalProps && typeof messageData.additionalProps === 'object'
            ? JSON.stringify(messageData.additionalProps)
            : messageData.additionalProps,
      },
      messageStateRefs: refs,
    };

    const payload = this.messagePayloadType.create(dataToEncode);
    const encodedPayload = this.messagePayloadType.encode(payload).finish();

    await this.waku.publishMessage(this.encoder, new Uint8Array(encodedPayload));

    this.logger.info(`Published message update with ${refs.length} state refs`);
  }
}
