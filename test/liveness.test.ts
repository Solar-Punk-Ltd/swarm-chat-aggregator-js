import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { Rig, message, waitFor } from './helpers/harness.js';

let rig: Rig;

beforeEach(async () => {
  rig = await Rig.start();
});

afterEach(async () => {
  await rig.stop();
});

const fast = {
  HEARTBEAT_INTERVAL_MS: '100',
  HEARTBEAT_STALE_MS: '600',
  RESUBSCRIBE_IDLE_MS: '400',
};

async function healthOf(port: number | undefined): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('heartbeat', () => {
  test('comes back through the listener, is counted, and is never published or rate counted', async () => {
    const server = await rig.startServer({ ...fast, RATE_PER_CHAT: '1' });
    await waitFor(() => server.stats.heartbeatsReceived >= 3, 5000, 'three heartbeats');
    expect(rig.entry(0)).toBeUndefined();
    expect(server.stats.received).toBe(0);

    await rig.send(message());
    await waitFor(() => server.stats.published === 1, 5000, 'a message still fits the chat rate');

    const health = await healthOf(server.healthPort);
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ healthy: true, counts: { published: 1 } });
    expect(health.body.secondsSinceHeartbeatReceived).not.toBeNull();
  });

  test('health answers 503 and names the heartbeat node when sends fail', async () => {
    const server = await rig.startServer(fast);
    await waitFor(() => server.stats.heartbeatsReceived >= 1, 5000, 'a heartbeat');
    rig.heartbeat.faults.writeFailures = 1_000_000;
    await waitFor(async () => (await healthOf(server.healthPort)).status === 503, 5000, '503');
    const health = await healthOf(server.healthPort);
    expect(String(health.body.lastHeartbeatSendError)).toContain(rig.heartbeat.url);
    expect((health.body.problems as string[]).join(' ')).toContain('heartbeat');
  });

  test('health answers 503 when heartbeats stop coming back, though they are sent', async () => {
    const server = await rig.startServer({ ...fast, RESUBSCRIBE_IDLE_MS: '60000' });
    await waitFor(() => server.stats.heartbeatsReceived >= 1, 5000, 'a heartbeat');
    rig.listener.faults.gsocDeaf = true;
    await waitFor(async () => (await healthOf(server.healthPort)).status === 503, 5000, '503');
    const health = await healthOf(server.healthPort);
    expect(health.body.lastHeartbeatSendError).toBeNull();
    expect((health.body.problems as string[]).join(' ')).toContain('received back');
  });
});

describe('subscription', () => {
  test('resubscribes when nothing arrives for the idle interval, opening the new one before closing the old', async () => {
    const server = await rig.startServer({ ...fast, HEARTBEAT_STALE_MS: '5000' });
    await waitFor(() => server.stats.heartbeatsReceived >= 1, 5000, 'a heartbeat');
    rig.listener.faults.gsocDeaf = true;
    let most = 0;
    const watch = setInterval(() => (most = Math.max(most, rig.listener.subscriberCount)), 5);
    await waitFor(() => server.healthReport().resubscribes >= 1, 5000, 'a resubscribe');
    clearInterval(watch);
    expect(most).toBe(2);

    rig.listener.faults.gsocDeaf = false;
    const before = server.stats.heartbeatsReceived;
    await waitFor(() => server.stats.heartbeatsReceived > before, 5000, 'heartbeats on the new subscription');
    await rig.send(message());
    await waitFor(() => server.stats.published === 1, 5000, 'published through the new subscription');
  });

  test('resubscribes when the listener closes the socket', async () => {
    const server = await rig.startServer();
    rig.listener.dropSubscriptions();
    await waitFor(() => server.healthReport().resubscribes === 1, 5000, 'a reconnect');
    await waitFor(() => rig.listener.subscriberCount === 1, 5000, 'the new subscription');
    await rig.send(message());
    await waitFor(() => server.stats.published === 1, 5000, 'published after the reconnect');
  });
});
