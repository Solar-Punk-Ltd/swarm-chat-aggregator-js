import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { Bytes, FeedIndex, Topic } from '@ethersphere/bee-js';
import { WebSocket, WebSocketServer } from 'ws';

const SOC_HEADER_BYTES = 32 + 65;
const SPAN_BYTES = 8;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function socAddress(identifierHex: string, ownerHex: string): string {
  return Bytes.keccak256(Buffer.concat([Buffer.from(identifierHex, 'hex'), Buffer.from(ownerHex, 'hex')])).toHex();
}

export function feedSlotAddress(ownerHex: string, topic: Topic, index: number): string {
  const identifier = Bytes.keccak256(
    Buffer.concat([topic.toUint8Array(), FeedIndex.fromBigInt(BigInt(index)).toUint8Array()]),
  );
  return socAddress(identifier.toHex(), ownerHex);
}

/** What every fake node shares: the chunks and data it stores, and who listens on which GSOC address. */
export class FakeSwarm {
  readonly chunks = new Map<string, Uint8Array>();
  /** When each chunk was last stored, by address. */
  readonly storedAt = new Map<string, number>();
  readonly data = new Map<string, Uint8Array>();
  readonly nodes = new Set<FakeBeeNode>();

  /** Hands a GSOC payload to every subscriber of the address on any node except the one it was written through. */
  deliver(address: string, payload: Uint8Array, from: FakeBeeNode): void {
    for (const node of this.nodes) {
      if (node !== from) {
        node.deliver(address, payload);
      }
    }
  }

  /** The payload in a feed slot, as a reader would get it. */
  slotPayload(ownerHex: string, topic: string, index: number): Uint8Array | undefined {
    const chunk = this.chunks.get(feedSlotAddress(ownerHex, Topic.fromString(topic), index));
    return chunk?.slice(SOC_HEADER_BYTES + SPAN_BYTES);
  }

  /** Puts a chunk into a feed slot whose signature does not verify, which a reader refuses. */
  corruptSlot(ownerHex: string, topic: string, index: number): void {
    const address = feedSlotAddress(ownerHex, Topic.fromString(topic), index);
    const payload = new TextEncoder().encode('{"not":"signed"}');
    const span = Buffer.alloc(SPAN_BYTES);
    span.writeBigUInt64LE(BigInt(payload.length));
    this.chunks.set(address, Buffer.concat([Buffer.alloc(32, 7), Buffer.alloc(65, 9), span, payload]));
  }

  /** A chunk's payload, past its single owner chunk header and span. */
  payloadAt(address: string): Uint8Array | undefined {
    return this.chunks.get(address)?.slice(SOC_HEADER_BYTES + SPAN_BYTES);
  }

  slotJson(ownerHex: string, topic: string, index: number): unknown {
    const payload = this.slotPayload(ownerHex, topic, index);
    return payload && JSON.parse(new TextDecoder().decode(payload));
  }
}

type Faults = {
  /** What a read of a chunk nobody stored answers. Bee 2.6 answered 500 on /chunks for a slot never written. */
  absentStatus: number;
  /** The head lookup answers this status instead of looking, or stays behind the head by `staleBy` slots. */
  feedLookup: { status?: number; staleBy?: number };
  /** The next N reads of a chunk answer as absent although it is stored, by address, or for any address under `*`. */
  chunkMisses: Map<string, number>;
  readFailures: number;
  writeFailures: number;
  /** The next N SOC writes are stored and still answer 500, as a timeout after the write landed would. */
  writesLandThenFail: number;
  dataUploadFailures: number;
  dataUploadDelayMs: number;
  socWriteDelayMs: number;
  /** Extra delay for writes to one chunk address, so a later slot can land before an earlier one. */
  slowWrites: Map<string, number>;
  /** SOC writes to an address this answers true for are refused with a 500 and not stored. */
  refuseWrite: ((address: string) => boolean) | undefined;
  /** Subscriptions stay open and silent, as behind a proxy that dropped the connection. */
  gsocDeaf: boolean;
  /** Requests to these paths never answer. */
  hang: RegExp | undefined;
  ready: boolean;
  connectedPeers: number;
  /** /readiness and /topology answer this status instead. */
  statusFailure: number | undefined;
};

