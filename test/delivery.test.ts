import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { Rig, message, waitFor } from './helpers/harness.js';

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

  test('a write that landed but answered an error counts as written when the retry finds its own bytes', async () => {
    const server = await rig.startServer();
    rig.writer.faults.writesLandThenFail = 3;
    await rig.send(message({ text: 'landed after all' }));
    await waitFor(() => server.stats.dropped.get('dead-letter') === 1, 5000, 'dead letter');
    expect(server.healthReport().healthy).toBe(false);

    await rig.send(message({ text: 'next' }));
    await waitFor(() => server.stats.published === 2, 5000, 'both published');
    expect(rig.entry(0)?.msg.text).toBe('landed after all');
    expect(rig.entry(1)?.msg.text).toBe('next');
    expect(server.healthReport().chats[0]?.failing).toBe(false);
  });

  test('a message given up on goes to the dead letter log and its slot goes to the next message', async () => {
    const server = await rig.startServer();
    rig.writer.faults.writeFailures = 3;
    await rig.send(message({ text: 'lost' }));
    await waitFor(() => server.stats.dropped.get('dead-letter') === 1, 5000, 'dead letter');
    const report = server.healthReport();
    expect(report.healthy).toBe(false);
    expect(report.problems.join(' ')).toContain('slot 0');

    await rig.send(message({ text: 'kept' }));
    await waitFor(() => server.stats.published === 1, 5000, 'published');
    expect(rig.entry(0)?.msg.text).toBe('kept');
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

describe('history', () => {
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
    const server = await rig.startServer({ SHUTDOWN_DEADLINE_MS: '150' });
    rig.writer.faults.socWriteDelayMs = 400;
    for (let i = 0; i < 3; i++) {
      await rig.send(message({ text: `late ${i}` }));
    }
    await waitFor(() => server.stats.received === 3, 5000, 'all three received');
    await server.stop();
    expect(server.stats.dropped.get('shutdown')).toBeGreaterThanOrEqual(1);
  });
});
