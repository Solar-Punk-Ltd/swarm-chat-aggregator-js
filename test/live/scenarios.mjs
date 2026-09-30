// B1 to B4. Each runs in a chat topic of its own on one cluster and one server, and passes only on what the feed
// holds at the end: every valid message exactly once, no slot overwritten, nothing else published.
import { FeedFollower } from './feed.mjs';
import { describeVerdict, isClean } from './ledger.mjs';
import { payloadsFor, randomKey } from './payloads.mjs';
import { describeSendError, GsocSender, SendOutcome } from './sender.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long the feed is watched after the last expected message appears, so a late duplicate still shows. */
const QUIET_AFTER_COMPLETE_MS = 10_000;
const FOLLOW_INTERVAL_MS = 1000;

/**
 * @typedef {object} BedContext
 * @property {import('./cluster.mjs').Cluster} cluster
 * @property {import('./server.mjs').ServerProcess} server
 * @property {string} format
 * @property {string} runId
 * @property {string} senderStamp
 * @property {import('@ethersphere/bee-js').PrivateKey} gsocKey
 * @property {string} gsocIdentifier
 * @property {string} feedOwner
 * @property {{intervalMs: number, attempts: number}} resend
 * @property {(line: string) => void} log
 * @property {(line: string) => void} observe
 */

/** One chat for one scenario: its topic, a follower of its feed, and senders that write to it. */
class Chat {
  /** @param {BedContext} ctx */
  constructor(ctx, scenario) {
    this.ctx = ctx;
    this.topic = `chat-bed-${scenario.toLowerCase()}-${ctx.runId}`;
    this.payloads = payloadsFor(ctx.format);
    this.follower = new FeedFollower({
      beeUrl: ctx.cluster.url('worker'),
      owner: ctx.feedOwner,
      topic: this.topic,
      format: ctx.format,
    });
    this.expectedIds = [];
    this.outcomes = [];
    /** Writes the node refused, by what it said, so a refusal fails the scenario rather than the bed. */
    this.refusals = new Map();
    this.senders = [];
    this.following = true;
    this.followLoop = this.follow();
  }

  async follow() {
    while (this.following) {
      try {
        await this.follower.catchUp();
      } catch (error) {
        this.ctx.log(`feed read failed, retrying: ${error.message}`);
      }
      await sleep(FOLLOW_INTERVAL_MS);
    }
  }

  /** Runs a write and turns a refusal into a recorded outcome, so no send can end the bed. */
  async attempt(write) {
    try {
      return await write();
    } catch (error) {
      const line = describeSendError(error);
      this.refusals.set(line, (this.refusals.get(line) ?? 0) + 1);
      return SendOutcome.REFUSED;
    }
  }

  /** This chat's publish timings from the server's /health observations, as one line. */
  async publishTimings() {
    const health = await this.ctx.server.health();
    const timings = health?.observations?.publishTimings;
    if (!Array.isArray(timings)) return 'publish timings not reported by this server';
    const mine = timings.find((entry) => entry.topic === this.topic);
    if (!mine) return 'no publish timings for this chat';
    const stages = ['preWriteReadMs', 'checkpointWriteMs', 'feedWriteMs', 'receivedToWrittenMs'].map(
      (stage) => `${stage} p50 ${mine[stage]?.p50} p90 ${mine[stage]?.p90} max ${mine[stage]?.max}`,
    );
    return `publish timings over ${mine.samples} publishes: ${stages.join(', ')}`;
  }

  person(name) {
    const key = randomKey();
    const sender = new GsocSender({
      beeUrl: this.ctx.cluster.url('worker'),
      stamp: this.ctx.senderStamp,
      gsocKey: this.ctx.gsocKey,
      gsocIdentifier: this.ctx.gsocIdentifier,
      format: this.ctx.format,
      resendIntervalMs: this.ctx.resend.intervalMs,
      resendAttempts: this.ctx.resend.attempts,
      isPublished: async (id) => this.follower.ledger.has(id),
    });
    this.senders.push(sender);
    let index = 0;
    return {
      say: async (text) => {
        const payload = this.payloads.build({ key, topic: this.topic, text, name, index: index++ });
        this.expectedIds.push(payload.id);
        this.firstSentAt ??= Date.now();
        const outcome = await this.attempt(() => sender.send(payload));
        this.outcomes.push(outcome);
        return outcome;
      },
      sendForged: (text) =>
        this.attempt(() =>
          sender.sendOnce(this.payloads.forge({ key, topic: this.topic, text, name, index: index++ }).bytes),
        ),
      sendMalformed: () => this.attempt(() => sender.sendOnce(this.payloads.malformed(this.topic))),
    };
  }

