import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { encodeHeartbeat, newHeartbeat } from '../src/heartbeat.js';
import { CHAT, Rig, message, testKey, waitFor } from './helpers/harness.js';

let rig: Rig;

beforeEach(async () => {
  rig = await Rig.start();
});

afterEach(async () => {
  await rig.stop();
});

describe('publishing', () => {
  test('writes each message into the next slot with its number, receive time and a history link', async () => {
    const server = await rig.startServer();
    const first = message({ text: 'first' });
    const second = message({ text: 'second' });

    await rig.send(first);
    await waitFor(() => rig.entry(0) !== undefined, 5000, 'slot 0');
    await waitFor(() => server.healthReport().chats[0]?.history?.toSeq === 0, 5000, 'first history save');
    await rig.send(second);
    await waitFor(() => rig.entry(1) !== undefined, 5000, 'slot 1');

    const entry0 = rig.entry(0);
    const entry1 = rig.entry(1);
    expect(entry0).toMatchObject({ v: 7, seq: 0, msg: first.message, history: null });
    expect(entry0?.at).toBeGreaterThan(0);
    expect(entry1).toMatchObject({ v: 7, seq: 1, msg: second.message });
    expect(entry1?.history?.toSeq).toBe(0);
    const saved = rig.history(entry1?.history?.ref ?? '');
    expect(saved).toMatchObject({ v: 7, topic: CHAT, fromSeq: 0, toSeq: 0, prev: null });
    expect(saved.messages.map((row) => row.msg.text)).toEqual(['first']);
    await waitFor(() => server.stats.published === 2, 5000, 'two published');
  });

  test('publishes a chat matched by the pattern and refuses one outside the list and the pattern', async () => {
    const server = await rig.startServer();
    await rig.send(message({ topic: 'chat-pattern-7' }));
    await rig.send(message({ topic: 'somebody-elses-chat' }));
    await waitFor(() => rig.entry(0, 'chat-pattern-7') !== undefined, 5000, 'pattern chat slot 0');
    await waitFor(() => server.stats.dropped.get('chat-not-allowed') === 1, 5000, 'refusal');
    expect(rig.entry(0, 'somebody-elses-chat')).toBeUndefined();
  });

  test('drops a duplicate of a message it already took, by sender and id', async () => {
    const server = await rig.startServer();
    const once = message();
    await rig.send(once);
    await rig.send(once);
    await waitFor(() => server.stats.dropped.get('duplicate') === 1, 5000, 'duplicate drop');
    await waitFor(() => rig.entry(0) !== undefined, 5000, 'slot 0');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rig.entry(1)).toBeUndefined();
  });

  test('counts every refusal by its reason and publishes none of them', async () => {
    const server = await rig.startServer();
    const forged = message();
    const tampered = new TextEncoder().encode(JSON.stringify({ ...forged.message, text: 'not what was signed' }));
    await rig.send(tampered);
    await rig.send(new TextEncoder().encode('not json'));
    await rig.send(new Uint8Array([0xff, 0xfe, 0xfd]));
    await rig.send(new TextEncoder().encode(JSON.stringify({ v: 7, topic: CHAT })));
    await rig.send(message({ ts: Date.now() - 2 * 24 * 60 * 60 * 1000 }));
    await rig.send(encodeHeartbeat(newHeartbeat()));

    await waitFor(() => server.stats.received === 5, 5000, 'five frames');
    await waitFor(() => server.stats.dropped.get('heartbeat-unknown') === 1, 5000, 'foreign heartbeat');
    expect(server.stats.droppedByReason()).toMatchObject({
      signature: 1,
      'not-json': 1,
      'not-utf8': 1,
      shape: 1,
      clock: 1,
      'heartbeat-unknown': 1,
    });
    expect(rig.entry(0)).toBeUndefined();
  });
});

describe('rates', () => {
  test('holds one sender to its rate and the chat to its own', async () => {
    const server = await rig.startServer({ RATE_PER_SENDER: '2', RATE_PER_CHAT: '3' });
    const chatty = testKey();
    for (let i = 0; i < 3; i++) {
      await rig.send(message({ text: `from one sender ${i}` }, chatty));
    }
    await waitFor(() => server.stats.dropped.get('rate-sender') === 1, 5000, 'sender rate');
    await rig.send(message({ text: 'second sender' }));
    await rig.send(message({ text: 'third sender' }));
    await waitFor(() => server.stats.dropped.get('rate-chat') === 1, 5000, 'chat rate');
    await waitFor(() => server.stats.published === 3, 5000, 'three published');
  });
});
