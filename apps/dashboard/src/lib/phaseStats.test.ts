import { describe, expect, it } from 'vitest';
import { PHASE_ORDER, median, summarizeSession } from '@surgeonpulse/core';
import type { SessionSummary } from '@surgeonpulse/core';
import { makeSession, withId } from '../test/fixtures';
import { MIN_COHORT_PARTICIPANTS, cohortPhaseMedians, phaseValues, sessionPhaseValue } from './phaseStats';

function summary(code: string, seed: number): SessionSummary {
  return summarizeSession(withId(makeSession({ seed, participantCode: code }), `${code}-${seed}`));
}

/** The first phase with a meanHrDelta in every given summary. */
function sharedPhase(summaries: readonly SessionSummary[]) {
  return PHASE_ORDER.find((p) => summaries.every((s) => sessionPhaseValue(s, p, 'meanHrDelta') !== null))!;
}

// PRIV-6: the feedback page's cohort median let a surgeon compute a colleague's exact values.
describe('cohortPhaseMedians', () => {
  it('shows nothing a viewer could invert when only one colleague is loaded', () => {
    const mine = summary('SP-001', 1);
    const theirs = summary('SP-002', 2);
    const phase = sharedPhase([mine, theirs]);
    const own = sessionPhaseValue(mine, phase, 'meanHrDelta')!;
    const actual = sessionPhaseValue(theirs, phase, 'meanHrDelta')!;
    // The old computation (median over everyone, viewer included) gave the colleague away exactly:
    const oldMedian = median(phaseValues([mine, theirs], 'meanHrDelta').get(phase)!)!;
    expect(2 * oldMedian - own).toBeCloseTo(actual, 9);

    const cohort = cohortPhaseMedians([mine, theirs], 'SP-001', 'meanHrDelta');
    for (const value of cohort.values()) expect(value.median).toBeNull();
    expect(cohort.get(phase)).toEqual({ median: null, participants: 1 });
  });

  it('uses other participants only, once enough of them contribute', () => {
    expect(MIN_COHORT_PARTICIPANTS).toBe(5);
    const mine = [summary('SP-001', 1), summary('SP-001', 11)];
    const others = [2, 3, 4, 5, 6].map((seed) => summary(`SP-00${seed}`, seed));
    const phase = sharedPhase([...mine, ...others]);
    const four = cohortPhaseMedians([...mine, ...others.slice(0, 4)], 'SP-001', 'meanHrDelta');
    expect(four.get(phase)).toEqual({ median: null, participants: 4 });

    const five = cohortPhaseMedians([...mine, ...others], 'SP-001', 'meanHrDelta');
    const expected = median(others.map((s) => sessionPhaseValue(s, phase, 'meanHrDelta')!));
    expect(five.get(phase)).toEqual({ median: expected, participants: 5 });
    // Several sessions of the same colleague still count as one participant.
    const repeated = [...others.slice(0, 4), summary('SP-002', 22), summary('SP-002', 23)];
    expect(cohortPhaseMedians(repeated, 'SP-001', 'meanHrDelta').get(phase)?.median).toBeNull();
  });
});
