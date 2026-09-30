import { randomInt } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { docker, ownContainerId, saveContainerLog } from './docker.mjs';

export const BED_LABEL = 'swarm-chat-live-bed';

/** The box brings back every test-results folder of a run as that run's artifact. */
export const RESULTS_DIR = 'test-results';

/**
 * fdp-play 3.3.0's local chain and the node settings its CLI hands every Bee
 * (src/utils/docker.ts, createBeeEnvParameters). The contract addresses are fixed by its chain image.
 * Its queen and worker images add only a data folder to a Bee image, holding the keys of the accounts its
 * chain funded, so another Bee release runs as fdp-play's node once its program replaces the image's own.
 */
const FDP_PLAY = {
  imageTag: '2.6.0',
  queenImage: 'fairdatasociety/fdp-play-queen',
  workerImage: 'fairdatasociety/fdp-play-worker-1',
  thirdImage: 'fairdatasociety/fdp-play-worker-2',
  chainImage: 'fairdatasociety/fdp-play-blockchain',
  chainVersionLabels: ['org.ethswarm.beefactory.blockchain-version', 'org.fairdatasociety.fdp-play.blockchain-version'],
  chainArgs: [
    '--allow-insecure-unlock',
    '--unlock=0xCEeE442a149784faa65C35e328CCd64d874F9a02',
    '--password=/root/password',
    '--mine',
    '--miner.etherbase=0xCEeE442a149784faa65C35e328CCd64d874F9a02',
    '--http',
    '--http.api=debug,web3,eth,txpool,net,personal',
    '--http.corsdomain=*',
    '--http.port=9545',
    '--http.addr=0.0.0.0',
    '--http.vhosts=*',
    '--maxpeers=0',
    '--networkid=4020',
    '--authrpc.vhosts=*',
    '--authrpc.addr=0.0.0.0',
  ],
  beeOptions: (chainHost) => ({
    'warmup-time': '10s',
    'debug-api-enable': 'true',
    // Trace, so the pusher's and pushsync's path shows in the kept logs. fdp-play itself runs at 4, debug.
    verbosity: '5',
    'swap-enable': 'true',
    mainnet: 'false',
    'swap-endpoint': `http://${chainHost}:9545`,
    'blockchain-rpc-endpoint': `http://${chainHost}:9545`,
    'swap-factory-address': '0xCfEB869F69431e42cdB54A4F4f105C19C080A601',
    password: 'password',
    'postage-stamp-address': '0x254dffcd3277C0b1660F6d42EFbB754edaBAbC2B',
    'price-oracle-address': '0x5b1869D9A4C187F2EAa108f3062412ecf0526b24',
    'redistribution-address': '0x9561C133DD8580860B6b7E504bC5Aa500f0f06a7',
    'staking-address': '0xD833215cBcc3f914bD1C9ece3EE7BF8B14f841bb',
    'postage-stamp-start-block': '1',
    'network-id': '4020',
    'full-node': 'true',
    'api-addr': '0.0.0.0:1633',
    'cors-allowed-origins': '*',
    'allow-private-cidrs': 'true',
    // Bee 2.8 no longer looks the token up from the postage contract on a chain it does not know, and refuses
    // to start without it. fdp-play's own node settings predate that, so the address comes from its
    // orchestrator/contract-addresses.json at 3.3.0. Bee 2.6 has no such option and ignores the variable.
    'bzz-token-address': '0xe78A0F7E598Cc8b0Bb87894B0F60dD2a88d6a8Ab',
  }),
};

/** Where both Bee's own Dockerfile and its release Dockerfile put the program, 2.6 to 2.8. */
const BEE_PROGRAM = '/usr/local/bin/bee';
export const BEE_ROLES = ['queen', 'worker', 'third'];
const BEE_API_PORT = 1633;
/** Bee's own default block time, which fdp-play leaves unset. */
const BLOCK_SECONDS = 5;
const CHAIN_RPC_PORT = 9545;

