/**
 * Correlation and OLS fit helpers for scatter plots, built on core
 * `pearsonCorrelation` and `linearTrend`.
 */
import { linearTrend, pearsonCorrelation } from '@surgeonpulse/core';
import type { LinearTrend } from '@surgeonpulse/core';

export interface ScatterFit {
  n: number;
  r: number | null;
  trend: LinearTrend | null;
}

/** OLS fit and Pearson r of the points (core statistics). */
export function fitPoints(points: readonly { x: number; y: number }[]): ScatterFit {
  const finite = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  return { n: finite.length, r: pearsonCorrelation(finite), trend: linearTrend(finite) };
}

/** Plain-language strength of a correlation coefficient. */
export function describeR(r: number | null): string {
  if (r === null) return 'not computable';
  const a = Math.abs(r);
  const strength = a < 0.1 ? 'negligible' : a < 0.3 ? 'weak' : a < 0.5 ? 'moderate' : 'strong';
  return `${strength} ${r >= 0 ? 'positive' : 'negative'}`;
}
