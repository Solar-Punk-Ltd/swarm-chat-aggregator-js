import { describe, expect, it } from 'vitest';

import { encodeStatePayload } from './feedPayload.js';

describe('encodeStatePayload', () => {
  it('measures the payload in bytes, not characters', () => {
    const update = { message: { text: 'Szia Trón — köszönöm 🙂' }, messageStateRefs: null };
    const json = JSON.stringify(update);
    const payload = encodeStatePayload(update);

    expect(payload.length).toBeGreaterThan(json.length);
    expect(new TextDecoder().decode(payload)).toBe(json);
  });

  it('round-trips the JSON', () => {
    const update = { message: { text: 'hi' }, messageStateRefs: null };
    expect(JSON.parse(new TextDecoder().decode(encodeStatePayload(update)))).toEqual(update);
  });
});
