import { randomInt } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { docker, ownContainerId } from './docker.mjs';

export const BED_LABEL = 'swarm-chat-live-bed';

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
    verbosity: '4',
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

export async function waitFor(what, probe, { timeoutMs, intervalMs = 2000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
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

/** fdp-play's own image for that role, with its Bee program swapped for the requested release. */
function beeImageFor(beeVersion, role) {
  const fdpPlayImage = `${role === 'queen' ? FDP_PLAY.queenImage : FDP_PLAY.workerImage}:${FDP_PLAY.imageTag}`;
  if (beeVersion === FDP_PLAY.imageTag) return fdpPlayImage;

  const tag = `swarm-chat-bed-${role}:${beeVersion}`;
  const context = mkdtempSync(join(tmpdir(), 'swarm-chat-bed-'));
  writeFileSync(
    join(context, 'Dockerfile'),
    `FROM ethersphere/bee:${beeVersion} AS release\n` +
      `FROM ${fdpPlayImage}\n` +
      `COPY --from=release ${BEE_PROGRAM} ${BEE_PROGRAM}\n`,
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
  constructor({ beeVersion, runId, log }) {
    this.beeVersion = beeVersion;
    this.runId = runId;
    this.log = log;
    this.network = `bed-${runId}`;
    this.names = { chain: `bed-${runId}-chain`, queen: `bed-${runId}-queen`, worker: `bed-${runId}-worker` };
    this.self = null;
  }

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

    const images = { queen: beeImageFor(this.beeVersion, 'queen'), worker: beeImageFor(this.beeVersion, 'worker') };
    const options = FDP_PLAY.beeOptions(this.names.chain);

    this.runBee('queen', images.queen, { ...options, 'bootnode-mode': 'false' });
    await this.waitHealthy('queen');
    const underlay = await this.underlayOf('queen');
    this.runBee('worker', images.worker, { ...options, bootnode: underlay });
    await this.waitHealthy('worker');
    await this.waitPeered();
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
        this.addresses = { queen: `${prefix}.10`, worker: `${prefix}.11` };
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
  }

  async waitPeered() {
    await waitFor(
      'the queen and the worker to be peers',
      async () => (await httpJson(`${this.url('queen')}/peers`)).peers.length > 0,
      { timeoutMs: 180_000 },
    );
  }

  /** A stamp on the worker, sized from the chain's current price to last `days`, once it is usable. */
  async buyStamp({ depth = 20, days = 7 } = {}) {
    const url = this.url('worker');
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
        if (!alive()) throw new Error(`${role} container stopped`);
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