function beeEnv(options) {
  return Object.entries(options).flatMap(([key, value]) => [
    '-e',
    `BEE_${key.toUpperCase().replace(/-/g, '_')}=${value}`,
  ]);
}

/** Thrown by a probe when what it waits for can no longer happen, such as a container that exited. */
export class WaitAbandoned extends Error {
  constructor(message) {
    super(message);
    this.name = 'WaitAbandoned';
  }
}

/** Polls `probe` until it returns something truthy. An ordinary error is retried, a WaitAbandoned ends the wait. */
export async function waitFor(what, probe, { timeoutMs, intervalMs = 2000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      if (error instanceof WaitAbandoned) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${lastError ? `: ${lastError.message}` : ''}`);
}

export async function httpJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${url} answered ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function chainVersionOf(image) {
  const labels = JSON.parse(docker(['image', 'inspect', image, '--format', '{{json .Config.Labels}}']).stdout) ?? {};
  const key = FDP_PLAY.chainVersionLabels.find((label) => labels[label]);
  return key ? labels[key] : 'latest';
}

/**
 * Bee releases the bed builds from source rather than taking the published image. A released Bee never counts itself
 * reachable on a private network, so pushsync never stores a pushed chunk (pushsync.go:302) and every push loops between
 * the nodes until its allowance runs out. REACHABILITY_OVERRIDE_PUBLIC=true, a value compiled in, makes it count
 * itself reachable. It is the setting fdp-play builds its own local-cluster images with since November 2025, and no
 * published image carries it. The source is pinned by commit and the Go image by digest.
 */
export const BEE_BUILDS = {
  '2.8.2': { tag: 'v2.8.2', commit: '7e703f495c929eecde5155734760b5611ad4fd0f' },
};
/** Said at the start of every run that uses a built Bee, so no reader takes it for the released binary. */
export function beeBuildNote(beeVersion) {
  const build = BEE_BUILDS[beeVersion];
  return build
    ? `Bee ${beeVersion} here is ${build.tag} at ${build.commit.slice(0, 8)} built from source with ` +
        'REACHABILITY_OVERRIDE_PUBLIC=true, the setting fdp-play uses for local clusters, because a released Bee never ' +
        'counts itself reachable on a private network and so never stores a pushed chunk. It is not the released binary.'
    : `Bee ${beeVersion} here is the released image.`;
}
const GO_IMAGE = 'golang:1.26@sha256:6c2a5538f964f1c82f97ad14988bf05de100d922d159d0e398b54c7b0ca0c6c9';
const BUILT_BEE = '/src/dist/bee';
const builtBeeImages = new Map();

/** The image holding a Bee binary built with the reachability override, built once per version and run. */
function builtBeeImage(beeVersion, report) {
  if (builtBeeImages.has(beeVersion)) return builtBeeImages.get(beeVersion);
  const { tag, commit } = BEE_BUILDS[beeVersion];
  const image = `swarm-chat-bed-bee-build:${beeVersion}`;
  const context = mkdtempSync(join(tmpdir(), 'swarm-chat-bed-bee-'));
  writeFileSync(
    join(context, 'Dockerfile'),
    `FROM ${GO_IMAGE}\n` +
      `RUN git clone --depth 1 --branch ${tag} https://github.com/ethersphere/bee.git /src && \\\n` +
      `    head="$(git -C /src rev-parse HEAD)" && \\\n` +
      `    if [ "$head" != "${commit}" ]; then echo "bee ${tag} is $head, expected ${commit}" >&2; exit 1; fi\n` +
      'WORKDIR /src\n' +
      'RUN make binary REACHABILITY_OVERRIDE_PUBLIC=true\n',
  );
  const started = Date.now();
  docker(['build', '--label', BED_LABEL, '-t', image, context]);
  const built = docker(['run', '--rm', '--entrypoint', BUILT_BEE, image, 'version']);
  report(
    `built Bee ${tag} at ${commit.slice(0, 8)} with REACHABILITY_OVERRIDE_PUBLIC=true in ${Date.now() - started} ms, ` +
      `version ${`${built.stdout} ${built.stderr}`.trim()}`,
  );
  builtBeeImages.set(beeVersion, image);
  return image;
}

