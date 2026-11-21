/**
 * In-memory {@link SessionRepository} with optional persistence to a
 * `localStorage`-like key-value store (used on the web; plain in-memory in
 * tests).
 *
 * Persistence design
 * - Writes are debounced (default 1 s) and can be forced with
 *   {@link MemoryRepository.flushPersistence} (e.g. on `pagehide`).
 * - Signals are stored column-wise with delta-encoded timestamps, which makes
 *   a 1 Hz recording roughly 5× smaller than naive JSON.
 * - Each session's encoded JSON is cached per revision, so a debounced write
 *   during a live recording only re-encodes the session that changed.
 * - Size-aware: if the payload exceeds `maxBytes` (≈4 MB, below the usual
 *   5 MB browser quota) the signal arrays of the oldest finished sessions are
 *   left out (their metadata and cached summaries are kept). A storage error
 *   (quota) leaves out one more session's signals per retry, oldest finished
 *   first and an in-progress recording last, so one failure never drops the
 *   signals of every session. Sessions whose signals are not persisted are
 *   reported through `onPersistStatus` (they stay in memory until the page is
 *   closed, so the user can still export them). Every storage access is
 *   wrapped in try/catch so a full or blocked storage never breaks recording.
 */
import { safeParseSession } from '@surgeonpulse/core';
import type {
  HeartRateSample,
  ParticipantProfile,
  RRInterval,
  SessionSummary,
  SurgicalSession,
} from '@surgeonpulse/core';
import { isStorableRr, isStorableSample } from '../util/signals';
import { applyMetaPatch, safeJsonParse, toMeta } from './meta';
import type { SessionListItem, SessionMeta, SessionRepository } from './types';

/** The subset of the Web Storage API used for persistence. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface MemoryPersistOptions {
  storage: StorageLike;
  /** Storage key. Default `surgeonpulse.sessions.v1`. */
  key?: string;
  /** Debounce for writes in ms. Default 1000. */
  debounceMs?: number;
  /** Approximate size budget in characters. Default 4 000 000. */
  maxBytes?: number;
  /** Called (without any data) when persisting fails, e.g. quota exceeded. */
  onError?: (error: unknown) => void;
  /**
   * Called after a write when the outcome differs from the previous write: `ok` is false when nothing
   * could be stored; `droppedSignals` lists sessions stored without their signals.
   */
  onPersistStatus?: (status: PersistStatus) => void;
}

export interface PersistStatus {
  ok: boolean;
  /** Ids of sessions whose heart-rate signals are not in storage (metadata and summary only). */
  droppedSignals: string[];
}

export interface MemoryRepositoryOptions {
  persist?: MemoryPersistOptions | null;
}

export interface MemoryRepository extends SessionRepository {
  /** Write any pending changes to storage immediately (no-op without persistence). */
  flushPersistence(): void;
}

interface Entry {
  meta: SessionMeta;
  samples: HeartRateSample[];
  rr: RRInterval[];
  summary: SessionSummary | null;
  /** Incremented on every change; keys the encoded-JSON cache. */
  rev: number;
}

interface EncodedCache {
  rev: number;
  full: string;
  metaOnly: string;
}

const DEFAULT_KEY = 'surgeonpulse.sessions.v1';
const DEFAULT_DEBOUNCE_MS = 1000;
const DEFAULT_MAX_BYTES = 4_000_000;
const PERSIST_FORMAT_VERSION = 1;

// ---------------------------------------------------------------------------
// Signal encoding (column-wise, delta-encoded timestamps)
// ---------------------------------------------------------------------------

interface EncodedSamples {
  t: number[];
  bpm: number[];
  /** 1 = contact, 0 = no contact, null = unsupported. Omitted when no sample has contact info. */
  c?: (0 | 1 | null)[];
}

interface EncodedRr {
  t: number[];
  ms: number[];
}

function deltaEncode(ts: readonly number[]): number[] {
  let prev = 0;
  return ts.map((t) => {
    const d = t - prev;
    prev = t;
    return d;
  });
}

function deltaDecode(ds: readonly unknown[]): number[] | null {
  const out: number[] = [];
  let acc = 0;
  for (const d of ds) {
    if (typeof d !== 'number' || !Number.isFinite(d)) return null;
    acc += d;
    out.push(acc);
  }
  return out;
}

