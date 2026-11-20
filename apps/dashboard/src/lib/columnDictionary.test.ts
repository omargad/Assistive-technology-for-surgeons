import { describe, expect, it } from 'vitest';
import { parseCsv, summariesToCsv } from '@surgeonpulse/core';
import { describeColumn, summaryColumnDictionary } from './columnDictionary';

describe('summary CSV column dictionary', () => {
  it('describes every column core writes, in order', () => {
    const header = parseCsv(summariesToCsv([]))[0]!;
    const dict = summaryColumnDictionary();
    expect(dict.map((c) => c.column)).toEqual(header);
    for (const c of dict) expect(c.description).not.toBe('See the SurgeonPulse core documentation.');
  });

  it('describes per-phase columns', () => {
    expect(describeColumn('critical_hr_delta')).toMatchObject({ unit: 'bpm' });
    expect(describeColumn('pre_op_duration_s').description).toContain('pre-op');
    expect(describeColumn('mystery').description).toContain('documentation');
  });
});