/** One fake Bee node over real HTTP and a real websocket, backed by a FakeSwarm. */
export class FakeBeeNode {
  readonly faults: Faults = {
    absentStatus: Number(process.env.FAKE_ABSENT_STATUS ?? 404),
    feedLookup: {},
    chunkMisses: new Map(),
    readFailures: 0,
    writeFailures: 0,
    writesLandThenFail: 0,
    dataUploadFailures: 0,
    dataUploadDelayMs: 0,
    socWriteDelayMs: 0,
    slowWrites: new Map(),
    refuseWrite: undefined,
    gsocDeaf: false,
    hang: undefined,
    ready: true,
    connectedPeers: 10,
    statusFailure: undefined,
  };
  readonly requests: string[] = [];
  /** Every SOC write's chunk address, in the order the writes arrived, refused ones included. */
  readonly socWriteAddresses: string[] = [];
  socWrites = 0;
  private readonly server: http.Server;
  private readonly sockets = new WebSocketServer({ noServer: true });
  private readonly subscribers = new Map<string, Set<WebSocket>>();

  private constructor(readonly swarm: FakeSwarm) {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.on('upgrade', (request, socket, head) => {
      const match = /^\/gsoc\/subscribe\/([0-9a-f]{64})$/.exec(request.url ?? '');
      if (!match) {
        socket.destroy();
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (ws) => {
        const address = match[1];
        const set = this.subscribers.get(address) ?? new Set();
        set.add(ws);
        this.subscribers.set(address, set);
        ws.on('close', () => set.delete(ws));
      });
    });
    swarm.nodes.add(this);
  }

  static async start(swarm: FakeSwarm): Promise<FakeBeeNode> {
    const node = new FakeBeeNode(swarm);
    await new Promise<void>((resolve) => node.server.listen(0, '127.0.0.1', resolve));
    return node;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  get subscriberCount(): number {
    return [...this.subscribers.values()].reduce((sum, set) => sum + set.size, 0);
  }

  deliver(address: string, payload: Uint8Array): void {
    if (this.faults.gsocDeaf) {
      return;
    }
    for (const ws of this.subscribers.get(address) ?? []) {
      ws.send(payload);
    }
  }

  /** Closes every subscription from the node's side, as a gateway restart does. */
  dropSubscriptions(): void {
    for (const set of this.subscribers.values()) {
      for (const ws of set) {
        ws.close();
      }
    }
  }

  async stop(): Promise<void> {
    this.swarm.nodes.delete(this);
    for (const client of this.sockets.clients) {
      client.terminate();
    }
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://fake');
    const body = await readBody(request);
    this.requests.push(`${request.method} ${url.pathname}`);
    if (this.faults.hang?.test(url.pathname)) {
      return;
    }
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      if (payload instanceof Uint8Array) {
        response.writeHead(status, { 'content-type': 'application/octet-stream', ...headers }).end(payload);
      } else {
        response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(payload));
      }
    };

    let match: RegExpExecArray | null;
    if (request.method === 'GET' && (match = /^\/chunks\/([0-9a-f]{64})$/.exec(url.pathname))) {
      if (this.faults.readFailures > 0) {
        this.faults.readFailures -= 1;
        return send(503, { message: 'service unavailable' });
      }
      const address = match[1];
      const absent = () => send(this.faults.absentStatus, { message: 'not found' });
      if (this.takeMiss(address)) {
        return absent();
      }
      const chunk = this.swarm.chunks.get(address);
      return chunk ? send(200, chunk) : absent();
    }

