/**
 * @typedef {object} Verdict
 * @property {string[]} missing ids sent and never found in the feed
 * @property {{id: string, slots: number[]}[]} duplicated ids found in more than one slot
 * @property {{index: number, first: string | null, last: string | null}[]} overwritten slots whose message changed
 * @property {{index: number, id: string | null}[]} foreign slots holding something no valid send produced
 */

/** Every feed slot the bed has read over a run, by index, keeping the first message seen there and the last. */
export class FeedLedger {
  constructor() {
    /** @type {Map<number, {first: string | null, last: string | null}>} */
    this.slots = new Map();
  }

  record(index, id, seenAt = Date.now()) {
    const slot = this.slots.get(index);
    if (slot) slot.last = id;
    else this.slots.set(index, { first: id, last: id, seenAt });
  }

  /** When each message was first seen in the feed, by id. */
  appearances() {
    const seenAt = new Map();
    for (const { last, seenAt: at } of this.slots.values()) if (!seenAt.has(last)) seenAt.set(last, at);
    return seenAt;
  }

  /** When the last of these ids was first seen in the feed, or null while any of them is still missing. */
  lastAppearedAt(ids) {
    const seenAt = this.appearances();
    let latest = 0;
    for (const id of ids) {
      if (!seenAt.has(id)) return null;
      latest = Math.max(latest, seenAt.get(id));
    }
    return latest;
  }

  /** The first index the bed has not read yet, since a feed fills from 0 without gaps. */
  get nextIndex() {
    let index = 0;
    while (this.slots.has(index)) index++;
    return index;
  }

  has(id) {
    for (const slot of this.slots.values()) if (slot.last === id) return true;
    return false;
  }

  /** @returns {Verdict} */
  verdict(expectedIds) {
    const expected = new Set(expectedIds);
    const slotsOf = new Map();
    const overwritten = [];
    const foreign = [];
    for (const [index, { first, last }] of [...this.slots].sort(([a], [b]) => a - b)) {
      if (first !== last) overwritten.push({ index, first, last });
      if (last === null || !expected.has(last)) foreign.push({ index, id: last });
      else slotsOf.set(last, [...(slotsOf.get(last) ?? []), index]);
    }
    return {
      missing: [...expected].filter((id) => !slotsOf.has(id)),
      duplicated: [...slotsOf].filter(([, slots]) => slots.length > 1).map(([id, slots]) => ({ id, slots })),
      overwritten,
      foreign,
    };
  }
}

export function isClean(verdict) {
  return Object.values(verdict).every((list) => list.length === 0);
}

export function describeVerdict(verdict) {
  const parts = [];
  if (verdict.missing.length) parts.push(`${verdict.missing.length} missing`);
  if (verdict.duplicated.length) parts.push(`${verdict.duplicated.length} in more than one slot`);
  if (verdict.overwritten.length) {
    parts.push(
      `${verdict.overwritten.length} slots overwritten (${verdict.overwritten.map((s) => s.index).join(', ')})`,
    );
  }
  if (verdict.foreign.length) {
    parts.push(
      `${verdict.foreign.length} slots hold what no valid send produced (${verdict.foreign
        .map((s) => s.index)
        .join(', ')})`,
    );
  }
  return parts.length ? parts.join(', ') : 'every message exactly once, no slot overwritten';
}

/**
 * How long each message took from its first send to its first sight in the feed, and how close the slowest came to
 * the senders' window, the time after which a sender gives up. A pass or a fail says only which side of the window
 * the slowest message fell, and this says by how much, so runs of two commits compare on a number.
 */
export function describeSendToFeed(firstSentAt, ledger, windowMs) {
  const seenAt = ledger.appearances();
  const spans = [];
  let neverAppeared = 0;
  for (const [id, sentAt] of firstSentAt) {
    if (seenAt.has(id)) spans.push(seenAt.get(id) - sentAt);
    else neverAppeared++;
  }
  if (spans.length === 0) return `no message appeared in the feed, ${neverAppeared} sent`;
  spans.sort((a, b) => a - b);
  const at = (fraction) => spans[Math.min(spans.length - 1, Math.floor(fraction * spans.length))];
  const slowest = spans.at(-1);
  const past = spans.filter((span) => span > windowMs).length;
  return (
    `first send to feed per message p50 ${at(0.5)} p90 ${at(0.9)} max ${slowest} ms, ` +
    `smallest margin to the ${windowMs} ms sender window ${windowMs - slowest} ms, ${past} past it` +
    (neverAppeared ? `, ${neverAppeared} never appeared` : '')
  );
}
