// The bed's own logic against a fake Bee: no cluster, no network.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WaitAbandoned, waitFor } from './cluster.mjs';
import { FeedFollower } from './feed.mjs';
import { FeedLedger, isClean } from './ledger.mjs';
import { parseChatMessage, PayloadFormat, payloadsFor, randomKey } from './payloads.mjs';
import { GsocSender, SendOutcome } from './sender.mjs';

const decode = (bytes) => new TextDecoder().decode(bytes);
const draft = (key) => ({ key, topic: 'chat-bed-test', text: 'hello', name: 'tester', index: 0 });

/** A feed as bee-js's reader shows it: a payload per written slot, a 404 past the last. */
function fakeFeed(entries) {
  return {
    entries,
    async downloadPayload({ index }) {
      const entry = this.entries[Number(index.toBigInt())];
      if (entry === undefined) throw Object.assign(new Error('Request failed with status code 404'), { status: 404 });
      return { payload: { toJSON: () => entry } };
    },
  };
}

function fakeMessaging({ failFirst = 0 } = {}) {
  return {
    sent: [],
    failures: failFirst,
    async gsocSend(_stamp, _key, _identifier, bytes) {
      if (this.failures-- > 0) throw new Error('gateway unavailable');
      this.sent.push(bytes);
    },
  };
}

function sender(format, messaging, isPublished) {
  return new GsocSender({
    messaging,
    stamp: '00'.repeat(32),
    gsocKey: randomKey(),
    gsocIdentifier: 'bed-test',
    format,
    resendIntervalMs: 1,
    resendAttempts: 5,
    isPublished,
  });
}

describe('FeedLedger', () => {
  it('passes a feed holding every message once', () => {
    const ledger = new FeedLedger();
    ['a', 'b', 'c'].forEach((id, index) => ledger.record(index, id));
    assert.ok(isClean(ledger.verdict(['a', 'b', 'c'])));
    assert.equal(ledger.nextIndex, 3);
  });

  it('names what is missing, duplicated, overwritten and foreign', () => {
    const ledger = new FeedLedger();
    ledger.record(0, 'a');
    ledger.record(1, 'b');
    ledger.record(2, 'a');
    ledger.record(3, null);
    ledger.record(4, 'x');
    ledger.record(1, 'c');
    const verdict = ledger.verdict(['a', 'b', 'c', 'd']);
    assert.deepEqual(verdict.missing, ['b', 'd']);
    assert.deepEqual(verdict.duplicated, [{ id: 'a', slots: [0, 2] }]);
    assert.deepEqual(verdict.overwritten, [{ index: 1, first: 'b', last: 'c' }]);
    assert.deepEqual(verdict.foreign, [
      { index: 3, id: null },
      { index: 4, id: 'x' },
    ]);
  });
});

describe('payloads', () => {
  it('v7 builds a message the library accepts, and a forgery and a malformed payload it refuses', () => {
    const payloads = payloadsFor(PayloadFormat.V7);
    const key = randomKey();
    const built = payloads.build(draft(key));
    const accepted = parseChatMessage(built.bytes);
    assert.ok(accepted.ok);
    assert.equal(accepted.message.id, built.id);
    assert.equal(parseChatMessage(payloads.forge(draft(key)).bytes).reason, 'signature');
    assert.equal(parseChatMessage(payloads.malformed('chat-bed-test')).ok, false);
  });

  it('v6 builds 6.2.8 shape, and a forgery claims an address other than its signer', () => {
    const payloads = payloadsFor(PayloadFormat.V6);
    const key = randomKey();
    const message = JSON.parse(decode(payloads.build(draft(key)).bytes));
    assert.deepEqual(Object.keys(message).sort(), [
      'address',
      'chatTopic',
      'id',
      'index',
      'message',
      'signature',
      'timestamp',
      'type',
      'userTopic',
      'username',
    ]);
    assert.equal(message.address, key.publicKey().address().toHex());
    const forged = JSON.parse(decode(payloads.forge(draft(key)).bytes));
    assert.notEqual(forged.address, key.publicKey().address().toHex());
    assert.throws(() => JSON.parse(decode(payloads.malformed('chat-bed-test'))));
  });
});

describe('FeedFollower', () => {
  it('follows a feed forward and sees a slot overwritten on the reread', async () => {
    const feed = fakeFeed([{ msg: { id: 'a' } }, { msg: { id: 'b' } }]);
    const follower = new FeedFollower({ format: PayloadFormat.V7, reader: feed });
    await follower.catchUp();
    assert.equal(follower.ledger.nextIndex, 2);

    feed.entries[1] = { msg: { id: 'c' } };
    feed.entries[2] = 'not a message';
    await follower.rereadAll();
    const verdict = follower.ledger.verdict(['a', 'b', 'c']);
    assert.deepEqual(verdict.overwritten, [{ index: 1, first: 'b', last: 'c' }]);
    assert.deepEqual(verdict.foreign, [{ index: 2, id: null }]);
    assert.deepEqual(verdict.missing, ['b']);
  });
});

describe('GsocSender', () => {
  it('v7 resends the identical bytes until the message is read back', async () => {
    const messaging = fakeMessaging();
    let reads = 0;
    const outcome = await sender(PayloadFormat.V7, messaging, async () => ++reads > 2).send({
      id: 'a',
      bytes: new Uint8Array([1, 2, 3]),
    });
    assert.equal(outcome, SendOutcome.CONFIRMED);
    assert.equal(messaging.sent.length, 3);
    assert.ok(messaging.sent.every((bytes) => bytes.join() === '1,2,3'));
  });

  it('v7 gives up after its resends and reports the message failed', async () => {
    const messaging = fakeMessaging();
    const outcome = await sender(PayloadFormat.V7, messaging, async () => false).send({
      id: 'a',
      bytes: new Uint8Array([1]),
    });
    assert.equal(outcome, SendOutcome.FAILED);
    assert.equal(messaging.sent.length, 6);
  });

  it('v6 never reads the feed and retries only a failed write', async () => {
    const messaging = fakeMessaging({ failFirst: 2 });
    const outcome = await sender(PayloadFormat.V6, messaging, async () => {
      throw new Error('a v6 sender must not read the feed');
    }).send({ id: 'a', bytes: new Uint8Array([1]) });
    assert.equal(outcome, SendOutcome.SENT);
    assert.equal(messaging.sent.length, 1);
  });
});

describe('waitFor', () => {
  it('retries a probe that throws an ordinary error until it answers', async () => {
    let calls = 0;
    const value = await waitFor(
      'a flaky answer',
      async () => {
        calls++;
        if (calls < 3) throw new Error('not yet');
        return 'answered';
      },
      { timeoutMs: 5000, intervalMs: 1 },
    );
    assert.equal(value, 'answered');
    assert.equal(calls, 3);
  });

  it('stops at once when the probe says there is nothing left to wait for', async () => {
    let calls = 0;
    const started = Date.now();
    await assert.rejects(
      waitFor(
        'a container that exited',
        async () => {
          calls++;
          throw new WaitAbandoned('the container exited');
        },
        { timeoutMs: 60_000, intervalMs: 1000 },
      ),
      /the container exited/,
    );
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 1000);
  });
});