/**
 * fdp-play's own image for that role, with its Bee program swapped for the requested release: the published image of
 * that release, or a binary built from source for a release in BEE_BUILDS.
 */
function beeImageFor(beeVersion, role, report) {
  const images = { queen: FDP_PLAY.queenImage, worker: FDP_PLAY.workerImage, third: FDP_PLAY.thirdImage };
  const fdpPlayImage = `${images[role]}:${FDP_PLAY.imageTag}`;
  if (beeVersion === FDP_PLAY.imageTag) return fdpPlayImage;

  const [release, program] = BEE_BUILDS[beeVersion]
    ? [builtBeeImage(beeVersion, report), BUILT_BEE]
    : [`ethersphere/bee:${beeVersion}`, BEE_PROGRAM];
  const tag = `swarm-chat-bed-${role}:${beeVersion}`;
  const context = mkdtempSync(join(tmpdir(), 'swarm-chat-bed-'));
  writeFileSync(
    join(context, 'Dockerfile'),
    `FROM ${release} AS release\n` + `FROM ${fdpPlayImage}\n` + `COPY --from=release ${program} ${BEE_PROGRAM}\n`,
  );
  docker(['build', '--label', BED_LABEL, '-t', tag, context]);
  return tag;
}

export function removeLeftovers() {
  const filter = ['--filter', `label=${BED_LABEL}`];
  const containers = docker(['container', 'ls', '-aq', ...filter])
    .stdout.split('\n')
    .filter(Boolean);
  if (containers.length) docker(['container', 'rm', '-f', ...containers]);
  const self = ownContainerId();
  for (const network of docker(['network', 'ls', '-q', ...filter])
    .stdout.split('\n')
    .filter(Boolean)) {
    if (self) docker(['network', 'disconnect', '-f', network, self], { allowFailure: true });
    docker(['network', 'rm', network], { allowFailure: true });
  }
}

/**
 * A chain and two full Bee nodes on a network of their own, which this process joins so the nodes answer by
 * container name. A node keeps its data in its container's own layer: no test recreates a node container,
 * and a bind mount would name a path on the daemon's filesystem rather than this container's.
 */
export class Cluster {
  constructor({ beeVersion, runId, log, observe = log }) {
    this.beeVersion = beeVersion;
    this.runId = runId;
    this.log = log;
    this.observe = observe;
    this.network = `bed-${runId}`;
    this.names = {
      chain: `bed-${runId}-chain`,
      queen: `bed-${runId}-queen`,
      worker: `bed-${runId}-worker`,
      third: `bed-${runId}-third`,
    };
    this.self = null;
  }

  /** A line for both the log and the observations. */
  report = (line) => {
    this.log(line);
    this.observe(line);
  };

  url(role) {
    return `http://${this.names[role]}:${BEE_API_PORT}`;
  }

  labels() {
    return ['--label', BED_LABEL, '--label', `${BED_LABEL}.run=${this.runId}`];
  }

