/**
 * Filter controls (Sessions page) and the compact "filters active" banner
 * shown on the pages that respect the same global filters.
 */
import { useId } from 'react';
import { APPROACH_LABELS, ROLE_LABELS } from '@surgeonpulse/core';
import { lookup, plural } from '../lib/format';
import { hrefs } from '../router';
import { activeFilterCount, describeFilters } from '../state/filters';
import type { SessionFilters } from '../state/filters';
import { useDashboardState, useDerived, useFilters } from '../state/hooks';
import { ProgressBar } from './ui';

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Full filter bar. */
export function FilterBar() {
  const { filters, setFilters, resetFilters } = useFilters();
  const { options, filteredFacets, facets } = useDerived();
  const searchId = useId();
  const fromId = useId();
  const toId = useId();
  const set = (key: keyof SessionFilters) => (value: string) => setFilters({ [key]: value });
  const active = activeFilterCount(filters);

  return (
    <section className="filter-bar" aria-label="Session filters">
      <div className="filter-bar__grid">
        <div className="field field--search">
          <label htmlFor={searchId}>Search</label>
          <input
            id={searchId}
            type="search"
            inputMode="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Code, procedure, specialty…"
            value={filters.search}
            onChange={(e) => setFilters({ search: e.target.value })}
          />
        </div>
        <FilterSelect
          label="Participant"
          value={filters.participant}
          options={options.participants.map((v) => ({ value: v, label: v }))}
          onChange={set('participant')}
        />
        <FilterSelect
          label="Procedure"
          value={filters.procedure}
          options={options.procedures.map((v) => ({ value: v, label: v }))}
          onChange={set('procedure')}
        />
        <FilterSelect
          label="Specialty"
          value={filters.specialty}
          options={options.specialties.map((v) => ({ value: v, label: v }))}
          onChange={set('specialty')}
        />
        <FilterSelect
          label="Approach"
          value={filters.approach}
          options={options.approaches.map((v) => ({ value: v, label: lookup(APPROACH_LABELS, v) }))}
          onChange={set('approach')}
        />
        <FilterSelect
          label="Role"
          value={filters.role}
          options={options.roles.map((v) => ({ value: v, label: lookup(ROLE_LABELS, v) }))}
          onChange={set('role')}
        />
        <div className="field">
          <label htmlFor={fromId}>From</label>
          <input
            id={fromId}
            type="date"
            value={filters.from}
            min={options.minDate || undefined}
            max={filters.to || options.maxDate || undefined}
            onChange={(e) => setFilters({ from: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={toId}>To</label>
          <input
            id={toId}
            type="date"
            value={filters.to}
            min={filters.from || options.minDate || undefined}
            max={options.maxDate || undefined}
            onChange={(e) => setFilters({ to: e.target.value })}
          />
        </div>
      </div>
      <div className="filter-bar__footer">
        <p className="filter-bar__count" aria-live="polite">
          Showing {filteredFacets.length} of {plural(facets.length, 'session')}
          {active > 0 ? ` · ${plural(active, 'filter')} active` : ''}
        </p>
        <button type="button" className="btn btn--small" onClick={resetFilters} disabled={active === 0}>
          Reset filters
        </button>
      </div>
    </section>
  );
}

/** Banner on Overview/Analysis/Export when filters are active. */
export function FilterSummary() {
  const { filters, resetFilters } = useFilters();
  const { filteredFacets, facets } = useDerived();
  if (activeFilterCount(filters) === 0) return null;
  return (
    <div className="filter-summary" role="status">
      <span>
        <strong>Filtered:</strong> {describeFilters(filters)} — {filteredFacets.length} of {plural(facets.length, 'session')}.
      </span>
      <span className="filter-summary__actions">
        <a href={hrefs.sessions}>Edit filters</a>
        <button type="button" className="btn btn--small" onClick={resetFilters}>
          Clear filters
        </button>
      </span>
    </div>
  );
}

/** Progress bar while summaries are being computed. */
export function SummaryProgress() {
  const { progress, summarizing } = useDerived();
  const { summaryErrors } = useDashboardState();
  if (!summarizing && summaryErrors.size === 0) return null;
  return (
    <div className="summary-progress">
      {summarizing && (
        <ProgressBar
          value={progress.done}
          max={progress.total}
          label={`Computing session summaries… ${progress.done} of ${progress.total}`}
        />
      )}
      {summaryErrors.size > 0 && !summarizing && (
        <p className="muted">
          {plural(summaryErrors.size, 'session')} could not be summarised and {summaryErrors.size === 1 ? 'is' : 'are'}{' '}
          excluded from analyses.
        </p>
      )}
    </div>
  );
}
