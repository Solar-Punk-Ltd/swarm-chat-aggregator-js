/**
 * Mines the GSOC key for a listening node: a key whose inbox address, under the given identifier, falls in
 * that node's neighbourhood, so every browser's write to the inbox reaches it.
 *
 *   pnpm mine --overlay <the listening node's overlay> --identifier <GSOC_IDENTIFIER> [--proximity 12]
 *
 * The key it prints is public by design, since every browser that sends a message signs with it.
 */
import { parseArgs } from 'node:util';

import { Bee, Identifier } from '@ethersphere/bee-js';

const { values } = parseArgs({
  options: {
    overlay: { type: 'string' },
    identifier: { type: 'string' },
    proximity: { type: 'string', default: '12' },
  },
});

const overlay = values.overlay?.replace(/^0x/i, '');
const proximity = Number(values.proximity);
if (!overlay || !/^[0-9a-fA-F]{64}$/.test(overlay) || !values.identifier || !Number.isInteger(proximity)) {
  console.error('usage: pnpm mine --overlay <64 hex characters> --identifier <GSOC_IDENTIFIER> [--proximity 12]');
  process.exit(2);
}

// Mining is local arithmetic, so the Bee instance is never asked anything and its URL is never used.
const key = new Bee('http://localhost:1633').messaging.gsocMine(
  overlay,
  Identifier.fromString(values.identifier),
  proximity,
);
console.log(`GSOC_KEY=${key.toHex()}`);
console.log(`GSOC_IDENTIFIER=${values.identifier}`);
console.log(`owner address ${key.publicKey().address().toHex()}, proximity ${proximity}`);