  async start() {
    this.self = ownContainerId();
    if (!this.self) {
      throw new Error(
        'this process is not in a container the docker daemon knows, so it cannot join the cluster network. ' +
          'The bed runs in the verification box Docker class, where the job is a sibling of the nodes.',
      );
    }

    this.createNetwork();
    docker(['network', 'connect', this.network, this.self]);

    const fdpPlayQueen = `${FDP_PLAY.queenImage}:${FDP_PLAY.imageTag}`;
    docker(['pull', fdpPlayQueen]);
    const chainImage = `${FDP_PLAY.chainImage}:${chainVersionOf(fdpPlayQueen)}`;
    this.log(`chain image ${chainImage}`);
    docker([
      'run',
      '-d',
      ...this.labels(),
      '--network',
      this.network,
      '--name',
      this.names.chain,
      chainImage,
      ...FDP_PLAY.chainArgs,
    ]);
    await waitFor('the chain RPC', () => this.chainBlockNumber(), { timeoutMs: 120_000 });

    const options = FDP_PLAY.beeOptions(this.names.chain);

    this.runBee('queen', beeImageFor(this.beeVersion, 'queen', this.report), { ...options, 'bootnode-mode': 'false' });
    await this.waitHealthy('queen');
    const underlay = await this.underlayOf('queen');
    this.runBee('worker', beeImageFor(this.beeVersion, 'worker', this.report), { ...options, bootnode: underlay });
    await this.waitHealthy('worker');
    await this.waitPeered();
    // The third node joins once the other two have started. Bee 2.6's NewBee closes its warm-up detector on return,
    // which drops a peer event from during start-up, so a node whose only peer arrived then never warms up. The third
    // node's arrival is a peer event after start-up on both. It is also a second peer for each node's health service.
    this.runBee('third', beeImageFor(this.beeVersion, 'third', this.report), { ...options, bootnode: underlay });
    await this.waitHealthy('third');
    await waitFor(
      'the queen to see both other nodes',
      async () => (await httpJson(`${this.url('queen')}/peers`)).peers.length >= 2,
      { timeoutMs: 180_000 },
    );
    for (const role of BEE_ROLES) await this.waitWarmedUp(role);
  }

  /**
   * Bee refuses to push a chunk until its warm-up has finished (pushsync's pushToClosest returns ErrWarmup), and a
   * direct write such as a GSOC send then waits on that push. So nothing is sent before /status says warmed up.
   */
  async waitWarmedUp(role) {
    const started = Date.now();
    const status = await waitFor(
      `${role} to finish warming up`,
      async () => {
        const body = await httpJson(`${this.url(role)}/status`, { timeoutMs: 5000 });
        return body.isWarmingUp === false || body.isWarmingUp === undefined ? body : null;
      },
      { timeoutMs: 600_000 },
    );
    const reported = status.isWarmingUp === undefined ? ', its /status has no isWarmingUp' : '';
    this.log(`${role} warmed up after ${Date.now() - started} ms${reported}`);
  }

  /**
   * A network with a subnet of its own, because only such a network lets a container keep its address across a
   * disconnect, and the worker and the server find the queen again only at the address they knew.
   */
  createNetwork() {
    for (let attempt = 0; attempt < 8; attempt++) {
      const prefix = `10.${200 + randomInt(50)}.${randomInt(256)}`;
      const created = docker(['network', 'create', ...this.labels(), '--subnet', `${prefix}.0/24`, this.network], {
        allowFailure: true,
      });
      if (created.status === 0) {
        this.addresses = { queen: `${prefix}.10`, worker: `${prefix}.11`, third: `${prefix}.12` };
        return;
      }
      if (!/overlap/i.test(created.stderr)) throw new Error(`docker network create failed: ${created.stderr}`);
    }
    throw new Error('every subnet tried for the cluster network overlapped one the daemon already has');
  }

  runBee(role, image, options) {
    docker([
      'run',
      '-d',
      ...this.labels(),
      '--network',
      this.network,
      '--ip',
      this.addresses[role],
      '--name',
      this.names[role],
      ...beeEnv(options),
      image,
      'start',
    ]);
  }

  /**
   * Ends a node's connections without a close reaching the other side: the node leaves the network, stops while
   * nothing can hear it, and comes back at the same address. A client of its API is left holding a socket that
   * looks open and never carries anything again, which is what a gateway restart does to a listener.
   */
  async restartUnheard(role) {
    docker(['network', 'disconnect', '-f', this.network, this.names[role]]);
    docker(['container', 'stop', '-t', '10', this.names[role]]);
    docker(['network', 'connect', '--ip', this.addresses[role], this.network, this.names[role]]);
    docker(['container', 'start', this.names[role]]);
    await this.waitHealthy(role);
    await this.waitPeered();
    await this.waitWarmedUp(role);
  }

