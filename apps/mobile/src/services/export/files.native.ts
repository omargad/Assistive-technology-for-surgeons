/**
 * File delivery — native (iOS / Android) implementation.
 *
 * Saving writes to the cache directory with the expo-file-system `File` /
 * `Paths` API and opens the system share sheet (AirDrop, Mail, Files, Drive…).
 * Picking uses expo-document-picker and reads the copied file.
 */
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type * as WebFiles from './files';

export const MAX_IMPORT_BYTES: typeof WebFiles.MAX_IMPORT_BYTES = 100 * 1024 * 1024;

function uniformTypeIdentifier(mimeType: string): string | undefined {
  if (mimeType === 'application/json') return 'public.json';
  if (mimeType === 'text/csv') return 'public.comma-separated-values-text';
  return undefined;
}

export const deliverTextFile: typeof WebFiles.deliverTextFile = async (filename, text, mimeType) => {
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
  try {
    return await new File(asset.uri).text();
  } catch {
    throw new Error('Could not read the selected file.');
  }
};
