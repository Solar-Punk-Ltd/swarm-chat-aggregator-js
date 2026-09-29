import {
  type Bee,
  type BeeError,
  type Bytes,
  type GsocSubscription,
  Identifier,
  PrivateKey,
} from '@ethersphere/bee-js';

import { describeError } from './feed/slots.js';
import { type SentNonces, encodeHeartbeat, newHeartbeat } from './heartbeat.js';
import type { Logger } from './libs/logger.js';
import { reconnectDelayMs } from './utils/backoff.js';

export type ListenerTimings = { resubscribeIdleMs: number; heartbeatIntervalMs: number; requestTimeoutMs: number };

export type ListenerHealth = {
  subscribed: boolean;
  lastFrameAt: number | null;
  subscribedAt: number | null;
  lastSubscribeError: string | null;
  resubscribes: number;
  lastHeartbeatSentAt: number | null;
  lastHeartbeatSendError: string | null;
};

/**
 * Listens on the GSOC inbox every chat arrives through, and proves it can hear by sending itself a
 * heartbeat through a different node. A dropped connection never closes on its own, because Bee's
 * socket never reads and a proxy can drop it silently, so the listener resubscribes whenever it has
 * heard nothing for `resubscribeIdleMs`, opening the new subscription before closing the old one.
 */
export class GsocListener {
  private readonly key: PrivateKey;
  private readonly identifier: Identifier;
  private current: GsocSubscription | undefined;
  /** Subscriptions replaced by a newer one, kept open a little while so the two overlap. */
  private readonly retiring = new Map<GsocSubscription, NodeJS.Timeout>();
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private stopped = true;
  private readonly state: ListenerHealth = {
    subscribed: false,
    lastFrameAt: null,
    subscribedAt: null,
    lastSubscribeError: null,
    resubscribes: 0,
    lastHeartbeatSentAt: null,
    lastHeartbeatSendError: null,
  };

  constructor(
    private readonly listenBee: Bee,
    private readonly heartbeatBee: Bee,
    private readonly heartbeatStamp: string,
    gsocKey: string,
    gsocIdentifier: string,
    private readonly sentNonces: SentNonces,
    private readonly timings: ListenerTimings,
    private readonly onFrame: (payload: Uint8Array) => void,
    private readonly logger: Logger,
  ) {
    this.key = new PrivateKey(gsocKey);
    this.identifier = Identifier.fromString(gsocIdentifier);
  }

  start(): void {
    this.stopped = false;
    this.subscribe();
    const every = Math.max(250, Math.min(this.timings.resubscribeIdleMs / 4, 5000));
    this.watchdog = setInterval(() => this.checkIdle(), every);
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), this.timings.heartbeatIntervalMs);
    void this.sendHeartbeat();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.watchdog);
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.reconnectTimer);
    const subscription = this.current;
    this.current = undefined;
    subscription?.cancel();
    for (const [retired, timer] of this.retiring) {
      clearTimeout(timer);
      retired.cancel();
    }
    this.retiring.clear();
    this.state.subscribed = false;
  }

  health(): ListenerHealth {
    return { ...this.state };
  }

  /** Sends one heartbeat through the heartbeat node. Public so a test can send one on demand. */
  async sendHeartbeat(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const heartbeat = newHeartbeat();
    this.sentNonces.add(heartbeat.nonce);
    try {
      await this.heartbeatBee.messaging.gsocSend(
        this.heartbeatStamp,
        this.key,
        this.identifier,
        encodeHeartbeat(heartbeat),
        { deferred: false },
        { signal: AbortSignal.timeout(this.timings.requestTimeoutMs) },
      );
      this.state.lastHeartbeatSentAt = Date.now();
      this.state.lastHeartbeatSendError = null;
    } catch (error) {
      this.state.lastHeartbeatSendError = `heartbeat node ${this.heartbeatBee.url}: ${describeError(error)}`;
      this.logger.warn('[gsoc] heartbeat send failed', this.state.lastHeartbeatSendError);
    }
  }

  private subscribe(): void {
    const previous = this.current;
    let subscription: GsocSubscription;
    try {
      subscription = this.listenBee.messaging.gsocSubscribe(this.key.publicKey().address(), this.identifier, {
        onMessage: (message: Bytes) => {
          if (subscription !== this.current && !this.retiring.has(subscription)) {
            return;
          }
          this.state.lastFrameAt = Date.now();
          this.reconnectAttempt = 0;
          this.onFrame(message.toUint8Array());
        },
        onError: (error: BeeError) => {
          this.state.lastSubscribeError = `listener ${this.listenBee.url}: ${error.message}`;
          this.logger.warn('[gsoc] subscription error', this.state.lastSubscribeError);
        },
        onClose: () => {
          if (subscription === this.current) {
            this.state.subscribed = false;
            this.scheduleReconnect();
          }
        },
      });
    } catch (error) {
      this.state.lastSubscribeError = `listener ${this.listenBee.url}: ${describeError(error)}`;
      this.logger.error('[gsoc] subscribe failed', this.state.lastSubscribeError);
      this.scheduleReconnect();
      return;
    }
    this.current = subscription;
    this.state.subscribed = true;
    this.state.subscribedAt = Date.now();
    if (previous) {
      this.retire(previous);
    }
    this.logger.info(`[gsoc] subscribed on ${this.listenBee.url}`);
  }

  /** Closes a replaced subscription once the new one has had time to connect. Dedupe absorbs the overlap. */
  private retire(subscription: GsocSubscription): void {
    const graceMs = Math.min(this.timings.resubscribeIdleMs / 2, 10_000);
    const timer = setTimeout(() => {
      this.retiring.delete(subscription);
      subscription.cancel();
    }, graceMs);
    this.retiring.set(subscription, timer);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    const delayMs = reconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.logger.warn(`[gsoc] subscription closed, resubscribing in ${delayMs} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped) {
        this.state.resubscribes += 1;
        this.subscribe();
      }
    }, delayMs);
  }

  private checkIdle(): void {
    if (this.stopped || !this.current) {
      return;
    }
    const heardAt = Math.max(this.state.lastFrameAt ?? 0, this.state.subscribedAt ?? 0);
    if (Date.now() - heardAt >= this.timings.resubscribeIdleMs) {
      this.logger.warn(`[gsoc] nothing heard for ${Date.now() - heardAt} ms, resubscribing`);
      this.state.resubscribes += 1;
      this.subscribe();
    }
  }
}
