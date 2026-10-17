import { createHmac } from 'node:crypto';

import { PrivateKey } from '@ethersphere/bee-js';
import {
  type ChatBinding,
  type ChatMessage,
  type ChatMessageDraft,
  type SignedChatMessage,
  type UnsignedChatMessage,
  type WalletLink,
  MESSAGE_VERSION,
  encodeChatMessage,
  newMessageId,
  signedBytes,
} from '@solarpunkltd/swarm-chat-js/message';

import { CHAT } from './harness.js';

/**
 * Swarm ID chat bindings made by the Swarm ID fork for its test account, copied from the library's
 * `test/bindingVectors.ts` as released in 8.0.0 (ecfadff). Making one here would need EIP-191 personal_sign, which
 * bee-js does not offer.
 */

// Test only. The fork's account key, which nobody holds funds with.
const FORK_ACCOUNT_KEY = '22'.repeat(32);

export const FORK_ACCOUNT = '0x1563915e194d8cfba1943570603f7606a3115508';

export const BOUND_SITE = 'https://example.com';

export const OTHER_SITE = 'https://other.example';

export const BOUND_SITE_BINDING: ChatBinding = {
  msg: 'Swarm ID chat binding v1\nSite: https://example.com\nChat address: 0xc6b7cb635534a22fbc368643cc40355545f666dc\nDate: 2026-10-14T12:00:00.000Z',
  sig: '0xee2151a66fcdb0852b1bff2a03578aff9556f893e4c6d2aef2d484b4ada153804a7b1c97f40eac18fbd5f75674c918c48a761800e8122b7eae7af45393d9a24d1b',
};

export const OTHER_SITE_BINDING: ChatBinding = {
  msg: 'Swarm ID chat binding v1\nSite: https://other.example\nChat address: 0xe4f3c8ce34e17de035a8476a0744266de7a7787a\nDate: 2026-10-14T12:00:00.000Z',
  sig: '0x9ac7b48626f8971e436126783fa8e1d9146cb108e224ade8cf08600b5f65117d7b296234c424d969ad08dad0b8a30f0612dbc1219b3471d6d066422fb20057cb1c',
};

/** Made by the fork with `allowLocalHttp`, as its development build signs one. */
export const LOCAL_SITE = 'http://localhost:5173';

export const LOCAL_SITE_BINDING: ChatBinding = {
  msg: 'Swarm ID chat binding v1\nSite: http://localhost:5173\nChat address: 0xe8ba94db6fdfc694ff9dc9ccd07ef8fe5b7ed140\nDate: 2026-10-14T12:00:00.000Z',
  sig: '0xf0f5e7fc8a79e619fa0e0ec42c6179b7c3ffaa2e82b9d01bd448d643006088d01e2a34e8d17dc0595d471ed098aa5394e260858c72272868f540f66f117eeed51b',
};

/**
 * A wallet link of FORK_ACCOUNT, copied from the library's `test/walletLinkVectors.ts` as released in 9.0.0. The
 * fork made it, and the library accepts it only beside a binding of that account.
 */
export const WALLET_LINK: WalletLink = {
  msg: 'Swarm ID wallet link v1\nI link this wallet to the Swarm ID account below, so sites may show my ENS name beside its messages.\nAccount: 0x1563915e194d8cfba1943570603f7606a3115508\nWallet: 0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb\nDate: 2026-10-15T12:01:00.000Z',
  wsig: '0x8375ed13f2afa0b70f62f94f82012f52022028620fbdc90ea073990a1fbb23e03aa67b6d49b84651f4b1096c9106d25a971407dc02d3663ec1a1a65500a520ae1c',
  asig: '0x8b253d455123dfb0a00c4ad56e0e65fffbb99850efcbe3fea85e2583034b3d8605e83f895c80e29eda6ff9ef481f3ad9090fad20d37508a6b29462ad9e2562891b',
};

const CHAT_KEY_LABEL = 'swarm-id chat key v1';
const MAX_CHAT_KEY_ATTEMPTS = 16;
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function hmacSha256(keyHex: string, label: string): string {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(label).digest('hex');
}

/**
 * The chat key the fork gives its test account on `site`, as its `deriveChatKey` derives it: HMAC-SHA256 of
 * `swarm-id chat key v1` under the app secret, itself HMAC-SHA256 of the origin under the account key, asked again
 * under `/1`, `/2` and on while the result is not a valid secp256k1 private key.
 */
export function chatKeyFor(site: string): string {
  const appSecret = hmacSha256(FORK_ACCOUNT_KEY, site);
  for (let attempt = 0; attempt < MAX_CHAT_KEY_ATTEMPTS; attempt++) {
    const candidate = hmacSha256(appSecret, attempt === 0 ? CHAT_KEY_LABEL : `${CHAT_KEY_LABEL}/${attempt}`);
    const scalar = BigInt(`0x${candidate}`);
    if (scalar > 0n && scalar < SECP256K1_ORDER) {
      return candidate;
    }
  }
  throw new Error(`no valid chat key for ${site} in ${MAX_CHAT_KEY_ATTEMPTS} attempts`);
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
    idb,
    ...(overrides.wl ? { wl: overrides.wl } : {}),
  };
  const message: ChatMessage = { ...unsigned, sig: new PrivateKey(key).sign(signedBytes(unsigned)).toHex() };
  return { message, bytes: encodeChatMessage(message) };
}
