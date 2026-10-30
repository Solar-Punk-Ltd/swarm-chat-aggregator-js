// What a sender puts on the chat's GSOC address, plus the two kinds of bad payload B4 sends. This module is the
// bed's only import of the chat library.
import { PrivateKey } from '@ethersphere/bee-js';
import {
  MESSAGE_VERSION,
  createChatMessage,
  encodeChatMessage,
  parseChatMessage,
} from '@solarpunkltd/swarm-chat-js/message';

/** The site the bed's server is configured for. Its senders send as guests, so no binding is checked against it. */
export const SITE_ORIGIN = 'https://chat.example.com';

/** The library's own wire check as the bed's server runs it, for the bed's tests. */
export function parsePayload(bytes) {
  return parseChatMessage(bytes, { origins: [SITE_ORIGIN] });
}

const encoder = new TextEncoder();

function build({ key, topic, text, name }) {
  const { message, bytes } = createChatMessage(key, { topic, type: 'text', text, name, via: 'gateway' });
  return { id: message.id, sender: message.addr, bytes };
}

/** A correctly signed message whose text changed after signing. */
function forge(draft) {
  const { message } = createChatMessage(draft.key, {
    topic: draft.topic,
    type: 'text',
    text: draft.text,
    name: draft.name,
    via: 'gateway',
  });
  const forged = { ...message, text: `${message.text} (forged)` };
  return { id: forged.id, sender: forged.addr, bytes: encodeChatMessage(forged) };
}

/** Bytes that name the chat's topic, so a server routes them there, and are not a message. */
function malformed(topic) {
  return encoder.encode(`{"topic":${JSON.stringify(topic)},"v":${MESSAGE_VERSION},"text":`);
}

export const payloads = { build, forge, malformed };

export function randomKey() {
  return new PrivateKey(crypto.getRandomValues(new Uint8Array(32)));
}

/** The message id a feed entry carries, or null when the entry holds no readable message. */
export function messageIdOf(entry) {
  const id = entry?.msg?.id;
  return typeof id === 'string' ? id : null;
}
