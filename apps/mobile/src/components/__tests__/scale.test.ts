/// <reference types="jest" />
import { linearScale, niceDomain, tickSpacingPx, topTickPx } from '../charts/scale';

describe('axis helpers', () => {
  // A 0–200 px plot (SVG y grows downwards) for a 60–100 bpm domain.
  const domain = niceDomain(62, 98, 4);
  const y = linearScale(domain.min, domain.max, 200, 0);

  it('measures the pixel spacing between adjacent ticks', () => {
    expect(domain.ticks).toEqual([60, 70, 80, 90, 100]);
    expect(tickSpacingPx(domain.ticks, y)).toBeCloseTo(50);
  });

  it('returns 0 spacing for fewer than two ticks', () => {
    expect(tickSpacingPx([80], y)).toBe(0);
    expect(tickSpacingPx([], y)).toBe(0);
  });

  it('locates the top tick, falling back when there are no ticks', () => {
    expect(topTickPx(domain.ticks, y, 12)).toBeCloseTo(0);
    expect(topTickPx([], y, 12)).toBe(12);
  });
});
