import { MAX_MESSAGE_BYTES, type SignedChatMessage } from '@solarpunkltd/swarm-chat-js/message';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  BOUND_SITE,
  BOUND_SITE_BINDING,
  LOCAL_SITE,
  LOCAL_SITE_BINDING,
  OTHER_SITE,
  OTHER_SITE_BINDING,
  chatKeyFor,
  signedWithBinding,
} from './helpers/bindings.js';
import { Rig, message, waitFor } from './helpers/harness.js';

let rig: Rig;

beforeEach(async () => {
  rig = await Rig.start();
});

afterEach(async () => {
  await rig.stop();
});

const encoder = new TextEncoder();

/** The same JSON with spaces before its closing brace, so it is `size` bytes and still the signed message. */
function paddedTo(signed: SignedChatMessage, size: number): Uint8Array {
  const text = new TextDecoder().decode(signed.bytes);
  const padding = size - signed.bytes.byteLength;
  return encoder.encode(`${text.slice(0, -1)}${' '.repeat(padding)}}`);
}

function boundMessage(overrides: Parameters<typeof message>[0] = {}): SignedChatMessage {
  return message({ idb: BOUND_SITE_BINDING, ...overrides }, chatKeyFor(BOUND_SITE));
}

describe('message version 8', () => {
  test('publishes a guest message field for field, adding only seq and at', async () => {
    const server = await rig.startServer();
    const sent = message({ via: 'own-stamp', own: true });
    await rig.send(sent);
    await waitFor(() => server.stats.published === 1, 5000, 'published');
    await waitFor(() => server.healthReport().chats[0]?.history?.toSeq === 0, 5000, 'history saved');

    const entry = rig.entry(0);
    expect(entry?.msg).toStrictEqual(sent.message);
    expect(Object.keys(entry?.msg ?? {})).toEqual(Object.keys(sent.message));
    expect(Object.keys(entry ?? {}).sort()).toEqual(['at', 'history', 'msg', 'seq', 'v']);
    const row = rig.history(server.healthReport().chats[0]?.history?.ref ?? '').messages[0];
    expect(row).toStrictEqual({ seq: 0, at: entry?.at, msg: sent.message });
  });

  test('publishes a message with a Swarm ID binding unchanged, binding included', async () => {
    const server = await rig.startServer();
    const sent = boundMessage();
    await rig.send(sent);
    await waitFor(() => server.stats.published === 1, 5000, 'published');
    expect(rig.entry(0)?.msg).toStrictEqual(sent.message);
    expect(rig.entry(0)?.msg.idb).toStrictEqual(BOUND_SITE_BINDING);
  });

  test('refuses a version 7 message as shape', async () => {
    const server = await rig.startServer();
    const { via: _via, own: _own, ...rest } = message().message;
    await rig.send(encoder.encode(JSON.stringify({ ...rest, v: 7 })));
    await waitFor(() => server.stats.received === 1, 5000, 'the frame');
    await waitFor(() => server.stats.dropped.get('shape') === 1, 5000, 'the refusal');
    expect(rig.entry(0)).toBeUndefined();
  });

  test('refuses a message whose via changed after signing as signature', async () => {
    const server = await rig.startServer();
    const sent = message({ via: 'gateway' });
    await rig.send(encoder.encode(JSON.stringify({ ...sent.message, via: 'own-stamp' })));
    await waitFor(() => server.stats.dropped.get('signature') === 1, 5000, 'the refusal');
    expect(rig.entry(0)).toBeUndefined();
  });

  test('refuses a signed message whose binding is for another chat address as binding, and logs why', async () => {
    const server = await rig.startServer();
    await rig.send(signedWithBinding(chatKeyFor(BOUND_SITE), OTHER_SITE_BINDING));
    await waitFor(() => server.stats.dropped.get('binding') === 1, 5000, 'the refusal');
    expect(rig.entry(0)).toBeUndefined();
    expect(rig.logs.some((line) => line.includes('dropped, binding: '))).toBe(true);
  });

  test('refuses a binding whose signature recovers no account as binding', async () => {
    const server = await rig.startServer();
    const altered = { ...BOUND_SITE_BINDING, sig: `${BOUND_SITE_BINDING.sig.slice(0, -2)}1d` };
    await rig.send(signedWithBinding(chatKeyFor(BOUND_SITE), altered));
    await waitFor(() => server.stats.dropped.get('binding') === 1, 5000, 'the refusal');
    expect(rig.entry(0)).toBeUndefined();
  });
});

describe('the site origin', () => {
  test('accepts a binding for the site CHAT_SITE_ORIGIN names', async () => {
    const server = await rig.startServer({ CHAT_SITE_ORIGIN: BOUND_SITE });
    const sent = boundMessage();
    await rig.send(sent);
    await waitFor(() => server.stats.published === 1, 5000, 'published');
    expect(rig.entry(0)?.msg).toStrictEqual(sent.message);
  });

  test('refuses a valid binding for another site as binding', async () => {
    const server = await rig.startServer({ CHAT_SITE_ORIGIN: BOUND_SITE });
    await rig.send(message({ idb: OTHER_SITE_BINDING }, chatKeyFor(OTHER_SITE)));
    await waitFor(() => server.stats.dropped.get('binding') === 1, 5000, 'the refusal');
    expect(rig.entry(0)).toBeUndefined();
    expect(rig.logs.some((line) => line.includes(`not ${BOUND_SITE}`))).toBe(true);
  });

  test('accepts a binding for a local development site only when CHAT_SITE_ORIGIN names it', async () => {
    const local = message({ idb: LOCAL_SITE_BINDING }, chatKeyFor(LOCAL_SITE));
    const server = await rig.startServer({ CHAT_SITE_ORIGIN: LOCAL_SITE });
    await rig.send(local);
    await waitFor(() => server.stats.published === 1, 5000, 'published');
    expect(rig.entry(0)?.msg).toStrictEqual(local.message);
  });

  test('refuses a binding for a local development site in a chat served for a public site', async () => {
    const server = await rig.startServer({ CHAT_SITE_ORIGIN: BOUND_SITE });
    await rig.send(message({ idb: LOCAL_SITE_BINDING }, chatKeyFor(LOCAL_SITE)));
    await waitFor(() => server.stats.dropped.get('binding') === 1, 5000, 'the refusal');
    expect(rig.entry(0)).toBeUndefined();
  });
});

describe('the byte cap', () => {
  test(`publishes a payload of exactly ${MAX_MESSAGE_BYTES} bytes and refuses one byte more as too-large`, async () => {
    const server = await rig.startServer();
    const atCap = boundMessage({ text: 'é'.repeat(300) });
    const overCap = boundMessage({ text: 'é'.repeat(300) });
    expect(atCap.bytes.byteLength).toBeLessThan(MAX_MESSAGE_BYTES);

    await rig.send(paddedTo(overCap, MAX_MESSAGE_BYTES + 1));
    await waitFor(() => server.stats.dropped.get('too-large') === 1, 5000, 'the refusal');
    await rig.send(paddedTo(atCap, MAX_MESSAGE_BYTES));
    await waitFor(() => server.stats.published === 1, 5000, 'published');
    expect(rig.entry(0)?.msg).toStrictEqual(atCap.message);
    expect(rig.entry(1)).toBeUndefined();
  });
});
