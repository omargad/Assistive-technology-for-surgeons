import { describe, expect, it } from 'vitest';
import { createExportBundle } from '@surgeonpulse/core';
import { makeSession, withId } from '../test/fixtures';
import { importFiles, readFileText } from './files';
import type { ReadableFile } from './files';

function file(name: string, text: string): ReadableFile {
  return { name, size: text.length, text: async () => text };
}

const s1 = withId(makeSession({ seed: 1, participantCode: 'SP-001' }), 'session-1');
const s2 = withId(makeSession({ seed: 2, participantCode: 'SP-002' }), 'session-2');

describe('importFiles', () => {
  it('merges bundles, single sessions and arrays; later files win', async () => {
    const bundle = createExportBundle({
      sessions: [s1, s2],
      participants: [{ code: 'SP-001', trainingLevel: 'fellow' }],
      now: 0,
    });
    const s1b = { ...s1, procedure: { ...s1.procedure, name: 'Renamed' } };
    const result = await importFiles([
      file('bundle.json', JSON.stringify(bundle)),
      file('single.json', JSON.stringify(s1b)),
    ]);
    expect(result.sessions.map((s) => s.id).sort()).toEqual(['session-1', 'session-2']);
    expect(result.sessions.find((s) => s.id === 'session-1')!.procedure.name).toBe('Renamed');
    expect(result.participants.find((p) => p.code === 'SP-001')).toMatchObject({ trainingLevel: 'fellow' });
    expect(result.loadedFiles).toEqual(['bundle.json', 'single.json']);
    expect(result.warnings.some((w) => w.includes('replaced an earlier copy'))).toBe(true);
    expect(result.deidentified).toBe(false);
  });

  it('skips unreadable files and reports per-session problems with the file name', async () => {
    const bad = { ...s2, samples: 'nope' };
    const result = await importFiles([
      file('broken.json', '{ not json'),
      file('mixed.json', JSON.stringify([s1, bad])),
      file('empty.json', '[]'),
    ]);
    expect(result.sessions.map((s) => s.id)).toEqual(['session-1']);
    expect(result.loadedFiles).toEqual(['mixed.json']);
    expect(result.warnings.find((w) => w.startsWith('broken.json'))).toMatch(/could not be imported/);
    expect(result.warnings.some((w) => w.startsWith('mixed.json:'))).toBe(true);
    expect(result.warnings.find((w) => w.startsWith('empty.json'))).toMatch(/no sessions/);
  });

  it('reads files with FileReader when Blob.text is unavailable', async () => {
    const blob = new Blob(['{"hello":1}'], { type: 'application/json' });
    const legacy = Object.assign(blob, { name: 'x.json', text: undefined }) as unknown as ReadableFile;
    expect(await readFileText(legacy)).toBe('{"hello":1}');
  });
});
