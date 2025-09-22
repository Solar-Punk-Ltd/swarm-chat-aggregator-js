import { MessageData, MessageStateRef } from '@solarpunkltd/swarm-chat-js';
import path from 'path';
import protobuf from 'protobufjs';

// eslint-disable-next-line
const { load } = protobuf;
type Root = protobuf.Root;
type Type = protobuf.Type;

let protoRoot: Root | null = null;
let messagePayloadType: Type | null = null;

async function initializeProtobuf(): Promise<void> {
  if (!protoRoot) {
    protoRoot = await load(path.join(__dirname, '../proto/message.proto'));
    protoRoot.resolveAll();
    messagePayloadType = protoRoot.lookupType('MessagePayload');
  }
}

export async function encodeMessagePayload(messageData: MessageData, refs: MessageStateRef[]): Promise<Uint8Array> {
  await initializeProtobuf();
  if (!messagePayloadType) throw new Error('MessagePayload type not initialized');

  const typeMap = { text: 0, thread: 1, reaction: 2 };
  const dataToEncode = {
    message: {
      ...messageData,
      type: typeMap[messageData.type as keyof typeof typeMap] ?? 0,
    },
    messageStateRefs: refs,
  };

  const payload = messagePayloadType.create(dataToEncode);
  return messagePayloadType.encode(payload).finish();
}
