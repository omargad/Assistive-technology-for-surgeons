import { describe, expect, it } from 'vitest';
import { createRng, gaussian, portableMath } from '../src/sim/rng';

/** Mulberry32 exactly as published (state kept as a plain JS number, not truncated). */
function mulberry32Reference(seed: number): () => number {
  let a = seed;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function take(rng: () => number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(rng());
  return out;
}

describe('createRng (mulberry32)', () => {
  it('matches the reference mulberry32 implementation', () => {
    for (const seed of [0, 1, 42, 123456789, -7, 2147483647]) {
      expect(take(createRng(seed), 5000)).toEqual(take(mulberry32Reference(seed), 5000));
    }
  });

  it('produces pinned values (bit-identical on every engine)', () => {
    expect(take(createRng(1), 5)).toEqual([
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741, 0.9683778982143849,
    ]);
    expect(take(createRng(42), 3)).toEqual([0.6011037519201636, 0.44829055899754167, 0.8524657934904099]);
  });

  it('is deterministic per seed and differs between seeds', () => {
    expect(take(createRng(99), 100)).toEqual(take(createRng(99), 100));
    expect(take(createRng(1), 100)).not.toEqual(take(createRng(2), 100));
  });

  it('reduces the seed with ToInt32', () => {
    expect(take(createRng(1.9), 10)).toEqual(take(createRng(1), 10));
    expect(take(createRng(5 + 2 ** 32), 10)).toEqual(take(createRng(5), 10));
    expect(take(createRng(Number.NaN), 10)).toEqual(take(createRng(0), 10));
    expect(take(createRng(Number.POSITIVE_INFINITY), 10)).toEqual(take(createRng(0), 10));
  });

  it('returns uniform values in [0, 1) with 32-bit resolution', () => {
    const rng = createRng(2024);
    const n = 200000;
    const bins = new Array<number>(10).fill(0);
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const u = rng();
      expect(u >= 0 && u < 1).toBe(true);
      if (i < 1000) expect(Number.isInteger(u * 4294967296)).toBe(true);
      sum += u;
      sumSq += u * u;
      bins[Math.floor(u * 10)]! += 1;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    expect(mean).toBeCloseTo(0.5, 2);
    expect(Math.abs(variance - 1 / 12)).toBeLessThan(0.002);
    const expected = n / 10;
    const chi2 = bins.reduce((acc, c) => acc + (c - expected) ** 2 / expected, 0);
    expect(chi2).toBeLessThan(30); // df = 9, p ≈ 0.0005
  });
});

describe('gaussian (Box–Muller)', () => {
  it('has standard-normal moments', () => {
    const rng = createRng(7);
    const n = 200000;
    let sum = 0;
    let sumSq = 0;
    let sum3 = 0;
    let sum4 = 0;
    let within196 = 0;
    for (let i = 0; i < n; i++) {
      const z = gaussian(rng);
      sum += z;
      sumSq += z * z;
      sum3 += z ** 3;
      sum4 += z ** 4;
      if (Math.abs(z) < 1.959964) within196++;
    }
    const mean = sum / n;
    const sd = Math.sqrt(sumSq / n - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(Math.abs(sd - 1)).toBeLessThan(0.01);
    expect(Math.abs(sum3 / n)).toBeLessThan(0.03);
    expect(Math.abs(sum4 / n - 3)).toBeLessThan(0.08);
    expect(Math.abs(within196 / n - 0.95)).toBeLessThan(0.003);
  });

  it('implements z = sqrt(-2 ln u1) cos(2π u2) with u1 = 1 − rng()', () => {
    for (const [a, b] of [
      [0.1, 0.2],
      [0.5, 0.75],
      [0.99, 0.01],
      [0.3, 0.9],
    ] as const) {
      const draws = [a, b];
      const z = gaussian(() => draws.shift()!);
      const expected = Math.sqrt(-2 * Math.log(1 - a)) * Math.cos(2 * Math.PI * b);
      expect(Math.abs(z - expected)).toBeLessThan(1e-12);
    }
  });

  it('consumes exactly two uniforms per call', () => {
    let calls = 0;
    const base = createRng(3);
    const counting = () => {
      calls++;
      return base();
    };
    for (let i = 0; i < 50; i++) gaussian(counting);
    expect(calls).toBe(100);
  });

  it('produces pinned values (bit-identical on every engine)', () => {
    const rng = createRng(1);
    expect([gaussian(rng), gaussian(rng), gaussian(rng)]).toEqual([
      1.4043387784152637, 1.2157546192705377, -0.5103768768108126,
    ]);
  });

  it('stays finite and never returns -0, even for degenerate generators', () => {
    for (const value of [0, 0.9999999999999999, 1, 1.5, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const z = gaussian(() => value);
      expect(Number.isFinite(z)).toBe(true);
      expect(Math.abs(z)).toBeLessThan(8.6);
      expect(Object.is(z, -0)).toBe(false);
    }
  });
});

describe('portableMath', () => {
  it('exp agrees with Math.exp to ~1 ulp', () => {
    let maxRel = 0;
    for (let x = -60; x <= 60; x += 0.0137) {
      const a = portableMath.exp(x);
      const b = Math.exp(x);
      maxRel = Math.max(maxRel, Math.abs(a - b) / b);
    }
    expect(maxRel).toBeLessThan(1e-15);
    expect(portableMath.exp(0)).toBe(1);
    expect(portableMath.exp(-1000)).toBe(0);
    expect(portableMath.exp(1000)).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(portableMath.exp(Number.NaN))).toBe(true);
    // Subnormal / near-overflow ranges still scale exactly.
    expect(Math.abs(portableMath.exp(-740) / Math.exp(-740) - 1)).toBeLessThan(1e-3);
    expect(Math.abs(portableMath.exp(709) / Math.exp(709) - 1)).toBeLessThan(1e-14);
  });

  it('log agrees with Math.log to ~1 ulp over the whole double range', () => {
    let maxErr = 0;
    for (let i = 1; i <= 100000; i++) {
      const x = i / 100000;
      maxErr = Math.max(maxErr, Math.abs(portableMath.log(x) - Math.log(x)) / Math.max(1, Math.abs(Math.log(x))));
    }
    for (let e = -300; e <= 300; e += 0.37) {
      const x = 10 ** e;
      maxErr = Math.max(maxErr, Math.abs(portableMath.log(x) - Math.log(x)) / Math.max(1, Math.abs(Math.log(x))));
    }
    expect(maxErr).toBeLessThan(1e-15);
    expect(portableMath.log(1)).toBe(0);
    expect(portableMath.log(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(portableMath.log(-1))).toBe(true);
    expect(portableMath.log(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(Math.abs(portableMath.log(Number.MIN_VALUE) - Math.log(Number.MIN_VALUE))).toBeLessThan(1e-12);
  });

  it('sinTurns / cosTurns agree with Math.sin / Math.cos of 2π·t', () => {
    let maxErr = 0;
    for (let t = -3; t <= 3; t += 0.000731) {
      maxErr = Math.max(
        maxErr,
        Math.abs(portableMath.sinTurns(t) - Math.sin(2 * Math.PI * t)),
        Math.abs(portableMath.cosTurns(t) - Math.cos(2 * Math.PI * t)),
      );
    }
    expect(maxErr).toBeLessThan(5e-15);
    expect(portableMath.sinTurns(0)).toBe(0);
    expect(portableMath.sinTurns(0.25)).toBe(1);
    expect(portableMath.sinTurns(0.75)).toBe(-1);
    expect(portableMath.cosTurns(0)).toBe(1);
    expect(portableMath.cosTurns(0.5)).toBe(-1);
    expect(portableMath.sinTurns(1234.25)).toBe(1);
    expect(Number.isNaN(portableMath.sinTurns(Number.POSITIVE_INFINITY))).toBe(true);
  });

  it('produces pinned values (bit-identical on every engine)', () => {
    expect(portableMath.exp(1)).toBe(2.7182818284590455);
    expect(portableMath.exp(-1 / 45)).toBe(0.9780228724846005);
    expect(portableMath.log(2)).toBe(0.6931471805599453);
    expect(portableMath.log(0.3)).toBe(-1.2039728043259361);
    expect(portableMath.sinTurns(0.1)).toBe(0.5877852522924731);
    expect(portableMath.cosTurns(0.3)).toBe(-0.30901699437494734);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(portableMath)).toBe(true);
  });
});