  async settle(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const allThere = () => this.expectedIds.every((id) => this.follower.ledger.has(id));
    while (!allThere() && Date.now() < deadline) await sleep(FOLLOW_INTERVAL_MS);
    await sleep(QUIET_AFTER_COMPLETE_MS);
    this.following = false;
    await this.followLoop;
    await this.follower.rereadAll();

    const verdict = this.follower.ledger.verdict(this.expectedIds);
    const failedSends = this.outcomes.filter((o) => o === SendOutcome.FAILED).length;
    const writes = this.senders.reduce((sum, s) => sum + s.writes, 0);
    for (const sender of this.senders) {
      for (const line of sender.writeErrors ?? []) this.refusals.set(line, (this.refusals.get(line) ?? 0) + 1);
    }
    const messages = this.expectedIds.length;
    const serverErrors = [...this.refusals].reduce(
      (sum, [line, count]) => sum + (line.startsWith('500 ') ? count : 0),
      0,
    );
    const resendsPerMessage = messages ? ((writes - messages) / messages).toFixed(2) : '0';
    this.ctx.observe(
      `${this.topic}: ${messages} messages, ${writes} GSOC writes, ${resendsPerMessage} resends per message, ` +
        `${serverErrors} answered 500, ${this.follower.ledger.slots.size} feed slots`,
    );
    const lastAppearedAt = this.follower.ledger.lastAppearedAt(this.expectedIds);
    this.ctx.observe(
      `${this.topic}: first send to last message in the feed ` +
        (lastAppearedAt === null || this.firstSentAt === undefined
          ? 'not reached, some messages never appeared'
          : `${lastAppearedAt - this.firstSentAt} ms, to the feed follower's 1 s poll`),
    );
    this.ctx.observe(`${this.topic}: ${await this.publishTimings()}`);
    const problems = [];
    if (!isClean(verdict)) problems.push(describeVerdict(verdict));
    if (failedSends) problems.push(`${failedSends} sends gave up unconfirmed`);
    for (const [line, count] of this.refusals) problems.push(`${count} writes refused by the node: ${line}`);
    return { passed: problems.length === 0, detail: problems.join('; ') || describeVerdict(verdict), verdict };
  }
}

async function timed(ctx, label, step) {
  const started = Date.now();
  try {
    return await step();
  } finally {
    ctx.observe(`${label}: ${Date.now() - started} ms`);
  }
}

/** Twenty people at once, ten messages each. */
async function b1(ctx) {
  const chat = new Chat(ctx, 'B1');
  const people = Array.from({ length: 20 }, (_, n) => chat.person(`sender${n}`));
  await timed(ctx, 'B1 sends', () =>
    Promise.all(
      people.map(async (person, n) => {
        const sends = [];
        for (let m = 0; m < 10; m++) {
          sends.push(person.say(`B1 message ${m} from sender ${n}`));
          await sleep(200);
        }
        await Promise.all(sends);
      }),
    ),
  );
  return timed(ctx, 'B1 settle', () => chat.settle(600_000));
}

/** The server restarts while people keep talking. */
async function b2(ctx) {
  const chat = new Chat(ctx, 'B2');
  const people = Array.from({ length: 5 }, (_, n) => chat.person(`sender${n}`));
  const talking = Promise.all(
    people.map(async (person, n) => {
      const sends = [];
      for (let m = 0; m < 10; m++) {
        sends.push(person.say(`B2 message ${m} from sender ${n}`));
        await sleep(1000);
      }
      await Promise.all(sends);
    }),
  );
  await sleep(3000);
  await timed(ctx, 'B2 server restart', async () => {
    await ctx.server.stop('SIGTERM');
    await sleep(5000);
    await ctx.server.start();
  });
  await talking;
  return timed(ctx, 'B2 settle', () => chat.settle(180_000));
}

/** The listening node's connection dies without a close, and the chat has to come back. */
async function b3(ctx) {
  const chat = new Chat(ctx, 'B3');
  const person = chat.person('sender');
  await Promise.all([1, 2, 3].map((m) => person.say(`B3 message ${m} before the cut`)));
  await timed(ctx, 'B3 listener restart unheard', () => ctx.cluster.restartUnheard('queen'));
  const after = [];
  for (let m = 1; m <= 5; m++) {
    after.push(person.say(`B3 message ${m} after the cut`));
    await sleep(2000);
  }
  await Promise.all(after);
  return timed(ctx, 'B3 settle', () => chat.settle(180_000));
}

/** A malformed payload and a forged one, then ordinary messages. */
async function b4(ctx) {
  const chat = new Chat(ctx, 'B4');
  const person = chat.person('sender');
  const forger = chat.person('forger');
  await person.sendMalformed();
  await forger.sendForged('B4 forged');
  for (let m = 1; m <= 3; m++) await person.say(`B4 message ${m} after the bad ones`);
  return timed(ctx, 'B4 settle', () => chat.settle(120_000));
}

export const SCENARIOS = { B1: b1, B2: b2, B3: b3, B4: b4 };