function encodeSamples(samples: readonly HeartRateSample[]): EncodedSamples {
  const enc: EncodedSamples = {
    t: deltaEncode(samples.map((s) => s.t)),
    bpm: samples.map((s) => s.bpm),
  };
  if (samples.some((s) => s.contact !== undefined)) {
    enc.c = samples.map((s) => (s.contact === undefined ? null : s.contact ? 1 : 0));
  }
  return enc;
}

function decodeSamples(raw: unknown): HeartRateSample[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const r = raw as { t?: unknown; bpm?: unknown; c?: unknown };
  if (!Array.isArray(r.t) || !Array.isArray(r.bpm) || r.t.length !== r.bpm.length) return [];
  const ts = deltaDecode(r.t);
  if (!ts) return [];
  const contact = Array.isArray(r.c) && r.c.length === ts.length ? (r.c as unknown[]) : null;
  const out: HeartRateSample[] = [];
  for (let i = 0; i < ts.length; i++) {
    const bpm = r.bpm[i];
    if (typeof bpm !== 'number' || !Number.isFinite(bpm)) continue;
    const sample: HeartRateSample = { t: ts[i] as number, bpm };
    const c = contact?.[i];
    if (c === 1 || c === 0) sample.contact = c === 1;
    // A value outside the schema's limits (stored by an older version) must not invalidate the session.
    if (isStorableSample(sample)) out.push(sample);
  }
  return out;
}

function encodeRr(rr: readonly RRInterval[]): EncodedRr {
  return { t: deltaEncode(rr.map((x) => x.t)), ms: rr.map((x) => x.ms) };
}