    if (request.method === 'GET' && (match = /^\/feeds\/([0-9a-f]{40})\/([0-9a-f]{64})$/.exec(url.pathname))) {
      if (this.faults.feedLookup.status) {
        return send(this.faults.feedLookup.status, { message: 'lookup failed' });
      }
      const [, owner, topicHex] = match;
      const topic = new Topic(topicHex);
      let latest = -1;
      while (this.swarm.chunks.has(feedSlotAddress(owner, topic, latest + 1))) {
        latest += 1;
      }
      const index = latest - (this.faults.feedLookup.staleBy ?? 0);
      if (index < 0) {
        return send(404, { message: 'not found' });
      }
      const chunk = this.swarm.chunks.get(feedSlotAddress(owner, topic, index)) as Uint8Array;
      return send(200, chunk.slice(SOC_HEADER_BYTES + SPAN_BYTES), {
        'swarm-feed-index': FeedIndex.fromBigInt(BigInt(index)).toHex(),
        'swarm-feed-index-next': FeedIndex.fromBigInt(BigInt(index + 1)).toHex(),
      });
    }

    if (request.method === 'POST' && (match = /^\/soc\/([0-9a-f]{40})\/([0-9a-f]{64})$/.exec(url.pathname))) {
      if (this.faults.writeFailures > 0) {
        this.faults.writeFailures -= 1;
        return send(500, { message: 'internal error' });
      }
      await delay(this.faults.socWriteDelayMs);
      const [, owner, identifier] = match;
      const address = socAddress(identifier, owner);
      this.socWriteAddresses.push(address);
      if (this.faults.refuseWrite?.(address)) {
        return send(500, { message: 'internal error' });
      }
      await delay(this.faults.slowWrites.get(address) ?? 0);
      const signature = url.searchParams.get('sig') ?? '';
      this.swarm.chunks.set(
        address,
        Buffer.concat([Buffer.from(identifier, 'hex'), Buffer.from(signature, 'hex'), body]),
      );
      this.swarm.storedAt.set(address, Date.now());
      this.socWrites += 1;
      this.swarm.deliver(address, body.slice(SPAN_BYTES), this);
      if (this.faults.writesLandThenFail > 0) {
        this.faults.writesLandThenFail -= 1;
        return send(500, { message: 'internal error' });
      }
      return send(201, { reference: address });
    }

    if (request.method === 'GET' && (url.pathname === '/readiness' || url.pathname === '/topology')) {
      if (this.faults.statusFailure) {
        return send(this.faults.statusFailure, { message: 'unavailable' });
      }
      if (url.pathname === '/readiness') {
        return send(this.faults.ready ? 200 : 400, {
          apiVersion: '7.3.0',
          version: '2.8.2',
          status: this.faults.ready ? 'ready' : 'notReady',
        });
      }
      return send(200, {
        baseAddr: '0'.repeat(64),
        population: this.faults.connectedPeers * 4,
        connected: this.faults.connectedPeers,
        timestamp: new Date().toISOString(),
        nnLowWatermark: 3,
        depth: 8,
        reachability: 'Public',
        networkAvailability: 'Available',
        bins: {},
      });
    }

    if (request.method === 'POST' && url.pathname === '/bytes') {
      if (this.faults.dataUploadFailures > 0) {
        this.faults.dataUploadFailures -= 1;
        return send(500, { message: 'internal error' });
      }
      await delay(this.faults.dataUploadDelayMs);
      const reference = hex(Bytes.keccak256(body).toUint8Array());
      this.swarm.data.set(reference, body);
      return send(201, { reference });
    }

    if (request.method === 'GET' && (match = /^\/bytes\/([0-9a-f]{64})$/.exec(url.pathname))) {
      const data = this.swarm.data.get(match[1]);
      return data ? send(200, data) : send(404, { message: 'not found' });
    }

    return send(404, { message: `no fake route for ${request.method} ${url.pathname}` });
  }

  private takeMiss(address: string): boolean {
    for (const key of [address, '*']) {
      const left = this.faults.chunkMisses.get(key) ?? 0;
      if (left > 0) {
        this.faults.chunkMisses.set(key, left - 1);
        return true;
      }
    }
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of request) {
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts);
}
