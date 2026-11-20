/**
 * Data-quality flags shown on the Overview (SPEC: coverage < 80 % or RR
 * artefact > 5 %).
 */
import type { SessionSummary } from '@surgeonpulse/core';
import { fmtPercent } from './format';

/** Thresholds for the data-quality flags (SPEC). */
export const COVERAGE_FLAG = 0.8;
export const ARTEFACT_FLAG = 0.05;

export interface QualityFlag {
  summary: SessionSummary;
  reasons: string[];
}

/** Sessions with coverage < 80 % or RR artefact > 5 %. */
export function qualityFlags(summaries: readonly SessionSummary[]): QualityFlag[] {
  const out: QualityFlag[] = [];
  for (const s of summaries) {
    const reasons: string[] = [];
    if (s.quality.coverage < COVERAGE_FLAG) reasons.push(`coverage ${fmtPercent(s.quality.coverage)}`);
    const art = s.quality.rrArtifactRatio;
    if (art !== null && art > ARTEFACT_FLAG) reasons.push(`RR artefact ${fmtPercent(art, 1)}`);
    if (reasons.length > 0) out.push({ summary: s, reasons });
  }
  return out;
}
