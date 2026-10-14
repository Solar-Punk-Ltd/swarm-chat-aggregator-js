import { createHmac } from 'node:crypto';

import { PrivateKey } from '@ethersphere/bee-js';
import {
  type ChatBinding,
  type ChatMessage,
  type ChatMessageDraft,
  type SignedChatMessage,
  type UnsignedChatMessage,
  MESSAGE_VERSION,
  encodeChatMessage,
  newMessageId,
  signedBytes,
} from '@solarpunkltd/swarm-chat-js/message';

import { CHAT } from './harness.js';

/**
 * Swarm ID chat bindings made by the Swarm ID fork for its test account, copied from the library's
 * `test/bindingVectors.ts` at 8.0.0. Making one here would need EIP-191 personal_sign, which bee-js does not offer.
 */

// Test only. The fork's account key, which nobody holds funds with.
const FORK_ACCOUNT_KEY = '22'.repeat(32);

export const FORK_ACCOUNT = '0x1563915e194d8cfba1943570603f7606a3115508';

export const BOUND_SITE = 'https://example.com';

export const OTHER_SITE = 'https://other.example';

export const BOUND_SITE_BINDING: ChatBinding = {
  msg: 'Swarm ID chat binding v1\nSite: https://example.com\nChat address: 0xa531fcf12e72328748c12ba58b2b023c00e9a8f9\nDate: 2026-10-14T12:00:00.000Z',
  sig: '0x81b66b5a35aac1203c8c19883c40965e1eaee71ba57df28d3465cb8e03cf4263297bc64b2e5db5d815ae4ebb504f0a8c36ead8193bb13cd44138b2de44642c7d1c',
};

export const OTHER_SITE_BINDING: ChatBinding = {
  msg: 'Swarm ID chat binding v1\nSite: https://other.example\nChat address: 0x7dbe2d309740e55abeb818365acf15bc95cd211a\nDate: 2026-10-14T12:00:00.000Z',
  sig: '0xb41bf4bc3623511e462c947495147dc32a651574884182ca6ae85a5374b5529c3a8a12fe082c32c4956662501f49d7810937e2ce7283450c4d801409187f9a301c',
};

/** Made by the fork with `allowLocalHttp`, as its development build signs one. */
export const LOCAL_SITE = 'http://localhost:5173';

export const LOCAL_SITE_BINDING: ChatBinding = {
  msg: 'Swarm ID chat binding v1\nSite: http://localhost:5173\nChat address: 0x53211e623dcc41a5f58dcaea359bb0af5866d3bf\nDate: 2026-10-14T12:00:00.000Z',
  sig: '0x05f059979417de319d2c51aa27649322ca7d9367fba7c8f175f6168f4fa056a349da0352a65dd129b6775508282bbc64160623791daf8da5e65ceb462b9919de1c',
};

/** The chat key the fork gives its test account on `site`, HMAC-SHA256 of the origin under the account key. */
export function chatKeyFor(site: string): string {
  return createHmac('sha256', Buffer.from(FORK_ACCOUNT_KEY, 'hex')).update(site).digest('hex');
}

/**
 * Signs a message with whatever binding it is given, unlike `createChatMessage`, which refuses to sign a binding that
 * is not for its key. A server must still refuse such a message, since anybody can sign one this way.
 */
export function signedWithBinding(
  key: string,
  idb: ChatBinding,
  overrides: Partial<ChatMessageDraft> = {},
): SignedChatMessage {
  const unsigned: UnsignedChatMessage = {
    v: MESSAGE_VERSION,
    topic: overrides.topic ?? CHAT,
    id: overrides.id ?? newMessageId(),
    type: overrides.type ?? 'text',
    target: overrides.target ?? '',
    text: overrides.text ?? 'hello',
    name: overrides.name ?? 'tester',
    addr: new PrivateKey(key).publicKey().address().toHex(),
    ts: overrides.ts ?? Date.now(),
    via: overrides.via ?? 'gateway',
    own: overrides.own ?? false,
    idb,
  };
  const message: ChatMessage = { ...unsigned, sig: new PrivateKey(key).sign(signedBytes(unsigned)).toHex() };
  return { message, bytes: encodeChatMessage(message) };
}