  async waitPeered() {
    await waitFor(
      'the queen and the worker to be peers',
      async () => (await httpJson(`${this.url('queen')}/peers`)).peers.length > 0,
      { timeoutMs: 180_000 },
    );
  }

  /**
   * A stamp bought on one node, the worker unless named, sized from the chain's current price to last `days`, once it
   * is usable. Only the node that bought a stamp can stamp with it, since its issuer state lives there.
   */
  async buyStamp({ role = 'worker', depth = 20, days = 7 } = {}) {
    const url = this.url(role);
    const { currentPrice } = await httpJson(`${url}/chainstate`);
    const amount = BigInt(currentPrice) * BigInt((days * 86_400) / BLOCK_SECONDS) + 1n;
    this.log(`stamp: price ${currentPrice} per block, amount ${amount}, depth ${depth}`);
    const { batchID } = await httpJson(`${url}/stamps/${amount}/${depth}`, { method: 'POST', timeoutMs: 180_000 });
    await waitFor('the stamp to become usable', async () => (await httpJson(`${url}/stamps/${batchID}`)).usable, {
      timeoutMs: 300_000,
    });
    return batchID;
  }

  async chainBlockNumber() {
    const answer = await httpJson(`http://${this.names.chain}:${CHAIN_RPC_PORT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      timeoutMs: 5000,
    });
    return parseInt(answer.result, 16) >= 0;
  }

  async waitHealthy(role) {
    const alive = () =>
      docker(['container', 'inspect', '-f', '{{.State.Running}}', this.names[role]]).stdout === 'true';
    await waitFor(
      `${role} to become ready`,
      async () => {
        if (!alive()) {
          throw new WaitAbandoned(`${role} container exited. Its last log lines:\n${this.containerLogs(role)}`);
        }
        const response = await fetch(`${this.url(role)}/readiness`, { signal: AbortSignal.timeout(5000) });
        return response.ok;
      },
      { timeoutMs: 300_000 },
    );
  }

  async underlayOf(role) {
    const { underlay } = await httpJson(`${this.url(role)}/addresses`);
    const address = underlay.find((entry) => entry.startsWith('/ip4/') && !entry.startsWith('/ip4/127.'));
    if (!address) throw new Error(`${role} advertised no reachable ip4 underlay: ${underlay.join(' ')}`);
    return address;
  }

  /**
   * Writes each container's whole log, and each node's status and topology, into a folder under test-results,
   * and returns that folder. Called before the cluster is removed, whether the run passed or not.
   */
  async saveDiagnostics(label) {
    const dir = join(RESULTS_DIR, `${label}-${this.runId}`);
    mkdirSync(dir, { recursive: true });
    for (const [role, name] of Object.entries(this.names)) saveContainerLog(name, join(dir, `${role}.log`));
    for (const role of BEE_ROLES) {
      for (const endpoint of ['status', 'status/peers', 'topology']) {
        let body;
        try {
          body = JSON.stringify(await httpJson(`${this.url(role)}/${endpoint}`, { timeoutMs: 10_000 }), null, 2);
        } catch (error) {
          body = `could not be read: ${error.message}`;
        }
        writeFileSync(join(dir, `${role}-${endpoint.replace('/', '-')}.json`), `${body}\n`);
      }
    }
    return dir;
  }

  containerLogs(role, tail = 80) {
    const result = docker(['logs', '--tail', String(tail), this.names[role]], { allowFailure: true });
    return `${result.stdout}\n${result.stderr}`.trim();
  }

  stop() {
    const containers = Object.values(this.names);
    docker(['container', 'rm', '-f', ...containers], { allowFailure: true });
    if (this.self) docker(['network', 'disconnect', '-f', this.network, this.self], { allowFailure: true });
    docker(['network', 'rm', this.network], { allowFailure: true });
  }
}
