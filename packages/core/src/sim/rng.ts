/**
 * Seeded pseudo-random numbers (and the few elementary functions the simulator needs) that are
 * **bit-for-bit reproducible on every JavaScript engine** SurgeonPulse runs on: Hermes (React Native),
 * V8 (Chrome, Edge, Node), JavaScriptCore (Safari, iOS web) and SpiderMonkey (Firefox).
 *
 * Why this matters: the same simulator seed must give byte-identical demo/test data on a phone, in the
 * dashboard and on the server (research reproducibility, shared fixtures).
 *
 * - {@link createRng} uses only 32-bit integer arithmetic (`Math.imul`, shifts, `>>> 0`), which ECMAScript
 *   defines exactly.
 * - `Math.exp`, `Math.log`, `Math.sin` and `Math.cos` are *implementation-approximated* in ECMA-262: their last
 *   bit legitimately differs between engines and C math libraries. {@link portableMath} re-implements the ones the
 *   simulator needs using only IEEE-754 `+ − × ÷` (correctly rounded by the ECMAScript spec), `Math.floor`,
 *   `Math.round` (exact) and `Math.sqrt` (correctly rounded on every IEEE-754 platform). The results agree with
 *   `Math.*` to within a few units in the last place but, unlike `Math.*`, are identical everywhere.
 *
 * Pure ES2022: no `Buffer`, `crypto`, DOM or Node built-ins.
 */

/** A source of uniform random numbers in `[0, 1)`. */
export type Rng = () => number;

const TWO_POW_32 = 4294967296;
const TWO_POW_MINUS_32 = 2.3283064365386963e-10;
/** 2^-53: the smallest `1 − u` that {@link gaussian} feeds to the logarithm (bounds |z| at ≈ 8.57). */
const MIN_UNIFORM = 1.1102230246251565e-16;

// fdlibm split of ln 2: LN2_HI has 32 trailing zero bits, so k·LN2_HI is exact for |k| < 2^20.
const LN2_HI = 6.9314718036912381649e-1;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700;
const SQRT2 = 1.4142135623730951;
const TWO_PI = 6.283185307179586;
/** exp(x) overflows above this. */
const EXP_MAX_ARG = 709.782712893384;
/** exp(x) underflows to 0 below this. */
const EXP_MIN_ARG = -745.1332191019412;

/**
 * Mulberry32 pseudo-random generator (Tommy Ettinger, 2017; public domain): a 32-bit state advanced by a Weyl
 * sequence and scrambled with two multiply–xorshift rounds. Period 2^32; fast, small and statistically adequate
 * for simulation, but **not** cryptographically secure (never use it for ids that must be unguessable).
 *
 * @param seed Any number. It is reduced to a 32-bit integer with ECMAScript ToInt32 (fraction dropped, modulo
 *   2^32; `NaN`/`±Infinity` become 0), so `createRng(1)` and `createRng(1 + 2 ** 32)` give the same stream.
 * @returns A function returning uniform numbers in `[0, 1)` with 32-bit resolution (each value is `k / 2^32`
 *   for an integer `k`). Identical sequence for the same seed on every engine.
 */
export function createRng(seed: number): Rng {
  let state = seed | 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / TWO_POW_32;
  };
}

/**
 * Standard normal deviate N(0, 1) by the Box–Muller transform (Box & Muller, 1958, "A note on the generation of
 * random normal deviates", Ann. Math. Statist. 29(2):610–611): `z = √(−2 ln u₁) · cos(2π u₂)`.
 *
 * Consumes exactly two values from `rng` per call (`u₁ = 1 − rng()` so that `u₁ ∈ (0, 1]`, then `u₂`),
 * which keeps random streams aligned and reproducible. Uses {@link portableMath} so the result is bit-identical across
 * engines. Always finite: |z| ≤ ≈ 8.57 even for a degenerate `rng`; never returns `-0`.
 */
export function gaussian(rng: Rng): number {
  let u1 = 1 - rng();
  if (!(u1 >= MIN_UNIFORM)) u1 = MIN_UNIFORM;
  else if (u1 > 1) u1 = 1;
  const u2 = rng();
  const z = Math.sqrt(-2 * portableLog(u1)) * portableCosTurns(Number.isFinite(u2) ? u2 : 0);
  return z === 0 ? 0 : z;
}

/** 2^k for an integer k, built from exact multiplications of powers of two. */
function pow2(k: number): number {
  let base = k < 0 ? 0.5 : 2;
  let e = k < 0 ? -k : k;
  let result = 1;
  while (e > 0) {
    if (e % 2 === 1) result *= base;
    e = Math.floor(e / 2);
    if (e > 0) base *= base;
  }
  return result;
}

