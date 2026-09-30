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

  record(index, id) {
    const slot = this.slots.get(index);
    if (slot) slot.last = id;
    else this.slots.set(index, { first: id, last: id });
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
