import { describe, expect, it, vi } from 'vitest';
import {
  REVOKE_DELAY_MS,
  UTF8_BOM,
  concatCsv,
  downloadBlob,
  downloadCsv,
  exportFilename,
  fileStamp,
  safeFilename,
  textBlob,
} from './download';
import type { DownloadEnv } from './download';

/** jsdom's Blob has no text()/arrayBuffer(); read it the old way (as Safari < 14 would). */
function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(blob);
  });
}

async function blobText(blob: Blob): Promise<string> {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await blobBytes(blob));
}

function fakeEnv() {
  const scheduled: { fn: () => void; ms: number }[] = [];
  const clicks: { href: string; download: string; attached: boolean }[] = [];
  const blobs: Blob[] = [];
  const env: DownloadEnv = {
    createObjectURL: vi.fn((blob: Blob) => {
      blobs.push(blob);
      return `blob:test/${blobs.length}`;
    }),
    revokeObjectURL: vi.fn(),
    document,
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return 0;
    },
  };
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push({ href: this.href, download: this.download, attached: document.body.contains(this) });
  });
  return { env, scheduled, clicks, blobs, click };
}

describe('downloadBlob', () => {
  it('clicks an attached anchor, removes it, and revokes the URL later', () => {
    const { env, scheduled, clicks } = fakeEnv();
    downloadBlob(new Blob(['x']), 'report.csv', env);
    expect(clicks).toEqual([{ href: 'blob:test/1', download: 'report.csv', attached: true }]);
    expect(document.querySelectorAll('a').length).toBe(0);
    expect(env.revokeObjectURL).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(REVOKE_DELAY_MS);
    scheduled[0]!.fn();
    expect(env.revokeObjectURL).toHaveBeenCalledWith('blob:test/1');
  });

  it('sanitises the filename', () => {
    const { env, clicks } = fakeEnv();
    downloadBlob(new Blob(['x']), 'SP 001/../evil:name?.csv', env);
    expect(clicks[0]!.download).toBe('SP-001-.-evil-name-.csv');
  });

  it('downloads CSV as UTF-8 text, optionally with a BOM for Excel', async () => {
    const { env, blobs } = fakeEnv();
    downloadCsv('a,b\r\n1,2\r\n', 'x.csv', {}, env);
    downloadCsv('a,b\r\n', 'y.csv', { bom: true }, env);
    expect(blobs[0]!.type).toBe('text/csv;charset=utf-8');
    expect(await blobText(blobs[0]!)).toBe('a,b\r\n1,2\r\n');
    const bytes = await blobBytes(blobs[1]!);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe('textBlob', () => {
  it('prepends the BOM only when asked', async () => {
    expect(await blobText(textBlob('x', 'text/plain'))).toBe('x');
    const withBom = await blobBytes(textBlob('x', 'text/plain', { bom: true }));
    expect(withBom.length).toBe(4);
    expect(UTF8_BOM).toBe('﻿');
  });
});

describe('concatCsv', () => {
  it('keeps one header and appends the rows of each part', () => {
    const a = 'id,v\r\n1,a\r\n2,b\r\n';
    const b = 'id,v\r\n3,c\r\n';
    expect(concatCsv([a, b])).toBe('id,v\r\n1,a\r\n2,b\r\n3,c\r\n');
  });

  it('skips empty and header-only parts', () => {
    expect(concatCsv(['', 'id,v\r\n', 'id,v\r\n1,a\r\n', ''])).toBe('id,v\r\n1,a\r\n');
    expect(concatCsv([])).toBe('');
    expect(concatCsv(['id,v'])).toBe('id,v\r\n');
  });

  it('handles LF line endings and missing trailing newlines', () => {
    expect(concatCsv(['h\n1', 'h\n2'])).toBe('h\n1\n2\n');
  });
});

describe('filenames', () => {
  it('produces portable names', () => {
    expect(safeFilename('Résumé café.csv')).toBe('Resume-cafe.csv');
    expect(safeFilename('...hidden')).toBe('hidden');
    expect(safeFilename('***')).toBe('download');
    expect(safeFilename('a'.repeat(300)).length).toBe(120);
  });

  it('stamps files in UTC', () => {
    const d = new Date(Date.UTC(2026, 10, 20, 8, 5));
    expect(fileStamp(d)).toBe('20261120-0805');
    expect(exportFilename('summaries', 'csv', d)).toBe('surgeonpulse-summaries-20261120-0805.csv');
  });
});
