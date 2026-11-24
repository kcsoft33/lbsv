/** Minimal ULID generator (26 chars, Crockford base32, time-sortable). Works in Node and browsers. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i]! % 32];
  return time + rand;
}
