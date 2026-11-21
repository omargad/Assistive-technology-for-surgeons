/// <reference types="jest" />
/**
 * Native file delivery: earlier exports are swept from the cache (PRIV-1 leftover) and the picker's
 * cached copy of an imported file is deleted after it is read.
 */
const mockEntries: MockFile[] = [];
const mockCreated: MockFile[] = [];

class MockFile {
  name: string;
  uri: string;
  exists = true;
  lastModified: number | null;
  deleted = false;
  written = '';
  constructor(dirOrUri: unknown, name?: string, lastModified: number | null = null) {
    this.name = name ?? String(dirOrUri).split('/').pop() ?? '';
    this.uri = name ? `file:///cache/${name}` : String(dirOrUri);
    this.lastModified = lastModified;
    mockCreated.push(this);
  }
  delete() {
    this.deleted = true;
    this.exists = false;
  }
  create() {
    this.exists = true;
  }
  async write(text: string) {
    this.written = text;
  }
  async text() {
    if (this.uri.includes('unreadable')) throw new Error('io');
    return '{"sessions":[]}';
  }
}
class MockDirectory {
  list() {
    return mockEntries;
  }
}

// Getters: the factory runs when the module under test is imported, before the classes above are initialised.
jest.mock('expo-file-system', () => ({
  get File() {
    return MockFile;
  },
  get Directory() {
    return MockDirectory;
  },
  Paths: { cache: 'file:///cache' },
}));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => true), shareAsync: jest.fn(async () => undefined) }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { STALE_EXPORT_MS, deliverTextFile, pickTextFile, removeStaleExports } from '../files.native';

const NOW = Date.UTC(2026, 10, 21, 9, 0);

beforeEach(() => {
  mockEntries.length = 0;
  mockCreated.length = 0;
  jest.clearAllMocks();
});

describe('removeStaleExports', () => {
  it('deletes only earlier SurgeonPulse exports older than an hour', () => {
    const old = new MockFile('file:///cache', 'surgeonpulse-SP-001-20261120-0900.json', NOW - STALE_EXPORT_MS - 1);
    const recent = new MockFile('file:///cache', 'surgeonpulse-SP-001-20261121-0850.csv', NOW - 10 * 60_000);
    const unknownAge = new MockFile('file:///cache', 'surgeonpulse-SP-001-20261101-0900.csv', null);
    const other = new MockFile('file:///cache', 'something-else.json', NOW - 10 * STALE_EXPORT_MS);
    const kept = new MockFile('file:///cache', 'surgeonpulse-SP-001-20261121-0900.json', NOW - 10 * STALE_EXPORT_MS);
    mockEntries.push(old, recent, unknownAge, other, kept);
    expect(removeStaleExports(NOW, 'surgeonpulse-SP-001-20261121-0900.json')).toBe(2);
    expect(old.deleted).toBe(true);
    expect(unknownAge.deleted).toBe(true);
    expect(recent.deleted).toBe(false);
    expect(other.deleted).toBe(false);
    expect(kept.deleted).toBe(false);
  });

  it('never throws when the cache cannot be listed', () => {
    const spy = jest.spyOn(MockDirectory.prototype, 'list').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(removeStaleExports(NOW)).toBe(0);
    spy.mockRestore();
  });
});

describe('deliverTextFile', () => {
  it('sweeps stale exports, writes the file and opens the share sheet', async () => {
    const old = new MockFile('file:///cache', 'surgeonpulse-SP-001-20250101-0900.json', 1);
    mockEntries.push(old);
    await deliverTextFile('surgeonpulse-SP-001-20261121-0900.csv', 'a,b\r\n', 'text/csv');
    expect(old.deleted).toBe(true);
    const written = mockCreated.find((f) => f.name === 'surgeonpulse-SP-001-20261121-0900.csv' && f.written !== '');
    expect(written?.written).toBe('a,b\r\n');
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/surgeonpulse-SP-001-20261121-0900.csv', expect.objectContaining({ mimeType: 'text/csv' }));
  });
});

describe('pickTextFile', () => {
  it('deletes the picker copy after reading it', async () => {
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///cache/DocumentPicker/export.json', size: 10 }],
    });
    await expect(pickTextFile('.json,application/json')).resolves.toBe('{"sessions":[]}');
    expect(mockCreated.find((f) => f.uri === 'file:///cache/DocumentPicker/export.json')?.deleted).toBe(true);
  });

  it('still deletes the copy when it cannot be read', async () => {
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///cache/DocumentPicker/unreadable.json', size: 10 }],
    });
    await expect(pickTextFile('.json')).rejects.toThrow('Could not read the selected file.');
    expect(mockCreated.find((f) => f.uri.endsWith('unreadable.json'))?.deleted).toBe(true);
  });
});
