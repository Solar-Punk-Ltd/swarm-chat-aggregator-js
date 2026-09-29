import { expect, test } from 'vitest';

import { encodeStatePayload } from '../src/utils/feedPayload.js';

test('measures the payload in bytes, not characters', () => {
  const state = { message: { text: 'Szia Trón — köszönöm 🙂' } };
  const json = JSON.stringify(state);
  const payload = encodeStatePayload(state);

  expect(payload.length).toBeGreaterThan(json.length);
  expect(new TextDecoder().decode(payload)).toBe(json);
});

test('round-trips the JSON', () => {
  const state = { message: { text: 'hi' }, messageStateRefs: null };
  expect(JSON.parse(new TextDecoder().decode(encodeStatePayload(state)))).toEqual(state);
});