function decodeRr(raw: unknown): RRInterval[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const r = raw as { t?: unknown; ms?: unknown };
  if (!Array.isArray(r.t) || !Array.isArray(r.ms) || r.t.length !== r.ms.length) return [];
  const ts = deltaDecode(r.t);
  if (!ts) return [];
  const out: RRInterval[] = [];
  for (let i = 0; i < ts.length; i++) {
    const ms = r.ms[i];
    if (typeof ms !== 'number') continue;
    const interval: RRInterval = { t: ts[i] as number, ms };
    if (isStorableRr(interval)) out.push(interval);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Append `incoming` (non-decreasing `t`) to `target`, re-sorting stably only if order breaks. */
function appendOrdered<T extends { t: number }>(target: T[], incoming: readonly T[]): void {
  if (incoming.length === 0) return;
  const boundaryOk = target.length === 0 || (incoming[0] as T).t >= (target[target.length - 1] as T).t;
  for (const item of incoming) target.push(item);
  if (!boundaryOk) {
    const keyed = target.map((item, index) => ({ item, index }));
    keyed.sort((a, b) => a.item.t - b.item.t || a.index - b.index);
    for (let i = 0; i < keyed.length; i++) target[i] = (keyed[i] as { item: T }).item;
  }
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export function createMemoryRepository(options: MemoryRepositoryOptions = {}): MemoryRepository {
  const persist = options.persist ?? null;
  const key = persist?.key ?? DEFAULT_KEY;
  const debounceMs = persist?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxBytes = persist?.maxBytes ?? DEFAULT_MAX_BYTES;

  const entries = new Map<string, Entry>();
  const encodedCache = new Map<string, EncodedCache>();
  let profile: ParticipantProfile | null = null;
  let loaded = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // -- persistence ----------------------------------------------------------

  function loadFromStorage(): void {
    if (loaded) return;
    loaded = true;
    if (!persist) return;
    let text: string | null = null;
    try {
      text = persist.storage.getItem(key);
    } catch (error) {
      persist.onError?.(error);
      return;
    }
    const raw = safeJsonParse(text);
    if (typeof raw !== 'object' || raw === null) return;
    const doc = raw as { v?: unknown; profile?: unknown; sessions?: unknown };
    if (doc.v !== PERSIST_FORMAT_VERSION) return;
    if (typeof doc.profile === 'object' && doc.profile !== null) {
      const p = doc.profile as ParticipantProfile;
      if (typeof p.code === 'string') profile = p;
    }
    if (!Array.isArray(doc.sessions)) return;
    for (const item of doc.sessions as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as { meta?: unknown; samples?: unknown; rr?: unknown; summary?: unknown };
      if (typeof rec.meta !== 'object' || rec.meta === null) continue;
      const candidate = { ...(rec.meta as object), samples: decodeSamples(rec.samples), rr: decodeRr(rec.rr) };
      const parsed = safeParseSession(candidate);
      if (!parsed.ok) continue; // skip corrupt or incompatible records
      const session = parsed.session;
      const summary =
        typeof rec.summary === 'object' && rec.summary !== null ? (rec.summary as SessionSummary) : null;
      entries.set(session.id, {
        meta: toMeta(session),
        samples: session.samples,
        rr: session.rr,
        summary,
        rev: 0,
      });
    }
  }

  function encodeEntry(id: string, entry: Entry): EncodedCache {
    const cached = encodedCache.get(id);
    if (cached && cached.rev === entry.rev) return cached;
    const metaJson = JSON.stringify(entry.meta);
    const summaryJson = JSON.stringify(entry.summary);
    const full = `{"meta":${metaJson},"summary":${summaryJson},"samples":${JSON.stringify(
      encodeSamples(entry.samples),
    )},"rr":${JSON.stringify(encodeRr(entry.rr))}}`;
    const metaOnly = `{"meta":${metaJson},"summary":${summaryJson}}`;
    const next = { rev: entry.rev, full, metaOnly };
    encodedCache.set(id, next);
    return next;
  }

  interface Payload {
    text: string;
    /** Sessions (with signals) stored as metadata only. */
    dropped: string[];
    /** Number of sessions whose signals were left out (whether or not they had any). */
    droppedCount: number;
    /** True when no session's signals are left to drop. */
    exhausted: boolean;
  }

  /**
   * Build the payload, leaving out signals of the oldest finished sessions (in-progress recordings
   * last) until it fits `maxBytes` and at least `minDropped` sessions are left out.
   */
  function buildPayload(minDropped: number): Payload {
    const sorted = [...entries.entries()].sort((a, b) => a[1].meta.startedAt - b[1].meta.startedAt);
    const encoded = sorted.map(([id, entry]) => ({ id, entry, enc: encodeEntry(id, entry), full: true }));
    const head = `{"v":${PERSIST_FORMAT_VERSION},"profile":${JSON.stringify(profile)},"sessions":[`;
    const tail = ']}';
    let size =
      head.length + tail.length + encoded.reduce((n, e) => n + e.enc.full.length + 1, 0);

    const order = [
      ...encoded.filter((e) => e.entry.meta.status !== 'recording'),
      ...encoded.filter((e) => e.entry.meta.status === 'recording'),
    ];
    let droppedCount = 0;
    for (const e of order) {
      if (size <= maxBytes && droppedCount >= minDropped) break;
      e.full = false;
      size -= e.enc.full.length - e.enc.metaOnly.length;
      droppedCount += 1;
    }
    return {
      text: head + encoded.map((e) => (e.full ? e.enc.full : e.enc.metaOnly)).join(',') + tail,
      dropped: encoded
        .filter((e) => !e.full && (e.entry.samples.length > 0 || e.entry.rr.length > 0))
        .map((e) => e.id),
      droppedCount,
      exhausted: droppedCount >= encoded.length,
    };
  }

  let lastStatus: PersistStatus = { ok: true, droppedSignals: [] };

  function reportStatus(status: PersistStatus): void {
    const same =
      status.ok === lastStatus.ok &&
      status.droppedSignals.length === lastStatus.droppedSignals.length &&
      status.droppedSignals.every((id, i) => id === lastStatus.droppedSignals[i]);
    lastStatus = status;
    if (same) return;
    try {
      persist?.onPersistStatus?.(status);
    } catch {
      // listeners must not break persistence
    }
  }

  function writeNow(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!persist || !dirty) return;
    dirty = false;
    let lastError: unknown = null;
    let minDropped = 0;
    // On a storage error (most likely QuotaExceededError) leave out one more session's signals and
    // retry, instead of falling back to metadata only for every session at once.
    for (;;) {
      let payload: Payload;
      try {
        payload = buildPayload(minDropped);
      } catch (error) {
        persist.onError?.(error);
        return;
      }
      try {
        persist.storage.setItem(key, payload.text);
        reportStatus({ ok: true, droppedSignals: payload.dropped });
        return;
      } catch (error) {
        lastError = error;
      }
      if (payload.exhausted) break;
      minDropped = payload.droppedCount + 1;
    }
    persist.onError?.(lastError);
    reportStatus({ ok: false, droppedSignals: lastStatus.droppedSignals });
  }

  function markDirty(id?: string): void {
    if (id !== undefined) {
      const entry = entries.get(id);
      if (entry) entry.rev += 1;
    }
    if (!persist) return;
    dirty = true;
    if (timer === null) timer = setTimeout(writeNow, debounceMs);
  }

  // -- repository -----------------------------------------------------------

  function requireEntry(id: string): Entry {
    const entry = entries.get(id);
    if (!entry) throw new Error(`Session ${id} not found`);
    return entry;
  }

  const repo: MemoryRepository = {
    async init() {
      loadFromStorage();
    },

    async listSessions(): Promise<SessionListItem[]> {
      loadFromStorage();
      return [...entries.values()]
        .sort((a, b) => b.meta.startedAt - a.meta.startedAt)
        .map((e) => ({
          meta: cloneJson(e.meta),
          summary: e.summary ? cloneJson(e.summary) : null,
          sampleCount: e.samples.length,
        }));
    },

    async getSession(id: string): Promise<SurgicalSession | null> {
      loadFromStorage();
      const entry = entries.get(id);
      if (!entry) return null;
      return { ...cloneJson(entry.meta), samples: entry.samples.slice(), rr: entry.rr.slice() };
    },

    async createSession(session: SurgicalSession): Promise<void> {
      loadFromStorage();
      if (entries.has(session.id)) throw new Error(`Session ${session.id} already exists`);
      entries.set(session.id, {
        meta: cloneJson(toMeta(session)),
        samples: session.samples.slice(),
        rr: session.rr.slice(),
        summary: null,
        rev: 0,
      });
      markDirty(session.id);
    },

    async appendSignals(id, samples, rr): Promise<void> {
      loadFromStorage();
      if (samples.length === 0 && rr.length === 0) return;
      const entry = requireEntry(id);
      appendOrdered(entry.samples, samples);
      appendOrdered(entry.rr, rr);
      markDirty(id);
    },

    async updateMeta(id, patch): Promise<void> {
      loadFromStorage();
      const entry = requireEntry(id);
      // Apply first (so `{ key: undefined }` removes a key), then deep-copy the result.
      entry.meta = cloneJson(applyMetaPatch(entry.meta, patch));
      markDirty(id);
    },

    async saveSession(session: SurgicalSession): Promise<void> {
      loadFromStorage();
      entries.set(session.id, {
        meta: cloneJson(toMeta(session)),
        samples: session.samples.slice(),
        rr: session.rr.slice(),
        // Signals may have changed, so any cached summary is stale.
        summary: null,
        rev: (entries.get(session.id)?.rev ?? 0) + 1,
      });
      markDirty(session.id);
    },

    async saveSummary(id: string, summary: SessionSummary): Promise<void> {
      loadFromStorage();
      const entry = requireEntry(id);
      entry.summary = cloneJson(summary);
      markDirty(id);
    },

    async deleteSession(id: string): Promise<void> {
      loadFromStorage();
      entries.delete(id);
      encodedCache.delete(id);
      markDirty();
    },

    async deleteAll(): Promise<void> {
      loadFromStorage();
      entries.clear();
      encodedCache.clear();
      markDirty();
    },

    async findInterrupted(): Promise<SessionMeta[]> {
      loadFromStorage();
      return [...entries.values()]
        .filter((e) => e.meta.status === 'recording')
        .sort((a, b) => b.meta.startedAt - a.meta.startedAt)
        .map((e) => cloneJson(e.meta));
    },

    async getProfile(): Promise<ParticipantProfile | null> {
      loadFromStorage();
      return profile ? cloneJson(profile) : null;
    },

    async saveProfile(next: ParticipantProfile): Promise<void> {
      loadFromStorage();
      profile = cloneJson(next);
      markDirty();
    },

    async deleteProfile(): Promise<void> {
      loadFromStorage();
      profile = null;
      markDirty();
    },

    flushPersistence(): void {
      writeNow();
    },
  };
  return repo;
}
