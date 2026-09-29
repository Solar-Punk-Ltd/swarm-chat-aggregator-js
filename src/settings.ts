import { z } from 'zod';

import { MINUTE, SECOND } from './utils/constants.js';

const hex = (length: number) =>
  z
    .string()
    .trim()
    .transform((value) => value.replace(/^0x/i, '').toLowerCase())
    .pipe(z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`), `expected ${length} hex characters`));

const url = z
  .string()
  .trim()
  .pipe(z.url({ protocol: /^https?$/ }))
  .transform((value) => value.replace(/\/+$/, ''));

const milliseconds = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const count = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const topicList = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((topic) => topic.trim())
      .filter((topic) => topic.length > 0),
  );

const topicPattern = z
  .string()
  .optional()
  .transform((value, context) => {
    if (!value?.trim()) {
      return undefined;
    }
    try {
      return new RegExp(`^(?:${value.trim()})$`);
    } catch (error) {
      context.addIssue({ code: 'custom', message: `not a regular expression: ${(error as Error).message}` });
      return z.NEVER;
    }
  });

/** Every setting the server reads, by the environment variable that carries it. */
const environmentSchema = z
  .object({
    LISTEN_BEE_URL: url,
    WRITE_BEE_URL: url,
    HEARTBEAT_BEE_URL: url,
    WRITE_STAMP: hex(64),
    HEARTBEAT_STAMP: hex(64),
    FEED_KEY: hex(64),
    GSOC_KEY: hex(64),
    GSOC_IDENTIFIER: z.string().min(1),
    CHAT_TOPICS: topicList,
    CHAT_TOPIC_PATTERN: topicPattern,
    MAX_ACTIVE_CHATS: count(50),
    RATE_WINDOW_MS: milliseconds(MINUTE),
    RATE_PER_CHAT: count(600),
    RATE_PER_SENDER: count(30),
    QUEUE_LIMIT: count(500),
    RESUBSCRIBE_IDLE_MS: milliseconds(3 * MINUTE),
    HEARTBEAT_INTERVAL_MS: milliseconds(MINUTE),
    HEARTBEAT_STALE_MS: milliseconds(3 * MINUTE),
    READ_RECHECK_MS: milliseconds(3 * SECOND),
    REQUEST_TIMEOUT_MS: milliseconds(30 * SECOND),
    RESUME_RETRY_MS: milliseconds(30 * SECOND),
    PUBLISH_ATTEMPTS: count(6),
    RETRY_BASE_MS: milliseconds(SECOND),
    SHUTDOWN_DEADLINE_MS: milliseconds(20 * SECOND),
    LOCK_REFRESH_MS: milliseconds(5 * SECOND),
    LOCK_STALE_MS: milliseconds(MINUTE),
    CHECKPOINT_DIR: z.string().min(1).default('./checkpoints'),
    HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  })
  .refine((env) => env.CHAT_TOPICS.length > 0 || env.CHAT_TOPIC_PATTERN !== undefined, {
    message: 'set CHAT_TOPICS, CHAT_TOPIC_PATTERN or both',
    path: ['CHAT_TOPICS'],
  })
  .refine((env) => env.HEARTBEAT_STALE_MS > env.HEARTBEAT_INTERVAL_MS, {
    message: 'must be longer than HEARTBEAT_INTERVAL_MS',
    path: ['HEARTBEAT_STALE_MS'],
  })
  .refine((env) => env.LOCK_STALE_MS > 2 * env.LOCK_REFRESH_MS, {
    message: 'must be more than twice LOCK_REFRESH_MS',
    path: ['LOCK_STALE_MS'],
  });

export type Environment = z.input<typeof environmentSchema>;

export type Settings = {
  listenBeeUrl: string;
  writeBeeUrl: string;
  heartbeatBeeUrl: string;
  writeStamp: string;
  heartbeatStamp: string;
  feedKey: string;
  gsocKey: string;
  gsocIdentifier: string;
  allowedChats: { topics: ReadonlySet<string>; pattern: RegExp | undefined; maxActive: number };
  rates: { windowMs: number; perChat: number; perSender: number };
  queueLimit: number;
  resubscribeIdleMs: number;
  heartbeatIntervalMs: number;
  heartbeatStaleMs: number;
  readRecheckMs: number;
  requestTimeoutMs: number;
  resumeRetryMs: number;
  publishAttempts: number;
  retryBaseMs: number;
  shutdownDeadlineMs: number;
  lockRefreshMs: number;
  lockStaleMs: number;
  checkpointDir: string;
  healthPort: number;
};

export class SettingsError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid settings:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
  }
}

/** Reads and checks every setting once. Throws a SettingsError naming each bad variable. */
export function parseSettings(environment: Record<string, string | undefined>): Settings {
  const blankAsMissing = Object.fromEntries(
    Object.entries(environment).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = environmentSchema.safeParse(blankAsMissing);
  if (!result.success) {
    throw new SettingsError(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`),
    );
  }
  const env = result.data;
  return {
    listenBeeUrl: env.LISTEN_BEE_URL,
    writeBeeUrl: env.WRITE_BEE_URL,
    heartbeatBeeUrl: env.HEARTBEAT_BEE_URL,
    writeStamp: env.WRITE_STAMP,
    heartbeatStamp: env.HEARTBEAT_STAMP,
    feedKey: env.FEED_KEY,
    gsocKey: env.GSOC_KEY,
    gsocIdentifier: env.GSOC_IDENTIFIER,
    allowedChats: {
      topics: new Set(env.CHAT_TOPICS),
      pattern: env.CHAT_TOPIC_PATTERN,
      maxActive: env.MAX_ACTIVE_CHATS,
    },
    rates: { windowMs: env.RATE_WINDOW_MS, perChat: env.RATE_PER_CHAT, perSender: env.RATE_PER_SENDER },
    queueLimit: env.QUEUE_LIMIT,
    resubscribeIdleMs: env.RESUBSCRIBE_IDLE_MS,
    heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
    heartbeatStaleMs: env.HEARTBEAT_STALE_MS,
    readRecheckMs: env.READ_RECHECK_MS,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    resumeRetryMs: env.RESUME_RETRY_MS,
    publishAttempts: env.PUBLISH_ATTEMPTS,
    retryBaseMs: env.RETRY_BASE_MS,
    shutdownDeadlineMs: env.SHUTDOWN_DEADLINE_MS,
    lockRefreshMs: env.LOCK_REFRESH_MS,
    lockStaleMs: env.LOCK_STALE_MS,
    checkpointDir: env.CHECKPOINT_DIR,
    healthPort: env.HEALTH_PORT,
  };
}

export function isAllowedChat(allowed: Settings['allowedChats'], topic: string): boolean {
  return allowed.topics.has(topic) || (allowed.pattern?.test(topic) ?? false);
}
