/**
 * Data sources: local files, the simulated demo cohort and the research
 * server. Also the first-run screen's destination.
 */
import { useId, useState } from 'react';
import type { DragEvent, FormEvent } from 'react';
import { Card, Notice, PageHeader, SimulatedBadge } from '../components/ui';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { secureRandom } from '../lib/exports';
import { IMPORT_ACCEPT } from '../lib/files';
import { fmtDateTime, plural } from '../lib/format';
import { isInsecureRemote, normaliseServerUrl } from '../lib/serverClient';
import { forgetServerToken, loadServerSettings, saveServerSettings } from '../lib/serverSettings';
import { hrefs, navigate } from '../router';
import type { SourceInfo } from '../state/reducer';
import { useDashboardState, useDataActions } from '../state/hooks';

const SOURCE_KIND_LABELS: Readonly<Record<SourceInfo['kind'], string>> = {
  file: 'Files',
  demo: 'Demo',
  server: 'Server',
};

function FilesCard() {
  const { loadFiles } = useDataActions();
  const { busy } = useDashboardState();
  const [dragging, setDragging] = useState(false);
  const inputId = useId();

  const onFiles = async (list: FileList | null): Promise<void> => {
    if (list === null || list.length === 0) return;
    const ok = await loadFiles(Array.from(list));
    if (ok) navigate(hrefs.overview);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(false);
    void onFiles(e.dataTransfer.files);
  };

  return (
    <Card title="Open files" description="SurgeonPulse JSON exports from the app or the server. Several files are merged by session id; later files win.">
      <div
        className={`dropzone${dragging ? ' dropzone--active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p className="dropzone__text">Drop .json files here, or</p>
        <label className={`btn btn--primary file-button${busy ? ' btn--disabled' : ''}`} htmlFor={inputId}>
          <input
            id={inputId}
            className="file-button__input"
            type="file"
            accept={IMPORT_ACCEPT}
            multiple
            disabled={busy !== null}
            data-testid="file-input"
            onChange={(e) => {
              void onFiles(e.target.files);
              e.target.value = ''; // allow re-selecting the same file
            }}
          />
          Choose files…
        </label>
      </div>
      <p className="hint">Files are read in this browser only; nothing is uploaded.</p>
    </Card>
  );
}

function DemoCard() {
  const { loadDemo } = useDataActions();
  const { busy, simulated, sources } = useDashboardState();
  const current = simulated ? sources[0]?.seed : undefined;
  const [seed, setSeed] = useState(String(current ?? 1));
  const seedId = useId();

  const load = async (value: number): Promise<void> => {
    const ok = await loadDemo(value);
    if (ok) navigate(hrefs.overview);
  };

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    const n = Number.parseInt(seed, 10);
    void load(Number.isFinite(n) ? n : 1);
  };

  return (
    <Card
      title={
        <>
          Demo data <SimulatedBadge />
        </>
      }
      description="A simulated cohort (8 participants × 12 sessions) from the SurgeonPulse physiological model. Clearly not real data — use it to explore the dashboard."
    >
      <form className="inline-form" onSubmit={onSubmit}>
        <div className="field field--narrow">
          <label htmlFor={seedId}>Seed</label>
          <input
            id={seedId}
            type="number"
            inputMode="numeric"
            step={1}
            min={0}
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
          />
        </div>
        <button type="submit" className="btn btn--primary" disabled={busy !== null} data-testid="load-demo">
          Load demo data
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => {
            const next = Math.floor(secureRandom() * 1_000_000);
            setSeed(String(next));
            void load(next);
          }}
        >
          Regenerate
        </button>
      </form>
      <p className="hint">The same seed always produces the same cohort. Loading demo data replaces any loaded data.</p>
    </Card>
  );
}

function ServerCard() {
  const { loadServer } = useDataActions();
  const { busy } = useDashboardState();
  const [settings, setSettings] = useState(loadServerSettings);
  const urlId = useId();
  const tokenId = useId();
  const rememberId = useId();

  let insecure = false;
  try {
    insecure = settings.url.trim() !== '' && isInsecureRemote(normaliseServerUrl(settings.url));
  } catch {
    insecure = false;
  }

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    saveServerSettings(settings);
    const ok = await loadServer({ url: settings.url, token: settings.token });
    if (ok) navigate(hrefs.overview);
  };

  return (
    <Card title="Research server" description="Download the de-identified export from your study's SurgeonPulse server (GET /api/v1/export).">
      <form className="stack-form" onSubmit={(e) => void onSubmit(e)} autoComplete="off">
        <div className="field">
          <label htmlFor={urlId}>Server URL</label>
          <input
            id={urlId}
            type="url"
            inputMode="url"
            placeholder="https://surgeonpulse.example.edu"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={settings.url}
            onChange={(e) => setSettings({ ...settings, url: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={tokenId}>Admin token</label>
          <input
            id={tokenId}
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={settings.token}
            onChange={(e) => setSettings({ ...settings, token: e.target.value })}
          />
        </div>
        <div className="checkbox">
          <input
            id={rememberId}
            type="checkbox"
            checked={settings.remember}
            onChange={(e) => {
              const remember = e.target.checked;
              setSettings({ ...settings, remember });
              if (!remember) forgetServerToken();
            }}
          />
          <label htmlFor={rememberId}>Remember the token on this device</label>
        </div>
        {insecure && (
          <Notice tone="warning">
            This address uses plain HTTP, so the token would travel unencrypted. Use https:// for anything other than
            a local test server.
          </Notice>
        )}
        <div className="button-row">
          <button type="submit" className="btn btn--primary" disabled={busy !== null || settings.url.trim() === ''}>
            Connect &amp; download
          </button>
        </div>
      </form>
      <p className="hint">
        The URL is remembered on this device. The token stays in memory only, unless you tick “Remember”. The server
        must list this dashboard's address in its <code>CORS_ORIGINS</code> setting.
      </p>
    </Card>
  );
}

function SourcesCard({ onCleared }: { onCleared: () => void }) {
  const state = useDashboardState();
  const { clearAll } = useDataActions();
  const [confirming, setConfirming] = useState(false);
  // Also offered with no data loaded, so a remembered admin token can always be removed.
  const hasToken = loadServerSettings().token !== '';

  const columns: Column<SourceInfo>[] = [
    {
      id: 'source',
      header: 'Source',
      rowHeader: true,
      cell: (s) => (
        <span>
          <span className="muted">{SOURCE_KIND_LABELS[s.kind]}:</span> {s.label}{' '}
          {s.kind === 'demo' && <SimulatedBadge />}
        </span>
      ),
    },
    { id: 'sessions', header: 'Sessions', align: 'right', cell: (s) => s.sessionCount },
    { id: 'participants', header: 'Participants', align: 'right', cell: (s) => s.participantCount },
    { id: 'deid', header: 'De-identified', cell: (s) => (s.deidentified ? 'Yes' : 'No') },
    { id: 'loaded', header: 'Loaded', cell: (s) => fmtDateTime(s.loadedAt) },
  ];

  const warnings = state.sources.flatMap((s) => s.warnings);

  return (
    <Card
      title="Loaded data"
      description={
        state.order.length === 0
          ? 'Nothing is loaded.'
          : `${plural(state.order.length, 'session')} from ${plural(state.participants.size, 'participant')} in memory.`
      }
      actions={
        confirming ? (
          <span className="button-row">
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                clearAll();
                setConfirming(false);
                onCleared();
              }}
            >
              Yes, clear everything
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn btn--danger-outline"
            onClick={() => setConfirming(true)}
            disabled={state.order.length === 0 && !hasToken}
            title="Removes the loaded data and forgets the admin token on this device"
          >
            Clear all data
          </button>
        )
      }
    >
      {state.sources.length > 0 && (
        <DataTable rows={state.sources} columns={columns} rowKey={(s) => String(s.id)} caption="Loaded data sources" compact />
      )}
      {warnings.length > 0 && (
        <details className="warnings">
          <summary>
            {plural(warnings.length, 'import warning')} (sessions or fields that were skipped)
          </summary>
          <ul>
            {warnings.slice(0, 200).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
          {warnings.length > 200 && <p className="muted">…and {warnings.length - 200} more.</p>}
        </details>
      )}
    </Card>
  );
}

export function DataPage() {
  useDocumentTitle('Data');
  const { error, busy } = useDashboardState();
  const { dismissError } = useDataActions();
  // Re-mounts the server form after "Clear all data" so the forgotten token is not left in the input.
  const [clears, setClears] = useState(0);
  return (
    <>
      <PageHeader title="Data" subtitle="Load SurgeonPulse exports, the simulated demo cohort, or your research server's data." />
      <Notice tone="info" title="Data stays in this browser">
        Files are read into this tab's memory and are never uploaded. Closing or reloading the page clears them. The only
        network request the dashboard makes is to the research server you configure below.
      </Notice>
      {busy !== null && (
        <div className="busy" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" /> {busy.message}
        </div>
      )}
      {error !== null && (
        <Notice tone="error" title="Could not load data" onDismiss={dismissError}>
          {error}
        </Notice>
      )}
      <div className="grid grid--3">
        <FilesCard />
        <DemoCard />
        <ServerCard key={clears} />
      </div>
      <SourcesCard onCleared={() => setClears((n) => n + 1)} />
    </>
  );
}
