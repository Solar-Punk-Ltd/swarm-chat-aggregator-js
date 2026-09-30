// Spike: does a given Bee release run on fdp-play's local chain with fdp-play's node settings?
// For each version it starts the chain and two full nodes, buys a stamp, and sends one GSOC message
// through the worker to a listener on the queen. Correctness is asserted, timings are only printed.
import { randomBytes } from 'node:crypto';

import { Bee, Bytes, FeedIndex, Identifier, Topic } from '@ethersphere/bee-js';

import { BEE_ROLES, beeBuildNote, Cluster, httpJson, removeLeftovers } from './cluster.mjs';
import { randomKey } from './payloads.mjs';

const BEE_VERSIONS = (process.env.BED_BEE_VERSIONS ?? '2.8.2,2.6.0').split(',').map((v) => v.trim());
/**
 * The versions this run expects to fail. 2.6.0 runs as the released image, which never stores a pushed chunk on a
 * private network, so it is the control that shows the failure the built 2.8.2 arm exists to get past.
 */
const EXPECTED_FAILURES = new Set(
  (process.env.BED_SPIKE_EXPECT_FAIL ?? '2.6.0')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
);

const observations = [];
const log = (line) => console.log(`[bed] ${line}`);

async function timed(label, step) {
  const started = Date.now();
  const value = await step();
  observations.push(`${label}: ${Date.now() - started} ms`);
  return value;
}

/**
 * One GSOC message on a subscription. A close or an error after cancel() is the cancel itself, not a failure, and the
 * promise is marked handled, because a send that throws first leaves nobody awaiting it.
 */
function receiveOne(bee, address, identifier) {
  let subscription;
  let cancelled = false;
  const received = new Promise((resolve, reject) => {
    subscription = bee.messaging.gsocSubscribe(address, identifier, {
      onMessage: (message) => resolve(message.toUtf8()),
      onError: (error) => {
        if (!cancelled) reject(error);
      },
      onClose: () => {
        if (!cancelled) reject(new Error('the GSOC subscription closed before a message arrived'));
      },
    });
  });
  received.catch(() => {});
  return {
    received,
    cancel: () => {
      cancelled = true;
      subscription.cancel();
    },
  };
}

const CONTROL_TIMEOUT_MS = 60_000;

/**
 * Runs `call` with the global fetch, which bee-js uses, wrapped so each raw reply is recorded from a clone: status,
 * content type and encoding, length, and the first bytes in hex. It shows what bee-js was handed when it fails to
 * read a reply.
 */
