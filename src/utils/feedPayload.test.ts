import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeStatePayload } from './feedPayload.js';

test('measures the payload in bytes, not characters', () => {
  const state = { message: { text: 'Szia Trón — köszönöm 🙂' } };
  const json = JSON.stringify(state);
  const payload = encodeStatePayload(state);

  assert.ok(payload.length > json.length);
  assert.equal(new TextDecoder().decode(payload), json);
});

test('round-trips the JSON', () => {
  const state = { message: { text: 'hi' }, messageStateRefs: null };
  assert.deepEqual(JSON.parse(new TextDecoder().decode(encodeStatePayload(state))), state);
});
