/**
 * Participants: one row per pseudonymous code, linking to the feedback view.
 */
import { useMemo } from 'react';
import { TRAINING_LEVEL_LABELS, median } from '@surgeonpulse/core';
import type { ParticipantProfile } from '@surgeonpulse/core';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { EmptyState, Notice, PageHeader } from '../components/ui';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { fmtDate, fmtSigned, lookup, plural } from '../lib/format';
import { hrefs, navigate } from '../router';
import { useDashboardState, useDerived } from '../state/hooks';

interface ParticipantRow {
  profile: ParticipantProfile;
  sessions: number;
  first: number | null;
  last: number | null;
  firstTz?: number;
  lastTz?: number;
  medianDelta: number | null;
  specialties: string;
}

export function ParticipantsPage() {
  useDocumentTitle('Participants');
  const state = useDashboardState();
  const { facets, summaries } = useDerived();

  const rows = useMemo<ParticipantRow[]>(() => {
    const byCode = new Map<string, ParticipantRow>();
    for (const profile of state.participants.values()) {
      byCode.set(profile.code, { profile, sessions: 0, first: null, last: null, medianDelta: null, specialties: profile.specialty ?? '' });
    }
    const specialties = new Map<string, Set<string>>();
    for (const f of facets) {
      let row = byCode.get(f.participantCode);
      if (row === undefined) {
        row = { profile: { code: f.participantCode }, sessions: 0, first: null, last: null, medianDelta: null, specialties: '' };
        byCode.set(f.participantCode, row);
      }
      row.sessions++;
      if (row.first === null || f.startedAt < row.first) {
        row.first = f.startedAt;
        row.firstTz = f.tzOffsetMin;
      }
      if (row.last === null || f.startedAt > row.last) {
        row.last = f.startedAt;
        row.lastTz = f.tzOffsetMin;
      }
      if (f.specialty) {
        const set = specialties.get(f.participantCode) ?? new Set<string>();
        set.add(f.specialty);
        specialties.set(f.participantCode, set);
      }
    }
    const deltas = new Map<string, number[]>();
    for (const s of summaries) {
      if (s.meanHrDelta === null) continue;
      const list = deltas.get(s.participantCode) ?? [];
      list.push(s.meanHrDelta);
      deltas.set(s.participantCode, list);
    }
    for (const row of byCode.values()) {
      row.medianDelta = median(deltas.get(row.profile.code) ?? []);
      if (row.specialties === '') row.specialties = [...(specialties.get(row.profile.code) ?? [])].join(', ');
    }
    return [...byCode.values()].filter((r) => r.sessions > 0);
  }, [state.participants, facets, summaries]);

  const columns: Column<ParticipantRow>[] = [
    {
      id: 'code',
      header: 'Participant',
      rowHeader: true,
      sortValue: (r) => r.profile.code,
      cell: (r) => (
        <a href={hrefs.participant(r.profile.code)} className="cell-link code">
          {r.profile.code}
        </a>
      ),
    },
    {
      id: 'level',
      header: 'Training level',
      sortValue: (r) => (r.profile.trainingLevel ? lookup(TRAINING_LEVEL_LABELS, r.profile.trainingLevel) : null),
      cell: (r) => lookup(TRAINING_LEVEL_LABELS, r.profile.trainingLevel),
    },
    { id: 'specialty', header: 'Specialty', sortValue: (r) => r.specialties, cell: (r) => r.specialties || '—' },
    { id: 'sessions', header: 'Sessions', align: 'right', sortValue: (r) => r.sessions, cell: (r) => r.sessions },
    {
      id: 'range',
      header: 'Date range',
      sortValue: (r) => r.first,
      cell: (r) => (r.first === null || r.last === null ? '—' : `${fmtDate(r.first, r.firstTz)} – ${fmtDate(r.last, r.lastTz)}`),
    },
    {
      id: 'delta',
      header: 'Median Δ HR',
      title:
        'Median of session mean heart rate above baseline (bpm). Not sortable: differences between participants ' +
        'mostly reflect case mix and baseline protocol, so this column must not be used to rank people.',
      align: 'right',
      // Deliberately no sortValue: ranking surgeons by physiological response invites performance management.
      cell: (r) => fmtSigned(r.medianDelta, 1),
    },
  ];

  if (state.order.length === 0) {
    return (
      <>
        <PageHeader title="Participants" />
        <EmptyState />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Participants"
        subtitle={`${plural(rows.length, 'participant')}. Open a participant for their individual feedback view.`}
      />
      <Notice tone="info">
        Heart-rate responses are for research and individual feedback, not for comparing or ranking surgeons:
        differences between participants mostly reflect case mix, training level and how the baseline was taken.
      </Notice>
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.profile.code}
        caption="Participants"
        initialSort={{ id: 'code', direction: 'asc' }}
        onRowClick={(r) => navigate(hrefs.participant(r.profile.code))}
        testId="participants-table"
      />
    </>
  );
}