async function withRawReplies(label, call) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await original(url, init);
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    const header = (name) => response.headers.get(name) ?? '-';
    observations.push(
      `${label}, raw reply to ${init?.method ?? 'GET'} ${new URL(url).pathname.slice(0, 40)}: ${response.status}` +
        ` type ${header('content-type')} encoding ${header('content-encoding')} length ${bytes.length}` +
        ` first bytes ${Buffer.from(bytes.slice(0, 48)).toString('hex')}`,
    );
    return response;
  };
  try {
    return await call();
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * An upload result with its bee-js byte values, such as the Reference, written as hex. Their toJSON parses the bytes
 * as JSON, and JSON.stringify calls toJSON before any replacer, so a plain stringify of the result throws.
 */
function withBytesAsHex(result) {
  if (!result || typeof result !== 'object') return result ?? null;
  return Object.fromEntries(
    Object.entries(result).map(([key, value]) => [key, typeof value?.toHex === 'function' ? value.toHex() : value]),
  );
}

/** Runs one write and records its outcome, duration and raw replies under observations. It never throws. */
async function control(beeVersion, label, write) {
  const answer = await answerOf(async () => {
    const result = await withRawReplies(`Bee ${beeVersion} control, ${label}`, write);
    return { status: 'answered', text: JSON.stringify(withBytesAsHex(result)) };
  });
  observations.push(`Bee ${beeVersion} control, ${label}: ${answer}`);
}

/** Status fields that decide whether a node can push, as the node itself and its peers report them. */
const STATUS_FIELDS = ['beeMode', 'isWarmingUp', 'isReachable', 'connectedPeers', 'storageRadius', 'committedDepth'];

/**
 * What each node says about itself and about its peers, recorded before the send. /status/peers asks every connected
 * peer for its status the way Bee's salud does, and salud publishing a network radius is what a push waits on.
 */
async function recordNodeViews(cluster, beeVersion) {
  const pick = (status) => Object.fromEntries(STATUS_FIELDS.map((field) => [field, status?.[field]]));
  for (const role of BEE_ROLES) {
    for (const [label, read] of [
      ['/status', async () => pick(await httpJson(`${cluster.url(role)}/status`))],
      [
        '/status/peers',
        async () =>
          ((await httpJson(`${cluster.url(role)}/status/peers`)).snapshots ?? []).map((peer) => ({
            overlay: peer.overlay?.slice(0, 8),
            requestFailed: peer.requestFailed ?? false,
            ...pick(peer),
          })),
      ],
    ]) {
      const answer = await answerOf(async () => ({ status: 'answered', text: JSON.stringify(await read()) }));
      observations.push(`Bee ${beeVersion} ${role} ${label} before the send: ${answer}`);
    }
  }
}

/**
 * Two writes before the GSOC send, to tell a push that never leaves the worker apart from something in SOC or GSOC: a
 * direct POST /bytes through the worker, which needs a push and no SOC, and a /soc write on the queen with the queen's
 * own stamp, which is a SOC that needs no push to another node.
 */
async function runControls(cluster, beeVersion, workerStamp, queenStamp, key) {
  await control(beeVersion, 'direct POST /bytes through the worker', () =>
    httpJson(`${cluster.url('worker')}/bytes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'swarm-postage-batch-id': workerStamp,
        'swarm-deferred-upload': 'false',
      },
      body: randomBytes(64),
      timeoutMs: CONTROL_TIMEOUT_MS,
    }),
  );
  await control(beeVersion, '/soc write on the queen with its own stamp', () =>
    new Bee(cluster.url('queen')).messaging.gsocSend(
      queenStamp,
      key,
      Identifier.fromString(`bed-control-${cluster.runId}`),
      `control ${randomBytes(8).toString('hex')}`,
      undefined,
      { signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS) },
    ),
  );
}

const BUCKET_PROBE_DEPTH = 17;
const BUCKET_PROBE_WRITES = 5;

/**
 * Writes BUCKET_PROBE_WRITES different payloads to one GSOC address through the worker, once with an immutable batch
 * and once with a mutable one, both at the smallest depth, and records each answer. A GSOC address is one chunk
 * address, so every write lands in one stamp bucket, which holds 2^(depth - 16) stamps: 2 here. Nothing is asserted.
 */
async function bucketProbe(cluster, beeVersion) {
  const listener = new Bee(cluster.url('queen'));
  const sender = new Bee(cluster.url('worker'));
  const { overlay } = await httpJson(`${cluster.url('queen')}/addresses`);
  const identifier = Identifier.fromString(`bed-bucket-${cluster.runId}`);
  const key = listener.messaging.gsocMine(overlay, identifier);
  for (const immutable of [true, false]) {
    const stamp = await cluster.buyStamp({ depth: BUCKET_PROBE_DEPTH, immutable });
    const answers = [];
    for (let write = 1; write <= BUCKET_PROBE_WRITES; write++) {
      answers.push(
        `${write}: ${await answerOf(async () => {
          const result = await sender.messaging.gsocSend(
            stamp,
            key,
            identifier,
            `bucket ${immutable} ${write}`,
            undefined,
            {
              signal: AbortSignal.timeout(30_000),
            },
          );
          return { status: 'answered', text: result.reference.toHex().slice(0, 8) };
        })}`,
      );
    }
    observations.push(
      `Bee ${beeVersion} one GSOC address, ${BUCKET_PROBE_WRITES} different payloads, depth ${BUCKET_PROBE_DEPTH} ` +
        `${immutable ? 'immutable' : 'mutable'} batch: ${answers.join('; ')}`,
    );
  }
}

async function gsocRoundTrip(cluster, beeVersion, batchId, queenStamp) {
  const listener = new Bee(cluster.url('queen'));
  const sender = new Bee(cluster.url('worker'));
  const { overlay } = await httpJson(`${cluster.url('queen')}/addresses`);
  const identifier = Identifier.fromString(`bed-spike-${cluster.runId}`);
  const key = await timed('mine the GSOC key', () => listener.messaging.gsocMine(overlay, identifier));
  await recordNodeViews(cluster, beeVersion);
  await runControls(cluster, beeVersion, batchId, queenStamp, key);

  const { received, cancel } = receiveOne(listener, key.publicKey().address(), identifier);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const payload = `spike ${randomBytes(8).toString('hex')}`;
  try {
    await withRawReplies(`Bee ${beeVersion} GSOC send through the worker`, () =>
      sender.messaging.gsocSend(batchId, key, identifier, payload, undefined, {
        signal: AbortSignal.timeout(30_000),
      }),
    );
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
  const cluster = new Cluster({ beeVersion, runId, log, observe: (line) => observations.push(line) });
  log(`=== Bee ${beeVersion}, run ${runId}`);
  log(beeBuildNote(beeVersion));
  try {
    await timed(`${beeVersion} cluster up`, () => cluster.start());
    for (const role of ['queen', 'worker']) {
      const { version, apiVersion } = await httpJson(`${cluster.url(role)}/health`);
      log(`${role} reports version ${version}, API ${apiVersion}`);
    }
    await probeAbsentSlot(cluster, beeVersion);
    const batchId = await timed(`${beeVersion} stamp usable`, () => cluster.buyStamp());
    const queenStamp = await timed(`${beeVersion} queen stamp usable`, () => cluster.buyStamp({ role: 'queen' }));
    await gsocRoundTrip(cluster, beeVersion, batchId, queenStamp);
    await bucketProbe(cluster, beeVersion);
    log(`PASS Bee ${beeVersion}: started on fdp-play's chain, bought a stamp, delivered a GSOC message`);
    return true;
  } catch (error) {
    log(`FAIL Bee ${beeVersion}: ${error.stack ?? error}`);
    for (const role of [...BEE_ROLES, 'chain']) log(`--- last log lines of ${role}\n${cluster.containerLogs(role)}`);
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
for (const version of BEE_VERSIONS) console.log(`[bed]   ${beeBuildNote(version)}`);
const unexpected = [];
for (const [version, passed] of Object.entries(results)) {
  const expectedToFail = EXPECTED_FAILURES.has(version);
  console.log(`[bed]   Bee ${version}: ${passed ? 'PASS' : 'FAIL'}${expectedToFail ? ', expected to fail' : ''}`);
  if (passed === expectedToFail) unexpected.push(version);
}
if (unexpected.length) console.log(`[bed]   not as this run expected: Bee ${unexpected.join(', ')}`);
else console.log('[bed]   every version did what this run expected');
process.exit(unexpected.length ? 1 : 0);
