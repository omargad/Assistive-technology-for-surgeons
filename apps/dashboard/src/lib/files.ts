/**
 * Reading SurgeonPulse export files chosen with the file picker or dropped on
 * the page. Everything happens in memory; nothing is uploaded.
 */
import { parseImport, SessionParseError } from '@surgeonpulse/core';
import type { ExportBundle, ParticipantProfile, SurgicalSession } from '@surgeonpulse/core';
import { mergeParticipants } from '../state/merge';

/** Minimal file shape (a DOM `File`, or a test double). */
export interface ReadableFile {
  name: string;
  size: number;
  text?: () => Promise<string>;
}

/**
 * Read a file as UTF-8 text. Uses `Blob.text()` where available and falls back
 * to `FileReader` (older Safari/iPadOS and some embedded webviews).
 */
export function readFileText(file: ReadableFile): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    if (typeof FileReader === 'undefined') {
      reject(new Error('This browser cannot read local files.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsText(file as unknown as Blob, 'utf-8');
  });
}

/** Result of importing several files. */
export interface FileImportResult {
  sessions: SurgicalSession[];
  participants: ParticipantProfile[];
  warnings: string[];
  /** Names of files that contributed at least one session. */
  loadedFiles: string[];
  /** Whether every contributing bundle was marked de-identified. */
  deidentified: boolean;
}

/** Hard upper bound on a single file (protects tabs on low-memory tablets). */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;

function describeError(err: unknown): string {
  if (err instanceof SessionParseError) {
    const issues = err.issues.slice(0, 5).join('; ');
    const more = err.issues.length > 5 ? ` (+${err.issues.length - 5} more)` : '';
    return `${issues}${more}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse each file with core `parseImport` and merge the results in order:
 * sessions are keyed by id and **later files win**; participant profiles are
 * merged by code. Files that cannot be parsed are skipped with a warning; the
 * per-session warnings from `parseImport` are prefixed with the file name.
 */
export async function importFiles(files: readonly ReadableFile[]): Promise<FileImportResult> {
  const sessions = new Map<string, SurgicalSession>();
  let participants: ParticipantProfile[] = [];
  const warnings: string[] = [];
  const loadedFiles: string[] = [];
  let deidentified = true;

  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      warnings.push(`${file.name}: skipped — larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
      continue;
    }
    let bundle: ExportBundle;
    try {
      const text = await readFileText(file);
      const parsed = parseImport(text);
      bundle = parsed.bundle;
      for (const w of parsed.warnings) warnings.push(`${file.name}: ${w}`);
    } catch (err) {
      warnings.push(`${file.name}: could not be imported — ${describeError(err)}`);
      continue;
    }
    if (bundle.sessions.length === 0) {
      warnings.push(`${file.name}: contains no sessions.`);
      continue;
    }
    for (const s of bundle.sessions) {
      if (sessions.has(s.id)) warnings.push(`${file.name}: session ${s.id.slice(0, 8)} replaced an earlier copy.`);
      sessions.delete(s.id); // re-insert so iteration order follows the latest file
      sessions.set(s.id, s);
    }
    participants = mergeParticipants(participants, bundle.participants);
    loadedFiles.push(file.name);
    deidentified = deidentified && bundle.deidentified;
  }

  return {
    sessions: [...sessions.values()],
    participants,
    warnings,
    loadedFiles,
    deidentified: loadedFiles.length > 0 && deidentified,
  };
}

/** Accept attribute for the file picker (extension + MIME types for iPadOS/Android pickers). */
export const IMPORT_ACCEPT = '.json,application/json,text/json';
