import type { Bee } from '@ethersphere/bee-js';

import { type ChatFeed, describeError } from './feed/slots.js';

/** What a chat with no checkpoint must prove before an absent slot 0 is believed. */
export type NewChatControls = {
  /** The node that writes the feed, which must be ready and see at least `minConnectedPeers` peers. */
  writer: Bee;
  minConnectedPeers: number;
  requestTimeoutMs: number;
  /** The same feed read through another node, with its own timeout. */
  secondFeed: ChatFeed;
};

/**
 * The newest slot of a chat that has no checkpoint, which in normal operation means a chat that is new, -1 when
 * it has none. Throws while the answer cannot be trusted, and the chat stays unpublished and retries.
 *
 * Bee answers 404 for a failed lookup as well as for a feed with no update, and a node that cannot reach its peers
 * reads every chunk as absent, so an absent slot 0 is believed only when the writing node is ready and has peers
 * and a second node cannot find slot 0 either. This is the one place a wrong answer would restart a chat at 0.
 */
export async function findHeadWithoutCheckpoint(feed: ChatFeed, controls: NewChatControls): Promise<number> {
  const head = await feed.lookupHead();
  if (head.kind === 'found') {
    return head.index;
  }
  if (head.kind === 'failed') {
    throw new Error(`head lookup: ${head.error}`);
  }
  const first = await feed.readSlot(0);
  if (first.kind === 'failed') {
    throw new Error(`slot 0 after a 404 lookup: ${first.error}`);
  }
  // Slot 0 holding anything, readable or not, is a head the walk reads, and blocks on if it is not ours.
  if (first.kind !== 'empty') {
    return 0;
  }
  await proveWriterSeesTheNetwork(controls);
  // One read: the second node is itself the confirmation, and a gap here would only add to every fresh start.
  const second = await controls.secondFeed.readSlotOnce(0);
  if (second.kind === 'failed') {
    throw new Error(`the second node could not read slot 0, so a new chat is not started: ${second.error}`);
  }
  return second.kind === 'empty' ? -1 : 0;
}

async function proveWriterSeesTheNetwork(controls: NewChatControls): Promise<void> {
  const options = () => ({ signal: AbortSignal.timeout(controls.requestTimeoutMs) });
  let status: string;
  try {
    status = (await controls.writer.status.getReadiness(options())).status;
  } catch (error) {
    throw new Error(`the writing node did not answer ready: ${describeError(error)}`, { cause: error });
  }
  if (status !== 'ready') {
    throw new Error(`the writing node answered ${status}, not ready, so an absent slot 0 is not believed`);
  }
  let connected: number;
  try {
    connected = (await controls.writer.connectivity.getTopology(options())).connected;
  } catch (error) {
    throw new Error(`the writing node could not report its peers: ${describeError(error)}`, { cause: error });
  }
  if (connected < controls.minConnectedPeers) {
    throw new Error(
      `the writing node has ${connected} connected peers, under the ${controls.minConnectedPeers} needed to believe an absent slot 0`,
    );
  }
}
