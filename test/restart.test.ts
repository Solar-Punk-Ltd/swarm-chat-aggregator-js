import { rm, utimes, writeFile } from 'node:fs/promises';
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

  test('walks forward past a checkpoint that fell behind the feed', async () => {
    await publish(2);
    const checkpointDir = rig.checkpointDir;
    await writeFile(
      join(checkpointDir, `${Topic.fromString(CHAT).toHex()}.json`),
      JSON.stringify({ v: 1, topic: CHAT, index: 0, history: null }),
    );
    await publishOne();
    await waitFor(() => rig.entry(2) !== undefined, 5000, 'slot 2');
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
