/**
 * Export: summaries CSV, long-format samples/events/RR CSVs and a
 * de-identified JSON bundle for the filtered sessions, plus the data
 * dictionary of the summaries CSV.
 */
import { useId, useMemo, useState } from 'react';
import { summariesToCsv } from '@surgeonpulse/core';
import type { SurgicalSession } from '@surgeonpulse/core';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { FilterSummary, SummaryProgress } from '../components/Filters';
import { Card, EmptyState, Notice, PageHeader, SimulatedBadge } from '../components/ui';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { summaryColumnDictionary } from '../lib/columnDictionary';
import type { ColumnInfo } from '../lib/columnDictionary';
import { downloadCsv, downloadJson, exportFilename } from '../lib/download';
import { buildDeidentifiedBundle, longEventsCsv, longRrCsv, longSamplesCsv } from '../lib/exports';
import { fmtCount, plural } from '../lib/format';
import { useDashboardState, useDerived } from '../state/hooks';

const DICTIONARY_COLUMNS: Column<ColumnInfo>[] = [
  { id: 'column', header: 'Column', rowHeader: true, cell: (c) => <code>{c.column}</code> },
  { id: 'description', header: 'Description', cell: (c) => c.description },
  { id: 'unit', header: 'Unit', cell: (c) => c.unit || '—' },
];

function ExportCard({
  title,
  description,
  detail,
  buttonLabel,
  disabled,
  onExport,
  testId,
}: {
  title: string;
  description: string;
  detail: string;
  buttonLabel: string;
  disabled?: boolean;
  onExport: () => void;
  testId: string;
}) {
  return (
    <Card title={title} description={description} className="export-card">
      <p className="export-card__detail">{detail}</p>
      <button type="button" className="btn btn--primary" onClick={onExport} disabled={disabled} data-testid={testId}>
        {buttonLabel}
      </button>
    </Card>
  );
}

