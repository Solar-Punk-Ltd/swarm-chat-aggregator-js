import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { CHAT as CHAT_TOPIC, Rig, message, waitFor } from './helpers/harness.js';

let rig: Rig;

beforeEach(async () => {
  rig = await Rig.start();
});

afterEach(async () => {
  await rig.stop();
});

const bytesUploads = () => rig.writer.requests.filter((request) => request === 'POST /bytes').length;

describe('retries', () => {
  test('resends the identical entry after failed writes and publishes it once', async () => {
    const server = await rig.startServer();
    rig.writer.faults.writeFailures = 2;
    const sent = message();
    await rig.send(sent);
    await waitFor(() => server.stats.published === 1, 5000, 'published');
    expect(rig.entry(0)?.msg).toEqual(sent.message);
    expect(rig.writer.requests.filter((request) => request.startsWith('POST /soc')).length).toBe(3);
    expect(rig.entry(1)).toBeUndefined();
  });

  test('a write that keeps failing stalls its slot and the queue behind it, and never gives the slot away', async () => {
    // One slot in flight, so the second message waits in the queue behind the stuck one.
    const server = await rig.startServer({ PUBLISH_WINDOW: '1' });
    rig.writer.faults.writeFailures = 1_000_000;
    await rig.send(message({ text: 'stuck' }));
    await rig.send(message({ text: 'behind it' }));
    await waitFor(() => (server.healthReport().chats[0]?.stall?.attempts ?? 0) >= 4, 5000, 'several attempts');
    const report = server.healthReport();
    expect(report.healthy).toBe(false);
    expect(report.chats[0]?.stall).toMatchObject({ slot: 0 });
    expect(report.chats[0]?.stall?.stuckSeconds).toBeGreaterThanOrEqual(0);
    expect(report.chats[0]?.queued).toBe(1);

    rig.writer.faults.writeFailures = 0;
    await waitFor(() => server.stats.published === 2, 10_000, 'both published once Bee accepts writes');
    expect(rig.entry(0)?.msg.text).toBe('stuck');
    expect(rig.entry(1)?.msg.text).toBe('behind it');
    expect(server.healthReport().chats[0]?.stall).toBeNull();
  });

  test('a write that landed but answered an error counts as written when the retry finds its own bytes', async () => {
    const server = await rig.startServer();
    rig.writer.faults.writesLandThenFail = 5;
    await rig.send(message({ text: 'landed after all' }));
    await rig.send(message({ text: 'next' }));
    await waitFor(() => server.stats.published === 2, 10_000, 'both published');
    expect(rig.entry(0)?.msg.text).toBe('landed after all');
    expect(rig.entry(1)?.msg.text).toBe('next');
  });

  test('messages dropped past the queue limit are logged as dead letters with their ids', async () => {
    const server = await rig.startServer({ QUEUE_LIMIT: '1', PUBLISH_WINDOW: '1' });
    rig.writer.faults.writeFailures = 1_000_000;
    const first = message({ text: 'stuck' });
    const second = message({ text: 'queued' });
    const third = message({ text: 'over the limit' });
    await rig.send(first);
    await waitFor(() => server.healthReport().chats[0]?.stall !== null, 5000, 'the stall');
    await rig.send(second);
    await rig.send(third);
    await waitFor(() => server.stats.dropped.get('queue-full') === 1, 5000, 'queue full');
    const deadLetters = rig.logs.filter((line) => line.includes('"deadLetter":true'));
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toContain(third.message.id);
  });

  test('a Bee request that never answers ends at the request timeout and is retried', async () => {
    const server = await rig.startServer({ REQUEST_TIMEOUT_MS: '200' });
    rig.writer.faults.hang = /^\/chunks\//;
    const started = Date.now();
    await rig.send(message({ text: 'held' }));
    await waitFor(() => server.healthReport().chats[0]?.lastError?.includes('aborted') ?? false, 5000, 'timeout');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(server.healthReport().chats[0]?.state).toBe('resuming');

    rig.writer.faults.hang = undefined;
    await waitFor(() => server.stats.published === 1, 5000, 'published once Bee answers');
    expect(rig.entry(0)?.msg.text).toBe('held');
  });

  test('a history save that fails is retried and never holds a message back', async () => {
    const server = await rig.startServer();
    rig.writer.faults.dataUploadFailures = 100;
    await rig.send(message({ text: 'one' }));
    await rig.send(message({ text: 'two' }));
    await waitFor(() => server.stats.published === 2, 5000, 'published without history');
    expect(rig.entry(1)?.history).toBeNull();

    rig.writer.faults.dataUploadFailures = 0;
    await rig.send(message({ text: 'three' }));
    await waitFor(() => server.healthReport().chats[0]?.history?.toSeq === 2, 5000, 'history caught up');
    const file = rig.history(server.healthReport().chats[0]?.history?.ref ?? '');
    expect(file.messages.map((row) => row.msg.text)).toEqual(['one', 'two', 'three']);
  });
});

