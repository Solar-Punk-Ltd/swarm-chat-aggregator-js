// B1's load against the fake Bee: twenty senders, ten messages each 200 ms apart, every message resent every 10 s
// until it is in the feed, at most five times. The writing node pushes one chunk at a time, so the senders' inbox
// writes, the feed entries, the notes, the heartbeats and the history uploads queue behind each other as they do on
// the bed's worker node. Every time is scaled by BENCH_SCALE so a run takes seconds. It reports where the time went
// and asserts only that every message landed exactly once.
//
//   pnpm bench
//
// BENCH_PUSH_MS is the node's push time per chunk before scaling. At its default of 40 the bench reproduced the box's
// B1 shape on 2026-10-14: about 2 resends per message and the last message 48 to 60 s after its first send.
import { performance } from 'node:perf_hooks';

import { Bee, Identifier, PrivateKey } from '@ethersphere/bee-js';
import { MESSAGE_VERSION, createChatMessage } from '@solarpunkltd/swarm-chat-js/message';
import { afterAll, beforeAll, expect, test } from 'vitest';

import type { AggregatorServer } from '../../src/server.js';
import { Rig, testKey, waitFor } from '../helpers/harness.js';

const SCALE = Number(process.env.BENCH_SCALE ?? 0.1);
const SENDERS = 20;
const MESSAGES_PER_SENDER = 10;
const SEND_SPACING_MS = 200 * SCALE;
const RESEND_INTERVAL_MS = 10_000 * SCALE;
const RESEND_ATTEMPTS = 5;
/** The longest a message may take from its first send to the feed before its sender gives up. */
const SENDER_WINDOW_MS = RESEND_INTERVAL_MS * (RESEND_ATTEMPTS + 1);
const FOLLOW_INTERVAL_MS = 1000 * SCALE;
/** Calibrated so the feed write's p50 is near the bed's 1.2 s, and parity doubling a file is an assumption. */
const PUSH = { msPerChunk: Number(process.env.BENCH_PUSH_MS ?? 40) * SCALE, dataChunkFactor: 2 };
const TOPIC = 'chat-bed-b1-bench';

type Sent = { id: string; firstSentAt: number; appearedAt?: number; writes: number; gaveUp: boolean };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function spread(values: number[], digits = 0): string {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
  const show = (value: number) => value.toFixed(digits);
  return `p50 ${show(at(0.5))} p90 ${show(at(0.9))} max ${show(sorted.at(-1) ?? 0)}`;
}

/** Times every frame the server's intake takes, which runs on the event loop the publish loop shares. */
function timeIntake(server: AggregatorServer): number[] {
  const spent: number[] = [];
  const intake = (server as unknown as { intake: { receive: (payload: Uint8Array, now?: number) => void } }).intake;
  const receive = intake.receive.bind(intake);
  intake.receive = (payload, now) => {
    const startedAt = performance.now();
    receive(payload, now);
    spent.push(performance.now() - startedAt);
  };
  return spent;
}

let rig: Rig;

beforeAll(async () => {
  rig = await Rig.start();
});

afterAll(async () => {
  await rig.stop();
});