/**
 * e^x: Cody–Waite reduction `x = k·ln2 + r` with `|r| ≤ ln2/2`, a degree-15 Taylor polynomial for e^r in Horner
 * form, then exact scaling by 2^k.
 */
function portableExp(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x > EXP_MAX_ARG) return Number.POSITIVE_INFINITY;
  if (x < EXP_MIN_ARG) return 0;
  const k = Math.round(x * INV_LN2);
  const r = x - k * LN2_HI - k * LN2_LO;
  let p = 1;
  for (let i = 15; i >= 1; i--) p = 1 + (r / i) * p;
  if (k > 1000) return p * pow2(k - 1000) * pow2(1000);
  if (k < -1000) return p * pow2(k + 1000) * pow2(-1000);
  return p * pow2(k);
}

/**
 * Natural logarithm: exact power-of-two normalisation `x = m·2^e` with `m ∈ [√½, √2]`, then
 * `ln m = 2·atanh(s)`, `s = (m − 1)/(m + 1)`, as an odd series to s^23 (|s| ≤ 0.172).
 */
function portableLog(x: number): number {
  if (Number.isNaN(x) || x < 0) return Number.NaN;
  if (x === 0) return Number.NEGATIVE_INFINITY;
  if (x === Number.POSITIVE_INFINITY) return x;
  let m = x;
  let e = 0;
  while (m >= TWO_POW_32) {
    m *= TWO_POW_MINUS_32;
    e += 32;
  }
  while (m < TWO_POW_MINUS_32) {
    m *= TWO_POW_32;
    e -= 32;
  }
  while (m >= 2) {
    m *= 0.5;
    e += 1;
  }
  while (m < 1) {
    m *= 2;
    e -= 1;
  }
  if (m > SQRT2) {
    m *= 0.5;
    e += 1;
  }
  const s = (m - 1) / (m + 1);
  const s2 = s * s;
  let p = 0;
  for (let k = 11; k >= 1; k--) p = 1 / (2 * k + 1) + s2 * p;
  const lnM = 2 * s + 2 * s * (s2 * p);
  return e * LN2_HI + (e * LN2_LO + lnM);
}

/**
 * sin(2π·turns) (or cos when `cosine`): reduce to the nearest quarter turn, so the remaining angle lies in
 * [−π/4, π/4], evaluate Taylor polynomials (sin to x^17, cos to x^18) and map the quadrant.
 */
function sinCosTurns(turns: number, cosine: boolean): number {
  if (!Number.isFinite(turns)) return Number.NaN;
  const f = turns - Math.floor(turns);
  const q = Math.round(f * 4);
  const x = (f - q * 0.25) * TWO_PI;
  const x2 = x * x;
  const quadrant = (cosine ? q + 1 : q) % 4;
  if (quadrant === 0 || quadrant === 2) {
    let s = 1;
    for (let k = 8; k >= 1; k--) s = 1 - (x2 / (2 * k * (2 * k + 1))) * s;
    const sinX = x * s;
    return quadrant === 0 ? sinX : -sinX;
  }
  let c = 1;
  for (let k = 9; k >= 1; k--) c = 1 - (x2 / ((2 * k - 1) * (2 * k))) * c;
  return quadrant === 1 ? c : -c;
}

/** sin(2π·turns), bit-identical on every engine. */
function portableSinTurns(turns: number): number {
  return sinCosTurns(turns, false);
}

/** cos(2π·turns), bit-identical on every engine. */
function portableCosTurns(turns: number): number {
  return sinCosTurns(turns, true);
}

/**
 * Engine-independent elementary functions used by the simulator (see the module comment for why `Math.exp`,
 * `Math.log`, `Math.sin` and `Math.cos` are avoided). Accurate to a few ULP; identical results everywhere.
 *
 * - `exp(x)`: e^x (`0` below ≈ −745.13, `Infinity` above ≈ 709.78, `NaN` for `NaN`).
 * - `log(x)`: natural logarithm (`-Infinity` at 0, `NaN` for negative or `NaN` input).
 * - `sinTurns(t)` / `cosTurns(t)`: sin(2π·t) / cos(2π·t) with the angle given in turns (cycles), which avoids an
 *   inexact multiplication by π in callers (e.g. a 0.25 Hz oscillation at time `s` seconds is `sinTurns(0.25·s)`).
 *   `NaN` for non-finite input.
 */
export const portableMath: Readonly<{
  exp: (x: number) => number;
  log: (x: number) => number;
  sinTurns: (turns: number) => number;
  cosTurns: (turns: number) => number;
}> = Object.freeze({
  exp: portableExp,
  log: portableLog,
  sinTurns: portableSinTurns,
  cosTurns: portableCosTurns,
});
