import { type ChatMessage, parseChatMessage } from '@solarpunkltd/swarm-chat-js/message';

import type { ChatPublisher } from './chat.js';
import { type SentNonces, heartbeatNonce } from './heartbeat.js';
import type { Logger } from './libs/logger.js';
import { RateLimiter } from './rate.js';
import { type Settings, isAllowedChat } from './settings.js';
import { DropReason, type Stats } from './stats.js';
import { DAY } from './utils/constants.js';

export type IntakeHealth = { lastHeartbeatReceivedAt: number | null };

/** Every GSOC frame passes here: the server's heartbeats are matched and dropped, chat messages checked. */
export class Intake {
  private readonly perChat: RateLimiter;
  private readonly perSender: RateLimiter;
  private lastHeartbeatReceivedAt: number | null = null;

  constructor(
    private readonly allowed: Settings['allowedChats'],
    rates: Settings['rates'],
    private readonly sentNonces: SentNonces,
    private readonly chatFor: (topic: string) => ChatPublisher | undefined,
    private readonly stats: Stats,
    private readonly logger: Logger,
  ) {
    this.perChat = new RateLimiter(rates.perChat, rates.windowMs);
    this.perSender = new RateLimiter(rates.perSender, rates.windowMs);
  }

  health(): IntakeHealth {
    return { lastHeartbeatReceivedAt: this.lastHeartbeatReceivedAt };
  }

  receive(payload: Uint8Array, now = Date.now()): void {
    const nonce = heartbeatNonce(payload);
    if (nonce !== undefined) {
      this.receiveHeartbeat(nonce, now);
      return;
    }
    this.stats.received += 1;
    const check = parseChatMessage(payload);
    if (!check.ok) {
      this.drop(check.reason, check.detail);
      return;
    }
    const reason = this.admit(check.message, now);
    if (reason) {
      this.drop(reason, `${check.message.topic} ${check.message.addr}:${check.message.id}`);
    }
  }

  /** Forgets rate windows that have passed. The server calls it now and then. */
  prune(now = Date.now()): void {
    this.perChat.prune(now);
    this.perSender.prune(now);
  }

  private admit(message: ChatMessage, now: number): DropReason | undefined {
    if (!isAllowedChat(this.allowed, message.topic)) {
      return DropReason.ChatNotAllowed;
    }
    if (Math.abs(message.ts - now) > DAY) {
      return DropReason.Clock;
    }
    const chat = this.chatFor(message.topic);
    if (!chat) {
      return DropReason.ChatLimit;
    }
    if (chat.isDuplicate(message)) {
      return DropReason.Duplicate;
    }
    const sender = `${message.topic}:${message.addr}`;
    if (!this.perSender.fits(sender, now)) {
      return DropReason.RateSender;
    }
    if (!this.perChat.fits(message.topic, now)) {
      return DropReason.RateChat;
    }
    const refused = chat.offer(message, now);
    if (!refused) {
      this.perSender.record(sender, now);
      this.perChat.record(message.topic, now);
    }
    return refused;
  }

  private receiveHeartbeat(nonce: string, now: number): void {
    const match = this.sentNonces.match(nonce);
    if (match === 'ours') {
      this.stats.heartbeatsReceived += 1;
      this.lastHeartbeatReceivedAt = now;
    } else if (match === 'repeat') {
      this.stats.drop(DropReason.HeartbeatRepeat);
    } else {
      this.stats.drop(DropReason.HeartbeatUnknown);
    }
  }

  private drop(reason: DropReason, detail: string): void {
    this.stats.drop(reason);
    this.logger.debug(`[intake] dropped, ${reason}: ${detail}`);
  }
}
