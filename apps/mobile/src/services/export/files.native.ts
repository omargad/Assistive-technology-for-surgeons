/**
 * File delivery — native (iOS / Android) implementation.
 *
 * Saving writes to the cache directory with the expo-file-system `File` /
 * `Paths` API and opens the system share sheet (AirDrop, Mail, Files, Drive…).
 * Export files from earlier shares that are more than an hour old are deleted
 * at the next export. Picking uses expo-document-picker, reads the copy it
 * makes in the cache, and then deletes that copy.
 */
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type * as WebFiles from './files';

export const MAX_IMPORT_BYTES: typeof WebFiles.MAX_IMPORT_BYTES = 100 * 1024 * 1024;

/** Every export file name starts with this (see `naming.ts`). */
const EXPORT_PREFIX = 'surgeonpulse-';
/**
 * Earlier exports older than this are removed from the cache at the next export. A file is not deleted
 * as soon as the share sheet closes because Android receivers (mail, Drive) may still be reading it.
 */
export const STALE_EXPORT_MS = 60 * 60 * 1000;

/**
 * Best effort: delete earlier export files (de-identified, but still study data) left in the cache
 * directory by previous shares. Never throws.
 */
export function removeStaleExports(now: number = Date.now(), keep?: string): number {
  let removed = 0;
  try {
    for (const entry of new Directory(Paths.cache).list()) {
      if (!(entry instanceof File) || !entry.name.startsWith(EXPORT_PREFIX) || entry.name === keep) continue;
      const modified = entry.lastModified;
      if (typeof modified === 'number' && now - modified < STALE_EXPORT_MS) continue;
      try {
        entry.delete();
        removed += 1;
      } catch {
        // in use or already gone
      }
    }
  } catch {
    // cache directory not listable: nothing to clean
  }
  return removed;
}

function uniformTypeIdentifier(mimeType: string): string | undefined {
  if (mimeType === 'application/json') return 'public.json';
  if (mimeType === 'text/csv') return 'public.comma-separated-values-text';
  return undefined;
}

export const deliverTextFile: typeof WebFiles.deliverTextFile = async (filename, text, mimeType) => {
  removeStaleExports(Date.now(), filename);
  const file = new File(Paths.cache, filename);
  try {
    if (file.exists) file.delete();
  } catch {
    // stale file we cannot remove: `create({ overwrite })` below handles it
  }
  file.create({ overwrite: true });
  await file.write(text);
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device.');
  }
  const uti = uniformTypeIdentifier(mimeType);
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: filename, ...(uti ? { UTI: uti } : {}) });
};

export const pickTextFile: typeof WebFiles.pickTextFile = async (accept) => {
  const types = accept
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.includes('/'));
  const result = await DocumentPicker.getDocumentAsync({
    // Android often labels JSON as application/octet-stream, so allow any file and validate the content.
    type: types.length > 0 ? [...types, '*/*'] : '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  if (asset.size !== undefined && asset.size > MAX_IMPORT_BYTES) {
    throw new Error('That file is too large to import.');
  }
  const picked = new File(asset.uri);
  try {
    return await picked.text();
  } catch {
    throw new Error('Could not read the selected file.');
  } finally {
    // The picker copied the file into the app's cache; do not keep a second copy of the user's data.
    try {
      if (picked.exists) picked.delete();
    } catch {
      // ignore
    }
  }
};
