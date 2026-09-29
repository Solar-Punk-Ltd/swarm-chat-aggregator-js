// Spike: does a given Bee release run on fdp-play's local chain with fdp-play's node settings?
// For each version it starts the chain and two full nodes, buys a stamp, and sends one GSOC message
// through the worker to a listener on the queen. Correctness is asserted, timings are only printed.
import { randomBytes } from 'node:crypto';

import { Bee, Bytes, FeedIndex, Identifier, Topic } from '@ethersphere/bee-js';

import { Cluster, httpJson, removeLeftovers } from './cluster.mjs';
import { randomKey } from './payloads.mjs';

const BEE_VERSIONS = (process.env.BED_BEE_VERSIONS ?? '2.8.2,2.6.0').split(',').map((v) => v.trim());

const observations = [];
const log = (line) => console.log(`[bed] ${line}`);

async function timed(label, step) {
  const started = Date.now();
  const value = await step();
  observations.push(`${label}: ${Date.now() - started} ms`);
  return value;
}

function receiveOne(bee, address, identifier) {
  let subscription;
  const received = new Promise((resolve, reject) => {
    subscription = bee.messaging.gsocSubscribe(address, identifier, {
      onMessage: (message) => resolve(message.toUtf8()),
      onError: (error) => reject(error),
      onClose: () => reject(new Error('the GSOC subscription closed before a message arrived')),
    });
  });
  return { received, cancel: () => subscription.cancel() };
}

async function gsocRoundTrip(cluster, batchId) {
  const listener = new Bee(cluster.url('queen'));
  const sender = new Bee(cluster.url('worker'));
  const { overlay } = await httpJson(`${cluster.url('queen')}/addresses`);
  const identifier = Identifier.fromString(`bed-spike-${cluster.runId}`);
  const key = await timed('mine the GSOC key', () => listener.messaging.gsocMine(overlay, identifier));

  const { received, cancel } = receiveOne(listener, key.publicKey().address(), identifier);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const payload = `spike ${randomBytes(8).toString('hex')}`;
  try {
    await sender.messaging.gsocSend(batchId, key, identifier, payload, undefined, {
      signal: AbortSignal.timeout(30_000),
    });
    const got = await timed('GSOC delivery', () =>
      Promise.race([
        received,
        new Promise((_, reject) => setTimeout(() => reject(new Error('no GSOC message within 60 s')), 60_000)),
      ]),
    );
    if (got !== payload)
      throw new Error(`the listener received ${JSON.stringify(got)}, expected ${JSON.stringify(payload)}`);
  } finally {
    cancel();
  }
}

const ABSENT_READ_TIMEOUT_MS = 60_000;
const ABSENT_REREAD_GAP_MS = 5000;

/** What one read answered: the HTTP status, or the error bee-js threw, and how long it took. */
async function answerOf(read) {
  const started = Date.now();
  try {
    const { status, text } = await read();
    return `${status} ${text.slice(0, 160).replace(/\s+/g, ' ')} (${Date.now() - started} ms)`;
  } catch (error) {
    const status = error?.status ?? error?.response?.status ?? 'no status';
    return `threw, status ${status}: ${String(error?.message ?? error).slice(0, 160)} (${Date.now() - started} ms)`;
  }
}

async function fetchAnswer(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(ABSENT_READ_TIMEOUT_MS) });
  return { status: response.status, text: await response.text() };
}

/**
 * Records what Bee answers for slot 0 of a feed nobody ever wrote, three ways, twice each, on both nodes. The event
 * server starts a new chat only after two 404s for slot 0, so a 500 here would leave a new chat unstarted. Nothing is
 * asserted.
 */
async function probeAbsentSlot(cluster, beeVersion) {
  const owner = randomKey().publicKey().address();
  const topic = Topic.fromString(`bed-absent-${cluster.runId}`);
  const identifier = new Identifier(
    Bytes.keccak256(Bytes.concat(topic.toUint8Array(), FeedIndex.fromBigInt(0n).toUint8Array())),
  );
  const reads = {
    'bee-js feed reader, index 0 (GET /chunks)': (url) => async () => {
      const reader = new Bee(url).feed.makeReader(topic, owner, {
        signal: AbortSignal.timeout(ABSENT_READ_TIMEOUT_MS),
      });
      const { payload } = await reader.downloadPayload({ index: FeedIndex.fromBigInt(0n) });
      return { status: 'answered', text: payload.toHex() };
    },
    'GET /soc/{owner}/{id}': (url) => () => fetchAnswer(`${url}/soc/${owner.toHex()}/${identifier.toHex()}`),
    'GET /feeds/{owner}/{topic}': (url) => () => fetchAnswer(`${url}/feeds/${owner.toHex()}/${topic.toHex()}`),
  };
  for (const role of ['worker', 'queen']) {
    for (const [way, readVia] of Object.entries(reads)) {
      for (const round of [1, 2]) {
        if (round === 2) await new Promise((resolve) => setTimeout(resolve, ABSENT_REREAD_GAP_MS));
        const answer = await answerOf(readVia(cluster.url(role)));
        observations.push(`Bee ${beeVersion} absent slot, ${role}, ${way}, read ${round}: ${answer}`);
      }
    }
  }
}

async function spike(beeVersion) {
  const runId = randomBytes(4).toString('hex');
  const cluster = new Cluster({ beeVersion, runId, log });
  log(`=== Bee ${beeVersion}, run ${runId}`);
  try {
    await timed(`${beeVersion} cluster up`, () => cluster.start());
    for (const role of ['queen', 'worker']) {
      const { version, apiVersion } = await httpJson(`${cluster.url(role)}/health`);
      log(`${role} reports version ${version}, API ${apiVersion}`);
    }
    await probeAbsentSlot(cluster, beeVersion);
    const batchId = await timed(`${beeVersion} stamp usable`, () => cluster.buyStamp());
    await gsocRoundTrip(cluster, batchId);
    log(`PASS Bee ${beeVersion}: started on fdp-play's chain, bought a stamp, delivered a GSOC message`);
    return true;
  } catch (error) {
    log(`FAIL Bee ${beeVersion}: ${error.stack ?? error}`);
    for (const role of ['queen', 'worker', 'chain'])
      log(`--- last log lines of ${role}\n${cluster.containerLogs(role)}`);
    return false;
  } finally {
    log(`diagnostics saved in ${await cluster.saveDiagnostics(`spike-${beeVersion}`)}`);
    cluster.stop();
  }
}

removeLeftovers();
const results = {};
for (const version of BEE_VERSIONS) results[version] = await spike(version);

console.log('\n[bed] observations, none of them asserted');
for (const line of observations) console.log(`[bed]   ${line}`);
console.log('\n[bed] result');
for (const [version, passed] of Object.entries(results))
  console.log(`[bed]   Bee ${version}: ${passed ? 'PASS' : 'FAIL'}`);
process.exit(Object.values(results).every(Boolean) ? 0 : 1);
