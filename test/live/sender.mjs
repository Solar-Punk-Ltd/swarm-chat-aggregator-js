import { Bee, Identifier } from '@ethersphere/bee-js';

import { PayloadFormat } from './payloads.mjs';

export const SendOutcome = { SENT: 'sent', CONFIRMED: 'confirmed', FAILED: 'failed' };

/** 6.2.8's retryAwaitableAsync defaults: three retries, 250 ms apart, on a failed send only. */
const V6_RETRIES = 3;
const V6_RETRY_DELAY_MS = 250;

/** bee-js 13.1 ignores its timeout option, so every write carries a signal of its own. */
const WRITE_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Writes payloads to the chat's GSOC address as a browser does, never deferred. A v6 sender behaves like library
 * 6.2.8 and never checks the feed. A v7 sender behaves like 7.0: the message stays pending until it is read back
 * from the feed, and the identical bytes are sent again every `resendIntervalMs`, at most `resendAttempts` times.
 */
export class GsocSender {
  constructor({
    beeUrl,
    messaging,
    stamp,
    gsocKey,
    gsocIdentifier,
    format,
    resendIntervalMs,
    resendAttempts,
    isPublished,
  }) {
    this.messaging = messaging ?? new Bee(beeUrl).messaging;
    this.stamp = stamp;
    this.gsocKey = gsocKey;
    this.identifier = Identifier.fromString(gsocIdentifier);
    this.format = format;
    this.resendIntervalMs = resendIntervalMs;
    this.resendAttempts = resendAttempts;
    this.isPublished = isPublished;
    this.writes = 0;
  }

  async write(bytes) {
    this.writes++;
    await this.messaging.gsocSend(this.stamp, this.gsocKey, this.identifier, bytes, undefined, {
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
  }

  async writeWithRetries(bytes) {
    for (let retry = 0; ; retry++) {
      try {
        return await this.write(bytes);
      } catch (error) {
        if (retry >= V6_RETRIES) throw error;
        await sleep(V6_RETRY_DELAY_MS);
      }
    }
  }

  /** Sends a payload whose outcome the bed only reads from the feed, such as a forged or malformed one. */
  async sendOnce(bytes) {
    await this.writeWithRetries(bytes);
    return SendOutcome.SENT;
  }

  async send({ id, bytes }) {
    if (this.format === PayloadFormat.V6) return this.sendOnce(bytes);

    await this.writeTolerated(bytes);
    for (let resend = 0; ; resend++) {
      await sleep(this.resendIntervalMs);
      if (await this.isPublished(id)) return SendOutcome.CONFIRMED;
      if (resend >= this.resendAttempts) return SendOutcome.FAILED;
      await this.writeTolerated(bytes);
    }
  }

  /** A failed write of a pending v7 message is covered by the next resend, as a failed delivery is. */
  async writeTolerated(bytes) {
    try {
      await this.write(bytes);
    } catch (error) {
      this.writeErrors = [...(this.writeErrors ?? []), String(error?.message ?? error)];
    }
  }
}