export function ExportPage() {
  useDocumentTitle('Export');
  const state = useDashboardState();
  const { filteredFacets, filteredSummaries, summarizing, progress } = useDerived();
  const [excelBom, setExcelBom] = useState(false);
  const [shiftDates, setShiftDates] = useState(true);
  const [maxShiftWeeks, setMaxShiftWeeks] = useState('52');
  const [dropTz, setDropTz] = useState(false);
  const [dropBirthYear, setDropBirthYear] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const ids = { bom: useId(), shift: useId(), weeks: useId(), tz: useId(), birth: useId() };
  const dictionary = useMemo(() => summaryColumnDictionary(), []);

  const sessions = useMemo<SurgicalSession[]>(
    () => filteredFacets.flatMap((f) => {
      const s = state.sessions.get(f.id);
      return s ? [s] : [];
    }),
    [filteredFacets, state.sessions],
  );
  const sampleRows = sessions.reduce((a, s) => a + s.samples.length, 0);
  const eventRows = sessions.reduce((a, s) => a + s.events.length, 0);
  const rrSessions = sessions.filter((s) => s.rr.length > 0);
  const rrRows = rrSessions.reduce((a, s) => a + s.rr.length, 0);

  if (state.order.length === 0) {
    return (
      <>
        <PageHeader title="Export" />
        <EmptyState />
      </>
    );
  }

  /** Run a potentially slow export after the button state has painted. */
  const run = (label: string, task: () => void): void => {
    setBusy(label);
    setTimeout(() => {
      try {
        task();
      } finally {
        setBusy(null);
      }
    }, 20);
  };
  const now = (): Date => new Date();
  const csvOpts = { bom: excelBom };

  return (
    <>
      <PageHeader
        title="Export"
        subtitle={`Exports cover the ${plural(sessions.length, 'filtered session')}. Files are generated in this browser.`}
        actions={state.simulated ? <SimulatedBadge /> : undefined}
      />
      <FilterSummary />
      <SummaryProgress />
      {state.simulated && (
        <Notice tone="info">
          The loaded data is simulated. The JSON bundle and the session CSVs keep the “simulated” sensor source, and the
          summaries CSV has <code>sensor_source</code> and <code>simulated</code> (1) columns; exclude these rows from
          analyses.
        </Notice>
      )}
      <div className="checkbox checkbox--card">
        <input id={ids.bom} type="checkbox" checked={excelBom} onChange={(e) => setExcelBom(e.target.checked)} />
        <label htmlFor={ids.bom}>
          Excel-friendly CSV <span className="muted">(adds a UTF-8 byte-order mark so Excel on Windows shows accents
          correctly; leave off for R, Python, SPSS and Stata)</span>
        </label>
      </div>

      <div className="grid grid--2">
        <ExportCard
          title="Session summaries"
          description="One wide row per session: identifiers, procedure, HR/HRV, workload, quality and per-phase columns."
          detail={
            summarizing
              ? `Waiting for summaries (${progress.done} of ${progress.total})…`
              : `${plural(filteredSummaries.length, 'row')} · ${dictionary.length} columns`
          }
          buttonLabel={busy === 'summaries' ? 'Preparing…' : 'Download summaries CSV'}
          disabled={summarizing || filteredSummaries.length === 0 || busy !== null}
          testId="export-summaries"
          onExport={() =>
            run('summaries', () => downloadCsv(summariesToCsv(filteredSummaries), exportFilename('summaries', 'csv', now()), csvOpts))
          }
        />
        <ExportCard
          title="Heart-rate samples"
          description="Long format: one row per sample with session, participant, time offset and phase."
          detail={`${fmtCount(sampleRows)} rows from ${plural(sessions.length, 'session')}`}
          buttonLabel={busy === 'samples' ? 'Preparing…' : 'Download samples CSV'}
          disabled={sessions.length === 0 || busy !== null}
          testId="export-samples"
          onExport={() => run('samples', () => downloadCsv(longSamplesCsv(sessions), exportFilename('samples', 'csv', now()), csvOpts))}
        />
        <ExportCard
          title="Events"
          description="Long format: phase changes and markers with who logged them. Free-text notes are never included."
          detail={`${fmtCount(eventRows)} rows from ${plural(sessions.length, 'session')}`}
          buttonLabel={busy === 'events' ? 'Preparing…' : 'Download events CSV'}
          disabled={sessions.length === 0 || busy !== null}
          testId="export-events"
          onExport={() => run('events', () => downloadCsv(longEventsCsv(sessions), exportFilename('events', 'csv', now()), csvOpts))}
        />
        <ExportCard
          title="RR intervals"
          description="Long format: beat-to-beat intervals with the artefact flag used for HRV."
          detail={`${fmtCount(rrRows)} rows from ${plural(rrSessions.length, 'session')} with RR data`}
          buttonLabel={busy === 'rr' ? 'Preparing…' : 'Download RR CSV'}
          disabled={rrSessions.length === 0 || busy !== null}
          testId="export-rr"
          onExport={() => run('rr', () => downloadCsv(longRrCsv(sessions), exportFilename('rr', 'csv', now()), csvOpts))}
        />
      </div>

      <Card
        title="De-identified bundle (JSON)"
        description="A SurgeonPulse export file for sharing with collaborators. Notes and free text are removed, procedure names are replaced with catalogue names, and sensor ids are dropped."
      >
        <div className="option-grid">
          <div className="checkbox option-grid__wide">
            <input id={ids.shift} type="checkbox" checked={shiftDates} onChange={(e) => setShiftDates(e.target.checked)} />
            <label htmlFor={ids.shift}>
              Shift dates randomly per participant <span className="muted">(whole weeks; the same shift for all of a participant's sessions, so weekdays, times of day and intervals are kept)</span>
            </label>
          </div>
          <div className="field field--narrow">
            <label htmlFor={ids.weeks}>Maximum shift (weeks)</label>
            <input
              id={ids.weeks}
              type="number"
              inputMode="numeric"
              min={1}
              max={520}
              step={1}
              value={maxShiftWeeks}
              disabled={!shiftDates}
              onChange={(e) => setMaxShiftWeeks(e.target.value)}
            />
          </div>
          <div className="checkbox">
            <input id={ids.tz} type="checkbox" checked={dropTz} onChange={(e) => setDropTz(e.target.checked)} />
            <label htmlFor={ids.tz}>Remove timezone offsets</label>
          </div>
          <div className="checkbox">
            <input id={ids.birth} type="checkbox" checked={dropBirthYear} onChange={(e) => setDropBirthYear(e.target.checked)} />
            <label htmlFor={ids.birth}>Remove birth years</label>
          </div>
        </div>
        <p className="hint">The random shifts are not shown or saved anywhere, so they cannot be reversed from the file.</p>
        <button
          type="button"
          className="btn btn--primary"
          disabled={sessions.length === 0 || busy !== null}
          data-testid="export-bundle"
          onClick={() =>
            run('bundle', () => {
              const weeks = Number.parseInt(maxShiftWeeks, 10);
              const { bundle } = buildDeidentifiedBundle(
                sessions,
                [...state.participants.values()],
                {
                  shiftDates,
                  maxShiftWeeks: Number.isFinite(weeks) && weeks > 0 ? Math.min(weeks, 520) : 52,
                  dropTzOffset: dropTz,
                  dropBirthYear,
                },
                { now: Date.now() },
              );
              downloadJson(bundle, exportFilename('deidentified', 'json', now()));
            })
          }
        >
          {busy === 'bundle' ? 'Preparing…' : 'Download de-identified bundle'}
        </button>
      </Card>

      <Card
        title="Column dictionary"
        description="Columns of the session summaries CSV. Missing values are empty fields; percentages are 0–100; times are ISO 8601 UTC."
        id="column-dictionary"
      >
        <DataTable
          rows={dictionary}
          columns={DICTIONARY_COLUMNS}
          rowKey={(c) => c.column}
          caption="Summary CSV columns"
          compact
          className="table-block--tall"
          testId="column-dictionary"
        />
      </Card>
    </>
  );
}
