import { readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Bee, FeedIndex, Topic } from '@ethersphere/bee-js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { LockHeldError } from '../src/lock.js';
import { CHAT, Rig, message, waitFor } from './helpers/harness.js';

let rig: Rig;

beforeEach(async () => {
  rig = await Rig.start();
});

afterEach(async () => {
  await rig.stop();
});

async function publish(count: number, from = 0): Promise<void> {
  const server = await rig.startServer();
  for (let i = from; i < from + count; i++) {
    await rig.send(message({ text: `message ${i}` }));
    await waitFor(() => rig.entry(i) !== undefined, 5000, `slot ${i}`);
  }
  await waitFor(() => server.healthReport().chats[0]?.history?.toSeq === from + count - 1, 5000, 'history');
  await server.stop();
}

async function publishOne(overrides: Parameters<Rig['server']>[0] = {}) {
  const server = await rig.startServer(overrides);
  await rig.send(message({ text: 'after restart' }));
  return server;
}

describe('restart', () => {
  test('continues after the last slot its checkpoint names', async () => {
    await publish(3);
    rig.writer.faults.feedLookup = { status: 500 };
    await publishOne();
    await waitFor(() => rig.entry(3) !== undefined, 5000, 'slot 3');
    expect(rig.entry(3)?.msg.text).toBe('after restart');
    expect(rig.entry(2)?.msg.text).toBe('message 2');
  });

  test('a checkpoint that fell behind the feed blocks the chat at its next write instead of overwriting', async () => {
    await publish(2);
    await writeFile(
      join(rig.checkpointDir, `${Topic.fromString(CHAT).toHex()}.json`),
      JSON.stringify({ v: 2, topic: CHAT, index: 0, pending: null, history: null, rows: [] }),
    );
    const server = await publishOne();
    await waitFor(() => server.healthReport().chats[0]?.state === 'blocked', 5000, 'blocked');
    expect(rig.entry(1)?.msg.text).toBe('message 1');
  });

  test('without a checkpoint, walks forward from a head lookup that answers behind the head', async () => {
    await publish(5);
    await rm(join(rig.checkpointDir, `${Topic.fromString(CHAT).toHex()}.json`));
    rig.writer.faults.feedLookup = { staleBy: 3 };
    const server = await publishOne();
    await waitFor(() => rig.entry(5) !== undefined, 5000, 'slot 5');
    await waitFor(() => server.healthReport().chats[0]?.history?.toSeq === 5, 5000, 'history');
    const history = rig.history(server.healthReport().chats[0]?.history?.ref ?? '');
    expect(history.messages.map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('a 404 from the lookup is not a new chat while slot 0 holds an entry', async () => {
    await publish(3);
    await rm(join(rig.checkpointDir, `${Topic.fromString(CHAT).toHex()}.json`));
    rig.writer.faults.feedLookup = { status: 404 };
    rig.writer.faults.chunkMisses.set('*', 1);
    await publishOne();
    await waitFor(() => rig.entry(3) !== undefined, 5000, 'slot 3');
    expect(rig.entry(0)?.msg.text).toBe('message 0');
  });

  test('a 404 from the lookup with an unreadable chunk in slot 0 stops the chat instead of starting it', async () => {
    rig.swarm.corruptSlot(rig.feedOwner, CHAT, 0);
    rig.writer.faults.feedLookup = { status: 404 };
    const server = await publishOne();
    await waitFor(() => server.healthReport().chats[0]?.state === 'blocked', 5000, 'blocked');
    expect(rig.writer.socWrites).toBe(0);
  });

  test('starts a chat at slot 0 only when the lookup answers 404 and two reads of slot 0 answer as absent', async () => {
    rig.writer.faults.feedLookup = { status: 404 };
    await publishOne();
    await waitFor(() => rig.entry(0) !== undefined, 5000, 'slot 0');
    expect(rig.entry(0)?.msg.text).toBe('after restart');
  });

  test('a failed lookup leaves the chat unpublished and retries, never starting at 0', async () => {
    await publish(2);
    await rm(join(rig.checkpointDir, `${Topic.fromString(CHAT).toHex()}.json`));
    rig.writer.faults.feedLookup = { status: 500 };
    const writesBefore = rig.writer.socWrites;
    const server = await publishOne();
    await waitFor(() => server.healthReport().chats[0]?.lastError?.includes('head lookup') ?? false, 5000, 'error');
    const report = server.healthReport();
    expect(report.healthy).toBe(false);
    expect(report.chats[0]).toMatchObject({ state: 'resuming', queued: 1 });
    expect(rig.entry(0)?.msg.text).toBe('message 0');
    expect(rig.writer.socWrites).toBe(writesBefore);

    rig.writer.faults.feedLookup = {};
    await waitFor(() => rig.entry(2) !== undefined, 5000, 'slot 2 once the lookup answers');
    expect(rig.entry(2)?.msg.text).toBe('after restart');
  });

  test('a slot read that fails with a gateway error is retried and never taken as the head', async () => {
    await publish(2);
    rig.writer.faults.readFailures = 2;
    await publishOne();
    await waitFor(() => rig.entry(2) !== undefined, 5000, 'slot 2');
    expect(rig.entry(1)?.msg.text).toBe('message 1');
  });

  test('dedupes against what was published before the restart', async () => {
    const server = await rig.startServer();
    const once = message();
    await rig.send(once);
    await waitFor(() => rig.entry(0) !== undefined, 5000, 'slot 0');
    await waitFor(() => server.healthReport().chats[0]?.history !== null, 5000, 'history');
    await server.stop();

    const again = await rig.startServer();
    await rig.send(once);
    await waitFor(() => again.stats.dropped.get('duplicate') === 1, 5000, 'duplicate after restart');
    expect(rig.entry(1)).toBeUndefined();
  });
});

describe('a chat without a checkpoint', () => {
  test('does not start while the writing node has fewer peers than the floor, and starts once it has them', async () => {
    rig.writer.faults.connectedPeers = 2;
    const server = await publishOne();
    await waitFor(() => server.healthReport().chats[0]?.lastError?.includes('peers') ?? false, 5000, 'the refusal');
    expect(server.healthReport().chats[0]?.state).toBe('resuming');
    expect(rig.writer.socWrites).toBe(0);

    rig.writer.faults.connectedPeers = 3;
    await waitFor(() => rig.entry(0) !== undefined, 5000, 'slot 0');
    expect(server.healthReport().chats[0]?.startedWithoutCheckpoint).toBe(true);
    expect(rig.logs.some((line) => line.startsWith('warn') && line.includes('without a checkpoint'))).toBe(true);
  });

  test('does not start while the writing node is not ready or cannot say', async () => {
    rig.writer.faults.ready = false;
    const server = await publishOne();
    await waitFor(() => server.healthReport().chats[0]?.lastError?.includes('ready') ?? false, 5000, 'not ready');
    rig.writer.faults.ready = true;
    rig.writer.faults.statusFailure = 500;
    await waitFor(() => server.healthReport().chats[0]?.lastError?.includes('/readiness') ?? false, 5000, 'failed');
    expect(rig.writer.socWrites).toBe(0);
    rig.writer.faults.statusFailure = undefined;
    await waitFor(() => rig.entry(0) !== undefined, 5000, 'slot 0');
  });

  test('a second node that finds slot 0 wins over the writing node that missed it', async () => {
    await publish(1);
    await rm(join(rig.checkpointDir, `${Topic.fromString(CHAT).toHex()}.json`));
    rig.writer.faults.feedLookup = { status: 404 };
    rig.writer.faults.chunkMisses.set('*', 2);
    await publishOne();
    await waitFor(() => rig.entry(1) !== undefined, 5000, 'slot 1');
    expect(rig.entry(0)?.msg.text).toBe('message 0');
    expect(rig.entry(1)?.msg.text).toBe('after restart');
  });

  test('a second node that cannot answer in time is a failed control, never an empty slot', async () => {
    rig.writer.faults.feedLookup = { status: 404 };
    rig.listener.faults.hang = /^\/chunks\//;
    const server = await publishOne();
    await waitFor(() => server.healthReport().chats[0]?.lastError?.includes('second node') ?? false, 5000, 'control');
    expect(server.healthReport().chats[0]?.state).toBe('resuming');
    expect(rig.writer.socWrites).toBe(0);

    rig.listener.faults.hang = undefined;
    await waitFor(() => rig.entry(0) !== undefined, 5000, 'slot 0 once the second node answers');
  });
});

describe('write-ahead checkpoint', () => {
  test('resuming from a checkpoint reads no slot beyond the check before the next write', async () => {
    await publish(3);
    const readsBefore = rig.writer.requests.filter((request) => request.startsWith('GET /chunks')).length;
    const server = await rig.startServer();
    await rig.send(message({ text: 'after restart' }));
    await waitFor(() => server.healthReport().chats[0]?.state === 'ready', 5000, 'resumed');
    await waitFor(() => rig.entry(3) !== undefined, 5000, 'slot 3');
    const reads = rig.writer.requests.filter((request) => request.startsWith('GET /chunks')).slice(readsBefore);
    // One read of slot 3, and one more when it answers as absent: the check before the write, nothing else.
    expect(reads.length).toBeLessThanOrEqual(2);
  });

  test('a restart after a crash with a write pending sends exactly that entry to its slot', async () => {
    const server = await rig.startServer({ SHUTDOWN_DEADLINE_MS: '200' });
    rig.writer.faults.writeFailures = 1_000_000;
    const pending = message({ text: 'pending at the crash' });
    await rig.send(pending);
    await waitFor(() => server.healthReport().chats[0]?.stall !== null, 5000, 'the stall');
    await server.stop();

    rig.writer.faults.writeFailures = 0;
    const restarted = await rig.startServer();
    await rig.send(message({ text: 'after the restart' }));
    await waitFor(() => restarted.stats.published === 2, 5000, 'both published');
    expect(rig.entry(0)?.msg).toEqual(pending.message);
    expect(rig.entry(1)?.msg.text).toBe('after the restart');
  });

  test('a restart after a write that landed, before its checkpoint caught up, resends the same bytes once', async () => {
    const server = await rig.startServer({ SHUTDOWN_DEADLINE_MS: '200' });
    rig.writer.faults.writesLandThenFail = 1_000_000;
    await rig.send(message({ text: 'landed' }));
    await waitFor(() => rig.swarm.slotPayload(rig.feedOwner, CHAT, 0) !== undefined, 5000, 'the write landing');
    const landed = rig.swarm.slotPayload(rig.feedOwner, CHAT, 0);
    await server.stop();

    rig.writer.faults.writesLandThenFail = 0;
    const restarted = await rig.startServer();
    await rig.send(message({ text: 'next' }));
    await waitFor(() => restarted.stats.published === 2, 5000, 'both published');
    expect(rig.swarm.slotPayload(rig.feedOwner, CHAT, 0)).toEqual(landed);
    expect(rig.entry(1)?.msg.text).toBe('next');
  });

  test('a history save that finishes after the stop does not write the checkpoint', async () => {
    const server = await rig.startServer({ SHUTDOWN_DEADLINE_MS: '100' });
    rig.writer.faults.dataUploadDelayMs = 600;
    await rig.send(message({ text: 'saved late' }));
    await waitFor(() => server.stats.published === 1, 5000, 'published');
    await waitFor(() => server.healthReport().chats[0]?.historySaving === true, 5000, 'the save running');
    await server.stop();
    const path = join(rig.checkpointDir, `${Topic.fromString(CHAT).toHex()}.json`);
    const atStop = await readFile(path, 'utf8');
    await waitFor(() => rig.swarm.data.size === 1, 5000, 'the late save landing');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await readFile(path, 'utf8')).toBe(atStop);
  });

  test('a damaged checkpoint blocks the chat loudly and never starts it at 0', async () => {
    await writeFile(join(rig.checkpointDir, `${Topic.fromString(CHAT).toHex()}.json`), '{"v":2,"topic":"chat-te');
    const server = await publishOne();
    await waitFor(() => server.healthReport().chats[0]?.state === 'blocked', 5000, 'blocked');
    expect(server.healthReport().problems.join(' ')).toContain('checkpoint');
    expect(rig.writer.socWrites).toBe(0);
    expect(rig.logs.some((line) => line.startsWith('error') && line.includes('checkpoint'))).toBe(true);
  });
});

describe('one writer', () => {
  test('stops publishing a chat when its next slot already holds bytes it did not write', async () => {
    await publish(1);
    const intruder = new Bee(rig.writer.url).feed.makeWriter(Topic.fromString(CHAT), rig.feedKey);
    await intruder.uploadPayload(rig.stamp, new TextEncoder().encode('{"someone":"else"}'), {
      index: FeedIndex.fromBigInt(1n),
    });
    const server = await publishOne();
    await waitFor(() => server.healthReport().chats[0]?.state === 'blocked', 5000, 'blocked');
    const report = server.healthReport();
    expect(report.healthy).toBe(false);
    expect(report.problems.join(' ')).toContain('another writer');
    expect(rig.swarm.slotJson(rig.feedOwner, CHAT, 1)).toEqual({ someone: 'else' });
    expect(rig.entry(2)).toBeUndefined();
  });

  test('reads the slot before writing it and stops when another writer took it while running', async () => {
    const server = await rig.startServer();
    await rig.send(message({ text: 'first' }));
    await waitFor(() => server.stats.published === 1, 5000, 'first');
    const intruder = new Bee(rig.writer.url).feed.makeWriter(Topic.fromString(CHAT), rig.feedKey);
    await intruder.uploadPayload(rig.stamp, new TextEncoder().encode('{"someone":"else"}'), {
      index: FeedIndex.fromBigInt(1n),
    });
    await rig.send(message({ text: 'second' }));
    await waitFor(() => server.healthReport().chats[0]?.state === 'blocked', 5000, 'blocked');
    expect(rig.swarm.slotJson(rig.feedOwner, CHAT, 1)).toEqual({ someone: 'else' });
  });

  test('stops a chat whose next slot holds a chunk that is not a valid update, rather than retry it forever', async () => {
    await publish(1);
    rig.swarm.corruptSlot(rig.feedOwner, CHAT, 1);
    const server = await publishOne();
    await waitFor(() => server.healthReport().chats[0]?.state === 'blocked', 5000, 'blocked');
    expect(server.healthReport().problems.join(' ')).toContain('slot 1');
  });

  test('stops a chat when the slot it is about to write turns out to hold an unreadable chunk', async () => {
    const server = await rig.startServer();
    await rig.send(message({ text: 'first' }));
    await waitFor(() => server.stats.published === 1, 5000, 'first');
    rig.swarm.corruptSlot(rig.feedOwner, CHAT, 1);
    await rig.send(message({ text: 'second' }));
    await waitFor(() => server.healthReport().chats[0]?.state === 'blocked', 5000, 'blocked');
    expect(server.stats.dropped.get('chat-blocked')).toBe(1);
  });

  test('a start refuses while a live instance holds the checkpoint lock', async () => {
    await rig.startServer();
    const second = rig.server();
    await expect(second.start()).rejects.toBeInstanceOf(LockHeldError);
  });

  test('a restart after a kill takes the lock over once it goes stale', async () => {
    const lock = join(rig.checkpointDir, 'writer.lock');
    await writeFile(lock, 'a-killed-instance');
    const old = new Date(Date.now() - 10_000);
    await utimes(lock, old, old);
    const started = Date.now();
    await rig.startServer();
    expect(Date.now() - started).toBeLessThan(2000);
    await rig.send(message());
    await waitFor(() => rig.entry(0) !== undefined, 5000, 'slot 0');
  });

  test('an instance whose lock was taken over stops publishing', async () => {
    const server = await rig.startServer();
    await writeFile(join(rig.checkpointDir, 'writer.lock'), 'another-instance');
    await waitFor(() => rig.fatal.length === 1, 5000, 'fatal');
    expect(rig.fatal[0]).toContain('another-instance');
    await rig.send(message()).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.stats.published).toBe(0);
    expect(rig.entry(0)).toBeUndefined();
  });
});
