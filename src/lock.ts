import { randomBytes } from 'node:crypto';
import { open, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sleep } from './utils/sleep.js';

export class LockHeldError extends Error {}

export type LockTimings = { refreshMs: number; staleMs: number };

/**
 * One writer per checkpoint folder. The lock file holds a random instance id, never a PID, because
 * the server is PID 1 in its container. The holder touches it every `refreshMs`. A new start takes it
 * over once it is `staleMs` old, which is how a killed holder's lock stops blocking, and refuses to
 * start while a live holder keeps it fresh.
 */
export class FolderLock {
  readonly instance = randomBytes(16).toString('hex');
  private readonly path: string;
  private timer: NodeJS.Timeout | undefined;
  private held = false;

  constructor(
    dir: string,
    private readonly timings: LockTimings,
    private readonly onLost: (reason: string) => void,
  ) {
    this.path = join(dir, 'writer.lock');
  }

  async acquire(): Promise<void> {
    const giveUpAt = Date.now() + this.timings.staleMs + 2 * this.timings.refreshMs;
    while (!(await this.tryAcquire())) {
      if (Date.now() > giveUpAt) {
        throw new LockHeldError(`${this.path} is held by a running instance that keeps it fresh`);
      }
      await sleep(this.timings.refreshMs);
    }
    this.held = true;
    this.timer = setInterval(() => void this.refresh(), this.timings.refreshMs);
    this.timer.unref();
  }

  async release(): Promise<void> {
    clearInterval(this.timer);
    if (this.held && (await this.holder()) === this.instance) {
      await unlink(this.path).catch(() => undefined);
    }
    this.held = false;
  }

  private async tryAcquire(): Promise<boolean> {
    try {
      const file = await open(this.path, 'wx');
      await file.writeFile(this.instance);
      await file.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    const age = await this.age();
    if (age !== undefined && age < this.timings.staleMs) {
      return false;
    }
    const temporary = `${this.path}.${this.instance}`;
    await writeFile(temporary, this.instance);
    await rename(temporary, this.path);
    // Two starts can take over at once. The rename that lands last wins and the other sees its id gone.
    await sleep(Math.min(this.timings.refreshMs, 1000));
    return (await this.holder()) === this.instance;
  }

  private async refresh(): Promise<void> {
    if (!this.held) {
      return;
    }
    const holder = await this.holder();
    if (holder !== this.instance) {
      this.held = false;
      clearInterval(this.timer);
      this.onLost(holder ? `instance ${holder} took the lock over` : 'the lock file is gone');
      return;
    }
    const now = new Date();
    await utimes(this.path, now, now).catch(() => undefined);
  }

  private async holder(): Promise<string | undefined> {
    return readFile(this.path, 'utf8').then(
      (text) => text.trim(),
      () => undefined,
    );
  }

  private async age(): Promise<number | undefined> {
    return stat(this.path).then(
      (info) => Date.now() - info.mtimeMs,
      () => undefined,
    );
  }
}
