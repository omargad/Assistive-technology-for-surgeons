/**
 * Identifier generation.
 *
 * This is one of the two places in the library allowed to use a source of
 * randomness (SPEC.md › Ground rules). Everything else takes ids/clocks/seeds
 * as parameters.
 */

/**
 * The subset of the Web Crypto API we use. Declared locally because the
 * library is compiled without DOM or Node type libraries (it must run on
 * Hermes, browsers and Node alike).
 */
interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: <T extends Uint8Array>(array: T) => T;
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));

function getCrypto(): CryptoLike | undefined {
  // `globalThis.crypto` exists in browsers, Node ≥ 19 and React Native with a
  // `react-native-get-random-values` / `expo-crypto` polyfill; plain Hermes has none.
  const c = (globalThis as { crypto?: unknown }).crypto;
  return typeof c === 'object' && c !== null ? (c as CryptoLike) : undefined;
}

function randomBytes16(crypto: CryptoLike | undefined): Uint8Array {
  const bytes = new Uint8Array(16);
  if (crypto && typeof crypto.getRandomValues === 'function') {
    try {
      // Must be called as a method: browsers throw "Illegal invocation" otherwise.
      crypto.getRandomValues(bytes);
      return bytes;
    } catch {
      // Fall through to Math.random (e.g. a polyfill that throws when not seeded).
    }
  }
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256) & 0xff;
  return bytes;
}

/**
 * Format 16 random bytes as an RFC 4122 §4.4 version-4 UUID
 * (`xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`, y ∈ {8,9,a,b}).
 */
function formatUuidV4(bytes: Uint8Array): string {
  const b = Array.from(bytes, (x) => x & 0xff);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40; // version 4
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant (10xx)
  const h = b.map((x) => HEX[x] ?? '00');
  return (
    h.slice(0, 4).join('') +
    '-' +
    h.slice(4, 6).join('') +
    '-' +
    h.slice(6, 8).join('') +
    '-' +
    h.slice(8, 10).join('') +
    '-' +
    h.slice(10, 16).join('')
  );
}

/**
 * Create a new random identifier: an RFC 4122 version-4 UUID in lowercase
 * canonical form, e.g. `"3b241101-e2bb-4255-8caf-4136c566a962"`.
 *
 * Source of randomness, in order of preference (SPEC.md › util/id.ts):
 * 1. `globalThis.crypto.randomUUID()` (browsers in secure contexts, Node ≥ 19);
 * 2. `globalThis.crypto.getRandomValues()` (older browsers, RN polyfills);
 * 3. `Math.random()` (bare Hermes). Not cryptographically secure, but ids are
 *    only used as record keys, never as secrets.
 *
 * The result is always validated, so a misbehaving polyfill cannot leak a
 * non-UUID string into persisted data.
 */
export function createId(): string {
  const crypto = getCrypto();
  if (crypto && typeof crypto.randomUUID === 'function') {
    try {
      const id = String(crypto.randomUUID()).toLowerCase();
      if (UUID_V4_RE.test(id)) return id;
    } catch {
      // Some environments expose randomUUID but throw outside secure contexts.
    }
  }
  return formatUuidV4(randomBytes16(crypto));
}
