import { Topic } from '@ethersphere/bee-js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { feedSlotAddress } from './helpers/fakeBee.js';
import { CHAT, Rig, message, waitFor } from './helpers/harness.js';

const SLOT_MS = 200;
const HEARTBEAT_MS = 600;
const NOTES = { NOTE_SLOT_MS: String(SLOT_MS), NOTE_HEARTBEAT_MS: String(HEARTBEAT_MS) };

let rig: Rig;

beforeEach(async () => {
  rig = await Rig.start();
});

afterEach(async () => {
  await rig.stop();
});

const slotAddress = (index: number) => feedSlotAddress(rig.feedOwner, Topic.fromString(CHAT), index);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('slot notes', () => {
  test('once a slot ends in which a message landed, its note names the newest slot written', async () => {
    await rig.startServer(NOTES);
    const sentAt = Date.now();
    await rig.send(message({ text: 'first' }));
    await waitFor(() => rig.notes(sentAt, Date.now(), SLOT_MS).some(({ note }) => note.newest === 0), 5000, 'a note');
    const noted = rig.notes(sentAt, Date.now(), SLOT_MS).find(({ note }) => note.newest === 0)!;
    const landedAt = rig.swarm.storedAt.get(slotAddress(0))!;
    expect(noted.slot).toBe(Math.floor(landedAt / SLOT_MS));
    expect(noted.note.writtenAt).toBeGreaterThanOrEqual((noted.slot + 1) * SLOT_MS);
  });

  test('never names a slot before its entry landed', async () => {
    await rig.startServer(NOTES);
    await rig.send(message({ text: 'opens the chat' }));
    await waitFor(() => rig.entry(0) !== undefined, 5000, 'slot 0');
    rig.writer.faults.slowWrites.set(slotAddress(1), 3 * SLOT_MS);
    const sentAt = Date.now();
    await rig.send(message({ text: 'slow to land' }));
    await waitFor(() => rig.notes(sentAt, Date.now(), SLOT_MS).some(({ note }) => note.newest === 1), 5000, 'note 1');
    const landedAt = rig.swarm.storedAt.get(slotAddress(1))!;
    for (const { note } of rig.notes(sentAt - SLOT_MS, Date.now(), SLOT_MS)) {
      expect(note.newest < 1 || note.writtenAt >= landedAt).toBe(true);
    }
  });

  test('writes a heartbeat note at least every NOTE_HEARTBEAT_MS while the chat is active, with no news', async () => {
    await rig.startServer(NOTES);
    await rig.send(message());
    await waitFor(() => rig.entry(0) !== undefined, 5000, 'slot 0');
    const from = Date.now();
    await sleep(4 * HEARTBEAT_MS);
    const notes = rig.notes(from, Date.now(), SLOT_MS);
    expect(notes.length).toBeGreaterThanOrEqual(3);
    expect(notes.every(({ note }) => note.newest === 0)).toBe(true);
    const gaps = notes.slice(1).map(({ note }, i) => note.writtenAt - notes[i]!.note.writtenAt);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(HEARTBEAT_MS + SLOT_MS);
  });

  test('a note write that fails is not retried at its address, and the next slot carries the news', async () => {
    await rig.startServer(NOTES);
    await rig.send(message({ text: 'opens the chat' }));
    await waitFor(() => rig.entry(0) !== undefined, 5000, 'slot 0');
    const feedSlots = new Set([0, 1, 2].map(slotAddress));
    let refusals = 2;
    rig.writer.faults.refuseWrite = (address) => !feedSlots.has(address) && refusals-- > 0;
    const sentAt = Date.now();
    await rig.send(message({ text: 'news' }));
    await waitFor(() => rig.notes(sentAt, Date.now(), SLOT_MS).some(({ note }) => note.newest === 1), 5000, 'news');

    const noteWrites = rig.writer.socWriteAddresses.filter((address) => !feedSlots.has(address));
    const refused = noteWrites.filter((address) => rig.swarm.chunks.get(address) === undefined);
    expect(refused).toHaveLength(2);
    for (const address of refused) {
      expect(noteWrites.filter((written) => written === address)).toHaveLength(1);
    }
  });

  test('a chat that has not been opened since the start writes no notes', async () => {
    await rig.startServer(NOTES);
    const from = Date.now();
    await sleep(3 * HEARTBEAT_MS);
    expect(rig.notes(from, Date.now(), SLOT_MS)).toEqual([]);
    expect(rig.writer.socWriteAddresses).toEqual([]);
  });

  test('a stopped server writes no more notes', async () => {
    const server = await rig.startServer(NOTES);
    await rig.send(message());
    await waitFor(() => rig.entry(0) !== undefined, 5000, 'slot 0');
    await server.stop();
    const writes = rig.writer.socWriteAddresses.length;
    await sleep(2 * HEARTBEAT_MS);
    expect(rig.writer.socWriteAddresses).toHaveLength(writes);
  });

  test('a blocked chat writes no more notes', async () => {
    const server = await rig.startServer(NOTES);
    await rig.send(message({ text: 'first' }));
    await waitFor(() => rig.entry(0) !== undefined, 5000, 'slot 0');
    rig.writer.faults.refuseWrite = (address) => address === slotAddress(1);
    rig.swarm.corruptSlot(rig.feedOwner, CHAT, 1);
    await rig.send(message({ text: 'second' }));
    await waitFor(() => server.healthReport().chats[0]?.state === 'blocked', 5000, 'blocked');
    const writes = rig.writer.socWriteAddresses.length;
    await sleep(2 * HEARTBEAT_MS);
    expect(rig.writer.socWriteAddresses).toHaveLength(writes);
  });

  test('/health says when each chat last wrote a note and how many failed', async () => {
    const server = await rig.startServer(NOTES);
    await rig.send(message());
    await waitFor(() => (server.healthReport().chats[0]?.notes.written ?? 0) > 0, 5000, 'a note');
    expect(server.healthReport().chats[0]?.notes).toMatchObject({ failed: 0 });
    expect(server.healthReport().chats[0]?.notes.lastWrittenAt).toBeGreaterThan(0);
  });
});

