// The live chat bed: a Bee cluster on a local test chain, the chat server as a child process, and B1 to B4.
//
//   node test/live/bed.mjs [--server event|master] [--format v7|v6] [--expect-fail B2,B3,B4] [--only B1,B4]
//
// Strict by default: every scenario must pass. --expect-fail names the scenarios a baseline run exists to see
// fail, and the run then passes only when exactly those fail. Timings are printed and never asserted.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { Bee, Identifier } from '@ethersphere/bee-js';

import { Cluster, httpJson, removeLeftovers } from './cluster.mjs';
import { PayloadFormat, randomKey } from './payloads.mjs';
import { SCENARIOS } from './scenarios.mjs';
import { ServerKind, ServerProcess } from './server.mjs';

const { values: args } = parseArgs({
  options: {
    server: { type: 'string', default: ServerKind.EVENT },
    format: { type: 'string', default: PayloadFormat.V7 },
    'expect-fail': { type: 'string', default: '' },
    only: { type: 'string', default: Object.keys(SCENARIOS).join(',') },
    bee: { type: 'string', default: '2.8.2' },
    'resend-interval-ms': { type: 'string', default: '10000' },
    'resend-attempts': { type: 'string', default: '5' },
  },
});

const listOf = (value) =>
  value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
const scenarioNames = listOf(args.only);
const expectedFailures = new Set(listOf(args['expect-fail']));
for (const name of [...scenarioNames, ...expectedFailures]) {
  if (!SCENARIOS[name])
    throw new Error(`unknown scenario ${name}, expected one of ${Object.keys(SCENARIOS).join(', ')}`);
}

const observations = [];
const log = (line) => console.log(`[bed] ${line}`);
const observe = (line) => observations.push(line);

const runId = randomBytes(4).toString('hex');
const cluster = new Cluster({ beeVersion: args.bee, runId, log });
let server;
const results = {};

log(`run ${runId}: server ${args.server}, format ${args.format}, Bee ${args.bee}`);
log(`expected to fail: ${expectedFailures.size ? [...expectedFailures].join(', ') : 'none'}`);

removeLeftovers();
try {
  await cluster.start();
  const senderStamp = await cluster.buyStamp();
  const serverStamp = await cluster.buyStamp();

  const gsocIdentifier = `bed-chat-${runId}`;
  const { overlay } = await httpJson(`${cluster.url('queen')}/addresses`);
  const gsocKey = new Bee(cluster.url('queen')).messaging.gsocMine(overlay, Identifier.fromString(gsocIdentifier));
  const feedKey = randomKey();

  server = new ServerProcess({
    kind: args.server,
    log,
    settings: {
      listenUrl: cluster.url('queen'),
      writeUrl: cluster.url('worker'),
      gsocKey: gsocKey.toHex(),
      gsocIdentifier,
      feedKey: feedKey.toHex(),
      writeStamp: serverStamp,
      heartbeatStamp: serverStamp,
      chatTopicPattern: 'chat-bed-.*',
      port: 3000 + (parseInt(runId.slice(0, 4), 16) % 1000),
    },
  });
  await server.start();

  const ctx = {
    cluster,
    server,
    format: args.format,
    runId,
    senderStamp,
    gsocKey,
    gsocIdentifier,
    feedOwner: feedKey.publicKey().address(),
    resend: { intervalMs: Number(args['resend-interval-ms']), attempts: Number(args['resend-attempts']) },
    log,
    observe,
  };

  for (const name of scenarioNames) {
    log(`=== ${name}`);
    try {
      results[name] = await SCENARIOS[name](ctx);
    } catch (error) {
      results[name] = { passed: false, detail: `the scenario itself failed: ${error.stack ?? error}` };
    }
    log(`${name} ${results[name].passed ? 'PASS' : 'FAIL'}: ${results[name].detail}`);
  }
} catch (error) {
  log(`the bed could not run: ${error.stack ?? error}`);
  for (const role of ['queen', 'worker', 'chain']) log(`--- last log lines of ${role}\n${cluster.containerLogs(role)}`);
} finally {
  await server?.stop();
  if (server) log(`--- last log lines of the server\n${server.logTail()}`);
  const diagnostics = await cluster.saveDiagnostics('bed');
  server?.saveLog(join(diagnostics, 'server.log'));
  log(`diagnostics saved in ${diagnostics}`);
  cluster.stop();
}

console.log('\n[bed] observations, none of them asserted');
for (const line of observations) console.log(`[bed]   ${line}`);

const unexpected = [];
const expectedSeen = [];
for (const name of scenarioNames) {
  const result = results[name];
  if (!result) unexpected.push(`${name} did not run`);
  else if (expectedFailures.has(name) && !result.passed) expectedSeen.push(`${name}: ${result.detail}`);
  else if (expectedFailures.has(name)) unexpected.push(`${name} passed, and this run expected it to fail`);
  else if (!result.passed) unexpected.push(`${name} failed: ${result.detail}`);
}

if (expectedSeen.length) {
  console.log('\n[bed] failed as this run expected (--expect-fail)');
  for (const line of expectedSeen) console.log(`[bed]   ${line}`);
}
console.log('\n[bed] result');
if (unexpected.length) for (const line of unexpected) console.log(`[bed]   ${line}`);
else console.log(`[bed]   every scenario did what this run expected`);
process.exit(unexpected.length ? 1 : 0);
