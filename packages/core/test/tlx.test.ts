import { describe, expect, it } from 'vitest';
import { NASA_TLX_DIMENSIONS, SURG_TLX_DIMENSIONS, scoreWorkload, tlxPairs } from '../src/instruments/tlx';
import type { NasaTlxResponse, SurgTlxDimension, SurgTlxResponse } from '../src/types';

const ratings: Record<SurgTlxDimension, number> = {
  mental: 50,
  physical: 20,
  temporal: 40,
  complexity: 60,
  stress: 30,
  distraction: 10,
};

function surg(r: Record<SurgTlxDimension, number>, weights?: Record<SurgTlxDimension, number>): SurgTlxResponse {
  return { instrument: 'surg-tlx', ratings: r, completedAt: 0, ...(weights ? { weights } : {}) };
}

describe('SURG_TLX_DIMENSIONS (Wilson et al., 2011)', () => {
  it('lists the six dimensions in order with their labels', () => {
    expect(SURG_TLX_DIMENSIONS.map((d) => [d.id, d.label])).toEqual([
      ['mental', 'Mental Demands'],
      ['physical', 'Physical Demands'],
      ['temporal', 'Temporal Demands'],
      ['complexity', 'Task Complexity'],
      ['stress', 'Situational Stress'],
      ['distraction', 'Distractions'],
    ]);
  });

  it('uses the SURG-TLX question wording', () => {
    const q = Object.fromEntries(SURG_TLX_DIMENSIONS.map((d) => [d.id, d.question.toLowerCase()]));
    expect(q.mental).toContain('how mentally fatiguing');
    expect(q.physical).toContain('how physically fatiguing');
    expect(q.temporal).toContain('how hurried or rushed was the pace');
    expect(q.complexity).toContain('how complex was the procedure');
    expect(q.stress).toContain('how anxious did you feel while performing');
    expect(q.distraction).toContain('how distracting was the operating environment');
  });

  it('has low/high anchors for every dimension', () => {
    for (const d of SURG_TLX_DIMENSIONS) {
      expect(d.low.length).toBeGreaterThan(0);
      expect(d.high.length).toBeGreaterThan(0);
    }
  });
});

describe('NASA_TLX_DIMENSIONS (Hart & Staveland, 1988)', () => {
  it('lists the six dimensions with the inverted performance anchors', () => {
    expect(NASA_TLX_DIMENSIONS.map((d) => d.id)).toEqual([
      'mental',
      'physical',
      'temporal',
      'performance',
      'effort',
      'frustration',
    ]);
    const perf = NASA_TLX_DIMENSIONS.find((d) => d.id === 'performance')!;
    expect(perf.low).toBe('Perfect');
    expect(perf.high).toBe('Failure');
  });
});

describe('tlxPairs', () => {
  it('returns the 15 unordered pairs in a fixed order', () => {
    const pairs = tlxPairs('surg-tlx');
    expect(pairs).toHaveLength(15);
    expect(pairs[0]).toEqual(['mental', 'physical']);
    expect(pairs[4]).toEqual(['mental', 'distraction']);
    expect(pairs[5]).toEqual(['physical', 'temporal']);
    expect(pairs[14]).toEqual(['stress', 'distraction']);
    const keys = new Set(pairs.map((p) => [...p].sort().join('|')));
    expect(keys.size).toBe(15);
    expect(tlxPairs('surg-tlx')).toEqual(pairs);
  });
  it('uses the NASA-TLX dimensions for nasa-tlx', () => {
    const pairs = tlxPairs('nasa-tlx');
    expect(pairs).toHaveLength(15);
    expect(pairs[14]).toEqual(['effort', 'frustration']);
  });
});

describe('scoreWorkload', () => {
  it('computes the raw score as the mean of the six ratings', () => {
    // (50 + 20 + 40 + 60 + 30 + 10) / 6 = 35
    const s = scoreWorkload(surg(ratings));
    expect(s).toEqual({ instrument: 'surg-tlx', raw: 35, weighted: null, dimensions: ratings });
  });

  it('computes the weighted score Σ(rating·weight)/15 with valid weights', () => {
    // weights 5,0,3,4,2,1 (Σ 15): 250 + 0 + 120 + 240 + 60 + 10 = 680 → 680/15 = 45.33
    const s = scoreWorkload(
      surg(ratings, { mental: 5, physical: 0, temporal: 3, complexity: 4, stress: 2, distraction: 1 }),
    );
    expect(s.raw).toBe(35);
    expect(s.weighted).toBeCloseTo(680 / 15, 12);
  });

  it('returns weighted = null for invalid weights', () => {
    const base = { mental: 5, physical: 0, temporal: 3, complexity: 4, stress: 2, distraction: 1 };
    expect(scoreWorkload(surg(ratings, { ...base, distraction: 0 })).weighted).toBeNull(); // Σ 14
    expect(scoreWorkload(surg(ratings, { ...base, stress: 1.5, distraction: 1.5 })).weighted).toBeNull(); // non-integer
    expect(scoreWorkload(surg(ratings, { ...base, mental: 6, physical: -1 })).weighted).toBeNull(); // out of 0–5
    const missing = { ...base } as Partial<typeof base>;
    delete missing.distraction;
    expect(scoreWorkload(surg(ratings, missing as typeof base)).weighted).toBeNull();
  });

  it('clamps ratings to [0, 100] and reports the clamped values', () => {
    const s = scoreWorkload(surg({ ...ratings, mental: 120, physical: -10 }));
    expect(s.dimensions.mental).toBe(100);
    expect(s.dimensions.physical).toBe(0);
    // (100 + 0 + 40 + 60 + 30 + 10) / 6 = 40
    expect(s.raw).toBe(40);
  });

  it('never returns NaN for a missing rating', () => {
    const broken = { ...ratings } as Partial<typeof ratings>;
    delete broken.stress;
    const s = scoreWorkload(surg(broken as typeof ratings));
    expect(s.dimensions.stress).toBe(0);
    expect(s.raw).toBe(30); // (50 + 20 + 40 + 60 + 0 + 10) / 6
  });

  it('scores NASA-TLX responses', () => {
    const resp: NasaTlxResponse = {
      instrument: 'nasa-tlx',
      ratings: { mental: 70, physical: 10, temporal: 50, performance: 30, effort: 60, frustration: 20 },
      weights: { mental: 5, physical: 0, temporal: 2, performance: 3, effort: 4, frustration: 1 },
      completedAt: 0,
    };
    const s = scoreWorkload(resp);
    expect(s.instrument).toBe('nasa-tlx');
    expect(s.raw).toBe(40); // 240 / 6
    // 350 + 0 + 100 + 90 + 240 + 20 = 800 → 800/15
    expect(s.weighted).toBeCloseTo(800 / 15, 12);
    expect(Object.keys(s.dimensions)).toEqual(['mental', 'physical', 'temporal', 'performance', 'effort', 'frustration']);
  });
});
