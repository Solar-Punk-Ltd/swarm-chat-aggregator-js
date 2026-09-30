import { spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { WaitAbandoned, waitFor } from './cluster.mjs';

export const ServerKind = { MASTER: 'master', EVENT: 'event' };

/**
 * What the bed hands a server, named once for both servers.
 * @typedef {object} ServerSettings
 * @property {string} listenUrl the node the server subscribes on
 * @property {string} writeUrl the node its feed and history writes go through
 * @property {string} gsocKey the mined GSOC key, 64 hex characters
 * @property {string} gsocIdentifier the GSOC identifier string
 * @property {string} feedKey the key that owns every chat feed
 * @property {string} writeStamp
 * @property {string} heartbeatStamp
 * @property {string} chatTopicPattern a regex matched against the whole chat topic
 * @property {number} port
 */

/** The environment each server reads. The event server's names and the bed's intervals come from sp-hls3. */
const ENVIRONMENT = {
  [ServerKind.MASTER]: (s) => ({
    GSOC_BEE_URL: s.listenUrl,
    GSOC_RESOURCE_ID: s.gsocKey,
    GSOC_TOPIC: s.gsocIdentifier,
    CHAT_BEE_URL: s.writeUrl,
    CHAT_KEY: s.feedKey,
    CHAT_STAMP: s.writeStamp,
    PORT: String(s.port),
  }),
  [ServerKind.EVENT]: (s, checkpointDir) => ({
    LISTEN_BEE_URL: s.listenUrl,
    WRITE_BEE_URL: s.writeUrl,
    HEARTBEAT_BEE_URL: s.writeUrl,
    WRITE_STAMP: s.writeStamp,
    HEARTBEAT_STAMP: s.heartbeatStamp,
    FEED_KEY: s.feedKey,
    GSOC_KEY: s.gsocKey,
    GSOC_IDENTIFIER: s.gsocIdentifier,
    CHAT_TOPIC_PATTERN: s.chatTopicPattern,
    HEALTH_PORT: String(s.port),
    HEARTBEAT_INTERVAL_MS: '2000',
    HEARTBEAT_STALE_MS: '10000',
    RESUBSCRIBE_IDLE_MS: '15000',
    LOCK_STALE_MS: '15000',
    // The server starts a chat without a checkpoint only once it counts this many connected peers. Each node of the
    // bed's three-node cluster has two, so one is met as soon as the listener is peered at all.
    MIN_CONNECTED_PEERS: '1',
    // Empty on every run and kept across B2's restart, since the server refuses a folder of an older checkpoint
    // format as damaged.
    CHECKPOINT_DIR: checkpointDir,
  }),
};

/**
 * The server as a child process of the bed, so its checkpoint folder is on the bed's own filesystem and a restart
 * is a process restart. It runs in a folder of its own with no .env in it, since both servers read one when present.
 */
export class ServerProcess {
  constructor({ kind, settings, log }) {
    if (!ENVIRONMENT[kind]) throw new Error(`unknown server kind ${kind}, expected master or event`);
    this.kind = kind;
    this.settings = settings;
    this.log = log;
    this.workdir = mkdtempSync(join(tmpdir(), 'swarm-chat-server-'));
    this.logFile = join(this.workdir, 'server.log');
    this.logStream = createWriteStream(this.logFile, { flags: 'a' });
    this.child = null;
  }

  async start() {
    const entry = resolve('dist/index.js');
    const env = {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      ...ENVIRONMENT[this.kind](this.settings, join(this.workdir, 'checkpoints')),
    };
    this.child = spawn(process.execPath, [entry], { cwd: this.workdir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout.pipe(this.logStream, { end: false });
    this.child.stderr.pipe(this.logStream, { end: false });
    const exited = new Promise((resolveExit) =>
      this.child.once('exit', (code, signal) => resolveExit({ code, signal })),
    );
    this.exited = exited;

    await waitFor(
      'the server to answer on its health port',
      async () => {
        if (this.child.exitCode !== null) {
          throw new WaitAbandoned(`the server exited with code ${this.child.exitCode}. Its log:\n${this.logTail()}`);
        }
        const response = await fetch(`http://127.0.0.1:${this.settings.port}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        return response.status === 200 || response.status === 503;
      },
      { timeoutMs: 60_000, intervalMs: 500 },
    );
    this.log(`server (${this.kind}) started, pid ${this.child.pid}`);
  }

  /** A graceful stop by default, as a deploy does it. */
  async stop(signal = 'SIGTERM') {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill(signal);
    const outcome = await Promise.race([
      this.exited,
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(null), 30_000)),
    ]);
    if (!outcome) {
      this.child.kill('SIGKILL');
      await this.exited;
    }
    this.log(`server stopped by ${signal}`);
  }

  saveLog(file) {
    try {
      copyFileSync(this.logFile, file);
    } catch (error) {
      this.log(`the server log could not be saved: ${error.message}`);
    }
  }

  logTail(lines = 60) {
    try {
      return readFileSync(this.logFile, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
    } catch {
      return '(no server log)';
    }
  }
}
