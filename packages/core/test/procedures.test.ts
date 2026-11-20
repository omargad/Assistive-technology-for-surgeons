import { describe, expect, it } from 'vitest';
import { PROCEDURE_CATALOG, PROCEDURE_SPECIALTIES, findProcedure } from '../src/catalog/procedures';
import { APPROACH_LABELS } from '../src/presentation/labels';

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('PROCEDURE_CATALOG', () => {
  it('has at least 40 procedures', () => {
    expect(PROCEDURE_CATALOG.length).toBeGreaterThanOrEqual(40);
  });

  it('uses unique, stable kebab-case ids and unique non-empty names', () => {
    const ids = PROCEDURE_CATALOG.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(KEBAB);
    const names = PROCEDURE_CATALOG.map((p) => p.name.trim());
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.length).toBeGreaterThan(0);
  });

  it('keeps well-known ids stable (they are persisted in sessions)', () => {
    for (const id of [
      'laparoscopic-cholecystectomy',
      'laparoscopic-appendicectomy',
      'laparoscopic-right-hemicolectomy',
      'pancreaticoduodenectomy',
      'robotic-radical-prostatectomy',
      'total-laparoscopic-hysterectomy',
      'total-hip-arthroplasty',
      'carotid-endarterectomy',
      'cabg',
      'lumbar-microdiscectomy',
      'tonsillectomy',
      'carpal-tunnel-release',
      'pyloromyotomy',
    ]) {
      expect(findProcedure(id)?.id, id).toBe(id);
    }
  });

  it('covers every listed specialty, and only those', () => {
    const required = [
      'General surgery',
      'Colorectal surgery',
      'Upper GI & HPB surgery',
      'Urology',
      'Gynaecology',
      'Orthopaedics',
      'Vascular surgery',
      'Cardiothoracic surgery',
      'Neurosurgery',
      'ENT',
      'Plastic surgery',
      'Paediatric surgery',
    ];
    expect([...PROCEDURE_SPECIALTIES]).toEqual(required);
    for (const specialty of required) {
      expect(PROCEDURE_CATALOG.filter((p) => p.specialty === specialty).length, specialty).toBeGreaterThanOrEqual(3);
    }
    for (const p of PROCEDURE_CATALOG) expect(required).toContain(p.specialty);
  });

  it('uses only valid approaches', () => {
    const approaches = Object.keys(APPROACH_LABELS);
    for (const p of PROCEDURE_CATALOG) {
      if (p.defaultApproach !== undefined) expect(approaches, p.id).toContain(p.defaultApproach);
    }
  });

  it('is frozen so the shared catalogue cannot be modified at runtime', () => {
    expect(Object.isFrozen(PROCEDURE_CATALOG)).toBe(true);
    expect(Object.isFrozen(PROCEDURE_CATALOG[0])).toBe(true);
    expect(() => {
      (PROCEDURE_CATALOG as unknown as { name: string }[])[0]!.name = 'x';
    }).toThrow(TypeError);
  });
});

describe('findProcedure', () => {
  it('finds entries by exact id', () => {
    expect(findProcedure('evar')).toEqual({
      id: 'evar',
      name: 'Endovascular aneurysm repair (EVAR)',
      specialty: 'Vascular surgery',
      defaultApproach: 'percutaneous',
    });
  });

  it('returns undefined for unknown or differently-cased ids', () => {
    expect(findProcedure('no-such-thing')).toBeUndefined();
    expect(findProcedure('EVAR')).toBeUndefined();
    expect(findProcedure('')).toBeUndefined();
    expect(findProcedure('constructor')).toBeUndefined();
  });
});
