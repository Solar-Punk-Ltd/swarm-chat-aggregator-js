// What a sender puts on the chat's GSOC address, in either message format, plus the two kinds of bad payload B4
// sends. This module is the bed's only import of the chat library.
import { randomUUID } from 'node:crypto';

import { PrivateKey } from '@ethersphere/bee-js';
import { createChatMessage, encodeChatMessage } from 'swarm-chat-js-v7/message';

export const PayloadFormat = { V6: 'v6', V7: 'v7' };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Today's message, built the way library 6.2.8 builds it (src/lib/core.ts sendMessage and getSignature). The
 * signature covers only the name, the address, the text and a timestamp of its own, taken a moment before the
 * message's, which is copied as it is.
 */
function buildV6({ key, topic, text, name, index }) {
  const address = key.publicKey().address().toHex();
  const signedAt = Date.now();
  const signature = key.sign(JSON.stringify({ username: name, address, message: text, timestamp: signedAt })).toHex();
  const message = {
    id: randomUUID(),
    username: name,
    address,
    chatTopic: topic,
    userTopic: `${topic}_EthercastChat_${address}`,
    signature,
    timestamp: Date.now(),
    index,
    type: 'text',
    message: text,
  };
  return { id: message.id, sender: address, bytes: encoder.encode(JSON.stringify(message)) };
}

function buildV7({ key, topic, text, name }) {
  const { message, bytes } = createChatMessage(key, { topic, type: 'text', text, name });
  return { id: message.id, sender: message.addr, bytes };
}

/** A message signed by one key and claimed for another address, which a verifying server refuses. */
function forgeV6(draft) {
  const built = buildV6(draft);
  const message = JSON.parse(decoder.decode(built.bytes));
  message.address = randomKey().publicKey().address().toHex();
  return { id: message.id, sender: message.address, bytes: encoder.encode(JSON.stringify(message)) };
}

/** A correctly signed message whose text changed after signing. */
function forgeV7(draft) {
  const { message } = createChatMessage(draft.key, {
    topic: draft.topic,
    type: 'text',
    text: draft.text,
    name: draft.name,
  });
  const forged = { ...message, text: `${message.text} (forged)` };
  return { id: forged.id, sender: forged.addr, bytes: encodeChatMessage(forged) };
}

/** Bytes that name the chat's topic, so a server routes them there, and are not a message of either format. */
function malformed(format, topic) {
  const topicField = format === PayloadFormat.V6 ? 'chatTopic' : 'topic';
  return encoder.encode(`{"${topicField}":${JSON.stringify(topic)},"v":7,"text":`);
}

export function randomKey() {
  return new PrivateKey(crypto.getRandomValues(new Uint8Array(32)));
}

/** The message id a feed entry carries, in either format, or null when the entry holds no readable message. */
export function messageIdOf(format, entry) {
  const id = format === PayloadFormat.V6 ? entry?.message?.id : entry?.msg?.id;
  return typeof id === 'string' ? id : null;
}

export function payloadsFor(format) {
  if (format === PayloadFormat.V6) {
    return { build: buildV6, forge: forgeV6, malformed: (topic) => malformed(format, topic) };
  }
  if (format === PayloadFormat.V7) {
    return { build: buildV7, forge: forgeV7, malformed: (topic) => malformed(format, topic) };
  }
  throw new Error(`unknown payload format ${format}, expected v6 or v7`);
}
