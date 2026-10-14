import { Bee, Identifier } from '@ethersphere/bee-js';

export const SendOutcome = { SENT: 'sent', CONFIRMED: 'confirmed', FAILED: 'failed', REFUSED: 'refused' };

/** A write the node refused, as one line: its HTTP status and what the node said. */
export function describeSendError(error) {
  const status = error?.status ?? 'no status';
  const said = error?.responseBody ? JSON.stringify(error.responseBody) : String(error?.message ?? error);
  return `${status} ${said}`.slice(0, 240);
}

/** How often a one-off write is retried after it fails, and how far apart. */
const ONE_OFF_RETRIES = 3;
const ONE_OFF_RETRY_DELAY_MS = 250;

/** bee-js 13.1 ignores its timeout option, so every write carries a signal of its own. */
const WRITE_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Writes payloads to the chat's GSOC address as a browser does, never deferred. A message stays pending until it is
 * read back from the feed, and the identical bytes are sent again every `resendIntervalMs`, at most `resendAttempts` times.
 */
export class GsocSender {
  constructor({ beeUrl, messaging, stamp, gsocKey, gsocIdentifier, resendIntervalMs, resendAttempts, isPublished }) {
    this.messaging = messaging ?? new Bee(beeUrl).messaging;
    this.stamp = stamp;
    this.gsocKey = gsocKey;
    this.identifier = Identifier.fromString(gsocIdentifier);
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
        if (retry >= ONE_OFF_RETRIES) throw error;
        await sleep(ONE_OFF_RETRY_DELAY_MS);
      }
    }
  }

  /** Sends a payload whose outcome the bed only reads from the feed, such as a forged or malformed one. */
  async sendOnce(bytes) {
    await this.writeWithRetries(bytes);
    return SendOutcome.SENT;
  }

  async send({ id, bytes }) {
    await this.writeTolerated(bytes);
    for (let resend = 0; ; resend++) {
      await sleep(this.resendIntervalMs);
      if (await this.isPublished(id)) return SendOutcome.CONFIRMED;
      if (resend >= this.resendAttempts) return SendOutcome.FAILED;
      await this.writeTolerated(bytes);
    }
  }

  /** A failed write of a pending message is covered by the next resend, as a failed delivery is. */
  async writeTolerated(bytes) {
    try {
      await this.write(bytes);
    } catch (error) {
      this.writeErrors = [...(this.writeErrors ?? []), describeSendError(error)];
    }
  }
}
