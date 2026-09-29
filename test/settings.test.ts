import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { SETTING_NAMES, SettingsError, isAllowedChat, parseSettings } from '../src/settings.js';
import { testKey } from './helpers/harness.js';

const valid = () => ({
  LISTEN_BEE_URL: 'http://listener.example.com:1633/',
  WRITE_BEE_URL: 'http://writer.example.com:1633',
  HEARTBEAT_BEE_URL: 'https://gateway.example.com',
  WRITE_STAMP: `0x${testKey().toUpperCase()}`,
  HEARTBEAT_STAMP: testKey(),
  FEED_KEY: testKey(),
  GSOC_KEY: testKey(),
  GSOC_IDENTIFIER: 'chat-inbox',
  CHAT_TOPICS: 'chat-a, chat-b',
});

function problemsOf(environment: Record<string, string | undefined>): string[] {
  try {
    parseSettings(environment);
  } catch (error) {
    if (error instanceof SettingsError) {
      return error.problems;
    }
    throw error;
  }
  return [];
}

describe('settings', () => {
  test('reads a complete environment with its defaults', () => {
    const settings = parseSettings(valid());
    expect(settings.listenBeeUrl).toBe('http://listener.example.com:1633');
    expect(settings.writeStamp).toMatch(/^[0-9a-f]{64}$/);
    expect([...settings.allowedChats.topics]).toEqual(['chat-a', 'chat-b']);
    expect(settings).toMatchObject({ healthPort: 3000, heartbeatIntervalMs: 60_000, checkpointDir: './checkpoints' });
  });

  test('names every missing or malformed variable', () => {
    const problems = problemsOf({ ...valid(), FEED_KEY: 'abc', WRITE_BEE_URL: 'not a url', GSOC_KEY: undefined });
    expect(problems.map((problem) => problem.split(':')[0]).sort()).toEqual(['FEED_KEY', 'GSOC_KEY', 'WRITE_BEE_URL']);
  });

  test('treats a blank variable as missing', () => {
    expect(problemsOf({ ...valid(), HEARTBEAT_STAMP: '  ' })[0]).toMatch(/^HEARTBEAT_STAMP/);
  });

  test('needs a list of chats, a pattern, or both', () => {
    expect(problemsOf({ ...valid(), CHAT_TOPICS: undefined })[0]).toMatch(/^CHAT_TOPICS/);
    const settings = parseSettings({ ...valid(), CHAT_TOPICS: undefined, CHAT_TOPIC_PATTERN: 'chat-[0-9]+' });
    expect(isAllowedChat(settings.allowedChats, 'chat-12')).toBe(true);
    expect(isAllowedChat(settings.allowedChats, 'chat-12-extra')).toBe(false);
    expect(problemsOf({ ...valid(), CHAT_TOPIC_PATTERN: '(' })[0]).toMatch(/^CHAT_TOPIC_PATTERN/);
  });

  test('refuses timings that cannot work together', () => {
    expect(problemsOf({ ...valid(), HEARTBEAT_INTERVAL_MS: '5000', HEARTBEAT_STALE_MS: '5000' })[0]).toMatch(
      /^HEARTBEAT_STALE_MS/,
    );
    expect(problemsOf({ ...valid(), LOCK_REFRESH_MS: '5000', LOCK_STALE_MS: '9000' })[0]).toMatch(/^LOCK_STALE_MS/);
  });
});

describe('documentation', () => {
  test('the README table and .env.sample name exactly the settings the code reads', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const table = [...readme.matchAll(/^\| `([A-Z_]+)`/gm)].map((match) => match[1]);
    const sample = readFileSync(new URL('../.env.sample', import.meta.url), 'utf8')
      .split('\n')
      .map((line) => /^([A-Z_]+)=/.exec(line)?.[1])
      .filter((name) => name !== undefined);
    expect(table.sort()).toEqual([...SETTING_NAMES].sort());
    expect(sample.sort()).toEqual([...SETTING_NAMES].sort());
  });

  test('the defaults in .env.sample are the defaults the code uses', () => {
    const sample = Object.fromEntries(
      readFileSync(new URL('../.env.sample', import.meta.url), 'utf8')
        .split('\n')
        .map((line) => /^([A-Z_]+)=(.+)$/.exec(line))
        .filter((match) => match !== null)
        .map((match) => [match[1], match[2]]),
    );
    const base = valid();
    expect(parseSettings({ ...base, ...sample })).toEqual(parseSettings(base));
  });
});
