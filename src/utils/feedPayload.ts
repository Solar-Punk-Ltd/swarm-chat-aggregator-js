/**
 * The state list as it goes onto the feed. bee-js decides whether a payload needs wrapping into a
 * root chunk by looking at `.length` of what it is handed: for a string that is a character count,
 * for bytes it is the byte count, and the 4096 limit Bee enforces is bytes. A list with a few
 * multi-byte characters (em dashes, accented names) can be under 4096 characters yet over 4096
 * bytes, and a string would then slip past the wrap and fail the chunk build. Always hand bee-js
 * bytes.
 */
export function encodeStatePayload(state: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(state));
}