test('B1 load: where a burst of 200 messages spends its time', { timeout: 30 * 60_000 }, async () => {
  rig.writer.faults.push = PUSH;
  const server = await rig.startServer({
    CHAT_TOPICS: TOPIC,
    CHAT_SITE_ORIGIN: 'https://chat.example.com',
    HEARTBEAT_BEE_URL: rig.writer.url,
    HEARTBEAT_INTERVAL_MS: String(2000 * SCALE),
    HEARTBEAT_STALE_MS: String(600_000),
    RATE_PER_SENDER: '30',
    RATE_PER_CHAT: '600',
    HISTORY_SAVE_INTERVAL_MS: String(5000 * SCALE),
    NOTE_SLOT_MS: String(2000 * SCALE),
    NOTE_HEARTBEAT_MS: String(30_000 * SCALE),
    REQUEST_TIMEOUT_MS: '600000',
  });
  const intakeMs = timeIntake(server);
  await waitFor(() => server.healthReport().chats.some((chat) => chat.topic === TOPIC && chat.state === 'ready'));

  const writer = new Bee(rig.writer.url).messaging;
  const identifier = Identifier.fromString(rig.gsocIdentifier);
  const gsocKey = new PrivateKey(rig.gsocKey);
  const write = (bytes: Uint8Array) => writer.gsocSend(rig.stamp, gsocKey, identifier, bytes, { deferred: false });

  const sent = new Map<string, Sent>();
  let following = true;
  const follow = (async () => {
    for (let slot = 0; following;) {
      const entry = rig.entry(slot, TOPIC);
      if (entry) {
        const record = sent.get(entry.msg.id);
        if (record && record.appearedAt === undefined) record.appearedAt = Date.now();
        slot += 1;
        continue;
      }
      await sleep(FOLLOW_INTERVAL_MS);
    }
  })();

  const send = async (key: string, sender: number, n: number) => {
    const built = createChatMessage(key, {
      topic: TOPIC,
      type: 'text',
      text: `B1 message ${n} from sender ${sender}`,
      name: `sender${sender}`,
      via: 'gateway',
    });
    const record: Sent = { id: built.message.id, firstSentAt: Date.now(), writes: 0, gaveUp: false };
    sent.set(record.id, record);
    for (let resend = 0; ; resend++) {
      record.writes += 1;
      await write(built.bytes).catch(() => undefined);
      await sleep(RESEND_INTERVAL_MS);
      if (record.appearedAt !== undefined) return;
      if (resend >= RESEND_ATTEMPTS) {
        record.gaveUp = true;
        return;
      }
    }
  };

  const startedAt = Date.now();
  const loopBefore = performance.eventLoopUtilization();
  await Promise.all(
    Array.from({ length: SENDERS }, async (_, sender) => {
      const key = testKey();
      const sends = [];
      for (let n = 0; n < MESSAGES_PER_SENDER; n++) {
        sends.push(send(key, sender, n));
        await sleep(SEND_SPACING_MS);
      }
      await Promise.all(sends);
    }),
  );
  await waitFor(() => [...sent.values()].every((record) => record.appearedAt !== undefined), 60_000, 'every message');
  following = false;
  await follow;
  const loop = performance.eventLoopUtilization(loopBefore);

  const records = [...sent.values()];
  const toFeed = records.map((record) => (record.appearedAt ?? 0) - record.firstSentAt);
  const writes = records.reduce((sum, record) => sum + record.writes, 0);
  const timings = server.healthReport().observations.publishTimings.find((entry) => entry.topic === TOPIC);
  const unscale = (ms: number) => Math.round(ms / SCALE);
  const lines = [
    `library message version ${MESSAGE_VERSION}, scale ${SCALE}, push ${PUSH.msPerChunk} ms a chunk, times below unscaled to the bed's`,
    `messages ${records.length}, gsoc writes ${writes}, resends per message ${((writes - records.length) / records.length).toFixed(2)}, gave up ${records.filter((r) => r.gaveUp).length}`,
    `first send to feed ms ${spread(toFeed.map(unscale))}, sender window ${unscale(SENDER_WINDOW_MS)}, smallest margin ${unscale(SENDER_WINDOW_MS - Math.max(...toFeed))}`,
    `first send to last in feed ms ${unscale(Math.max(...records.map((r) => r.appearedAt ?? 0)) - startedAt)}`,
    `feed write ms ${timings ? `p50 ${unscale(timings.feedWriteMs.p50)} p90 ${unscale(timings.feedWriteMs.p90)} max ${unscale(timings.feedWriteMs.max)}` : 'none'}`,
    `received to written ms ${timings ? `p50 ${unscale(timings.receivedToWrittenMs.p50)} p90 ${unscale(timings.receivedToWrittenMs.p90)} max ${unscale(timings.receivedToWrittenMs.max)}` : 'none'}`,
    `intake per frame ms, not scaled: ${spread(intakeMs, 3)} over ${intakeMs.length} frames, total ${Math.round(intakeMs.reduce((a, b) => a + b, 0))}`,
    `event loop utilization ${(loop.utilization * 100).toFixed(1)} %`,
    `writer pushed ${rig.writer.pushed.socChunks} single owner chunks and ${rig.writer.pushed.dataChunks} data chunks, ${rig.writer.pushed.dataBytes} history bytes`,
    `feed entry bytes ${rig.swarm.slotPayload(rig.feedOwner, TOPIC, 0)?.length}`,
  ];
  console.log(`\n[bench b1]\n${lines.map((line) => `[bench b1]   ${line}`).join('\n')}`);

  const ids = Array.from({ length: records.length }, (_, slot) => rig.entry(slot, TOPIC)?.msg.id);
  expect(new Set(ids).size).toBe(records.length);
  expect(rig.entry(records.length, TOPIC)).toBeUndefined();
});