describe('observations', () => {
  test('/health reports how long each stage of a publish took, as observations', async () => {
    const server = await rig.startServer();
    rig.writer.faults.socWriteDelayMs = 100;
    for (let i = 0; i < 3; i++) {
      await rig.send(message({ text: `timed ${i}` }));
    }
    await waitFor(
      () => server.healthReport().observations.publishTimings[0]?.samples === 3,
      5000,
      'three timed publishes',
    );
    const timings = server.healthReport().observations.publishTimings[0];
    expect(timings?.topic).toBe(CHAT_TOPIC);
    expect(timings?.samples).toBe(3);
    expect(timings?.feedWriteMs.p50).toBeGreaterThanOrEqual(100);
    for (const stage of [timings?.preWriteReadMs, timings?.checkpointWriteMs, timings?.receivedToWrittenMs]) {
      expect(stage?.p50).toBeGreaterThanOrEqual(0);
      expect(stage?.max).toBeGreaterThanOrEqual(stage?.p90 ?? Infinity);
    }
    expect(timings?.receivedToWrittenMs.max).toBeGreaterThanOrEqual(timings?.feedWriteMs.max ?? Infinity);
  });
});

describe('history', () => {
  test('a history upload slower than a single request is given its own timeout', async () => {
    const server = await rig.startServer({ REQUEST_TIMEOUT_MS: '200', HISTORY_TIMEOUT_MS: '3000' });
    rig.writer.faults.dataUploadDelayMs = 500;
    await rig.send(message({ text: 'saved slowly' }));
    await waitFor(() => server.healthReport().chats[0]?.history?.toSeq === 0, 5000, 'the slow save');
    expect(rig.history(server.healthReport().chats[0]?.history?.ref ?? '').messages).toHaveLength(1);
  });

  test('failing history saves and a long unsaved trail show on /health', async () => {
    const server = await rig.startServer({ HISTORY_TRAIL_LIMIT: '2' });
    rig.writer.faults.dataUploadFailures = 1_000_000;
    for (let i = 0; i < 3; i++) {
      await rig.send(message({ text: `unsaved ${i}` }));
    }
    await waitFor(() => server.stats.published === 3, 5000, 'published');
    await waitFor(() => server.healthReport().chats[0]?.lastHistoryError !== null, 5000, 'the save error');
    const report = server.healthReport();
    expect(report.healthy).toBe(false);
    expect(report.chats[0]?.historyTrail).toBe(3);
    expect(report.problems.join(' ')).toContain('history save failed');
    expect(report.problems.join(' ')).toContain('3 rows');

    rig.writer.faults.dataUploadFailures = 0;
    await rig.send(message({ text: 'saved at last' }));
    await waitFor(() => server.healthReport().chats[0]?.historyTrail === 0, 5000, 'the trail cleared');
    expect(server.healthReport().healthy).toBe(true);
  });

  test('a busy chat saves its history at most once per interval, and a quiet one at once', async () => {
    const server = await rig.startServer({ HISTORY_SAVE_INTERVAL_MS: '1000' });
    for (let i = 0; i < 10; i++) {
      await rig.send(message({ text: `steady ${i}` }));
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await waitFor(() => server.healthReport().chats[0]?.history?.toSeq === 9, 5000, 'history of all ten');
    expect(bytesUploads()).toBeLessThanOrEqual(3);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const before = bytesUploads();
    const sentAt = Date.now();
    await rig.send(message({ text: 'after a quiet spell' }));
    await waitFor(() => bytesUploads() === before + 1, 5000, 'the save after a quiet spell');
    expect(Date.now() - sentAt).toBeLessThan(500);
  });

  test('a burst of messages costs at most two saves', async () => {
    const server = await rig.startServer();
    rig.writer.faults.dataUploadDelayMs = 400;
    for (let i = 0; i < 6; i++) {
      await rig.send(message({ text: `burst ${i}` }));
    }
    await waitFor(() => server.stats.published === 6, 5000, 'burst published');
    await waitFor(() => server.healthReport().chats[0]?.history?.toSeq === 5, 5000, 'history of the burst');
    expect(bytesUploads()).toBeLessThanOrEqual(2);
  });

  test('closes a file at its limit and links the next one back to it', async () => {
    const server = await rig.startServer({}, { maxMessages: 3, maxBytes: 512 * 1024 });
    for (let i = 0; i < 5; i++) {
      await rig.send(message({ text: `row ${i}` }));
      await waitFor(() => server.stats.published === i + 1, 5000, `row ${i}`);
      await waitFor(() => server.healthReport().chats[0]?.history?.toSeq === i, 5000, `history ${i}`);
    }
    const newest = rig.history(server.healthReport().chats[0]?.history?.ref ?? '');
    expect(newest).toMatchObject({ fromSeq: 3, toSeq: 4 });
    expect(newest.messages.map((row) => row.seq)).toEqual([3, 4]);
    const older = rig.history(newest.prev?.ref ?? '');
    expect(newest.prev?.toSeq).toBe(2);
    expect(older).toMatchObject({ fromSeq: 0, toSeq: 2, prev: null });
    expect(rig.entry(4)?.history?.toSeq).toBe(3);
  });

  test('closes a file at its byte limit', async () => {
    const server = await rig.startServer({}, { maxMessages: 1000, maxBytes: 2000 });
    for (let i = 0; i < 4; i++) {
      await rig.send(message({ text: 'x'.repeat(400) }));
      await waitFor(() => server.healthReport().chats[0]?.history?.toSeq === i, 5000, `history ${i}`);
    }
    const newest = rig.history(server.healthReport().chats[0]?.history?.ref ?? '');
    expect(newest.fromSeq).toBeGreaterThan(0);
    expect(newest.prev).not.toBeNull();
  });
});

describe('shutdown', () => {
  test('stops intake and publishes what was queued before it stops', async () => {
    const server = await rig.startServer();
    rig.writer.faults.socWriteDelayMs = 100;
    for (let i = 0; i < 4; i++) {
      await rig.send(message({ text: `queued ${i}` }));
    }
    await waitFor(() => server.stats.received === 4, 5000, 'all four received');
    await server.stop();
    expect(server.stats.published).toBe(4);
    expect(rig.entry(3)?.msg.text).toBe('queued 3');
  });

  test('drops what is still queued at the deadline and counts it', async () => {
    const server = await rig.startServer({ SHUTDOWN_DEADLINE_MS: '150', PUBLISH_WINDOW: '1' });
    rig.writer.faults.socWriteDelayMs = 400;
    for (let i = 0; i < 3; i++) {
      await rig.send(message({ text: `late ${i}` }));
    }
    await waitFor(() => server.stats.received === 3, 5000, 'all three received');
    await server.stop();
    expect(server.stats.dropped.get('shutdown')).toBeGreaterThanOrEqual(1);
  });
});