describe('the read before a write', () => {
  test('in a running chat a slot is written without reading it first', async () => {
    const server = await rig.startServer();
    await rig.send(message({ text: 'opens the chat' }));
    await waitFor(() => server.stats.published === 1, 5000, 'first');
    await rig.send(message({ text: 'in a running chat' }));
    await waitFor(() => server.stats.published === 2, 5000, 'second');
    expect(rig.writer.requests).not.toContain(`GET /chunks/${slotAddress(1)}`);
    expect(server.healthReport().chats[0]?.state).toBe('ready');
  });

  test('after a write that failed, the slot is read before it is written again', async () => {
    const server = await rig.startServer();
    await rig.send(message({ text: 'opens the chat' }));
    await waitFor(() => server.stats.published === 1, 5000, 'first');
    rig.writer.faults.writesLandThenFail = 1;
    await rig.send(message({ text: 'lands, then answers an error' }));
    await waitFor(() => server.stats.published === 2, 5000, 'second');
    expect(rig.writer.requests).toContain(`GET /chunks/${slotAddress(1)}`);
    expect(rig.writer.socWriteAddresses.filter((address) => address === slotAddress(1))).toHaveLength(1);
  });

  test('the first write after a restart reads its slot first, which is how a checkpoint behind the feed is caught', async () => {
    const first = await rig.startServer();
    await rig.send(message({ text: 'before the restart' }));
    await waitFor(() => first.stats.published === 1, 5000, 'first');
    await first.stop();
    const second = await rig.startServer();
    await rig.send(message({ text: 'after the restart' }));
    await waitFor(() => second.stats.published === 1, 5000, 'after the restart');
    const read = rig.writer.requests.indexOf(`GET /chunks/${slotAddress(1)}`);
    expect(read).toBeGreaterThanOrEqual(0);
    await rig.send(message({ text: 'running again' }));
    await waitFor(() => second.stats.published === 2, 5000, 'running again');
    expect(rig.writer.requests).not.toContain(`GET /chunks/${slotAddress(2)}`);
  });
});
