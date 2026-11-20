/**
 * File delivery — web / fallback implementation.
 *
 * Saving uses a Blob + temporary anchor download; picking uses a hidden
 * `<input type="file">`. Native builds resolve `files.native.ts` instead
 * (expo-file-system + expo-sharing + expo-document-picker).
 */

/** Largest import file read into memory (bytes). */
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

function requireDom(): Document {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    throw new Error('Saving and opening files is not supported in this environment.');
  }
  return document;
}

/** Save `text` as `filename` (browser download). */
export async function deliverTextFile(filename: string, text: string, mimeType: string): Promise<void> {
  const doc = requireDom();
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  try {
    const a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    doc.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Give the browser time to start the download before releasing the blob.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/** Let the user choose a text file; resolves its contents, or null when cancelled. */
export function pickTextFile(accept: string): Promise<string | null> {
  const doc = requireDom();
  return new Promise<string | null>((resolve, reject) => {
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      input.remove();
      fn();
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        finish(() => resolve(null));
        return;
      }
      if (file.size > MAX_IMPORT_BYTES) {
        finish(() => reject(new Error('That file is too large to import.')));
        return;
      }
      file.text().then(
        (text) => finish(() => resolve(text)),
        () => finish(() => reject(new Error('Could not read the selected file.'))),
      );
    });
    // Modern browsers fire `cancel` when the chooser is dismissed.
    input.addEventListener('cancel', () => finish(() => resolve(null)));
    doc.body.appendChild(input);
    input.click();
  });
}
