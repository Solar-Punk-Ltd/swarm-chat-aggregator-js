import type { ChatFeed } from './feed/slots.js';

/**
 * The newest slot of a chat that has no checkpoint, which in normal operation means a chat that is new, -1 when
 * it has none. Bee answers 404 for a failed lookup as well as for a feed with no update, so a 404 is confirmed by
 * reading slot 0. Throws while the answer cannot be trusted, and the chat stays unpublished and retries.
 */
export async function findHeadWithoutCheckpoint(feed: ChatFeed): Promise<number> {
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
  return first.kind === 'empty' ? -1 : 0;
}
