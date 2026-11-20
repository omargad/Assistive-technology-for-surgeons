/**
 * Session detail dashboard: header, stat tiles, HR timeline (phases, markers,
 * baseline & threshold), rolling HRV, time in zones, HR by phase, phase table,
 * stress episodes, post-op report, data quality, and actions (edit events,
 * export, health import, upload, delete). All metrics come from core
 * `summarizeSession` (via useSessionDetail) and core helpers.
 */
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';

import {
  APPROACH_LABELS,
  COMPLEXITY_LABELS,
  MARKER_LABELS,
  OUTCOME_LABELS,
  PHASE_COLORS,
  PHASE_LABELS,
  ROLE_LABELS,
  SENSOR_SOURCE_LABELS,
  SESSION_STATUS_LABELS,
  SURG_TLX_DIMENSIONS,
  URGENCY_LABELS,
  defaultEpisodeThreshold,
  formatDuration,
  rollingHrv,
} from '@surgeonpulse/core';
import type { SessionSummary, SurgicalSession } from '@surgeonpulse/core';

import { AppText } from '@/components/AppText';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { confirmAsync, notify } from '@/components/ConfirmDialog';
import { SectionHeader } from '@/components/Controls';
import { EmptyState } from '@/components/EmptyState';
import { ListGroup, ListRow } from '@/components/ListRow';
import { Screen } from '@/components/Screen';
import { StatGrid, StatTile } from '@/components/StatTile';
import { Toast } from '@/components/Toast';
import { HrTimelineChart } from '@/components/charts/HrTimelineChart';
import { PhaseBars } from '@/components/charts/PhaseBars';
import { RollingHrvChart } from '@/components/charts/RollingHrvChart';
import { ZoneBar } from '@/components/charts/ZoneBar';
import { errorMessage, useBusy } from '@/hooks/useBusy';
import { useSessionDetail } from '@/hooks/useSessionDetail';
import { useToast } from '@/hooks/useToast';
import { shareBundle, shareSessionCsv } from '@/services/export/share';
import { healthStore } from '@/services/health';
import { uploadSessions } from '@/services/upload/research';
import { useRecording } from '@/state/recording';
import { useSessions } from '@/state/sessions';
import { useSettings } from '@/state/settings';
import {
  formatDateTime,
  formatDelta,
  formatElapsed,
  formatNumber,
  formatPercent,
  useStyles,
  type Theme,
} from '@/theme';

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session, summary, loading, error, reload } = useSessionDetail(typeof id === 'string' ? id : undefined);

  if (loading && !session) {
    return (
      <Screen>
        <AppText variant="label" tone="muted" align="center">
          Loading session…
        </AppText>
      </Screen>
    );
  }
  if (error || !session || !summary) {
    return (
      <Screen>
        <EmptyState icon="alert-circle-outline" title="Session unavailable" message={error ?? 'This session could not be loaded.'}>
          <Button label="Back to History" onPress={() => router.replace('/history')} />
        </EmptyState>
      </Screen>
    );
  }
  return <SessionDashboard session={session} summary={summary} reload={reload} />;
}

function SessionDashboard({ session, summary, reload }: { session: SurgicalSession; summary: SessionSummary; reload: () => Promise<void> }) {
  const styles = useStyles(makeStyles);
  const profile = useSessions((s) => s.profile);
  const settings = useSettings((s) => s.settings);
  const { busy, run } = useBusy();
  const { toast, show, hide } = useToast();

  const rolling = useMemo(() => rollingHrv(session.rr), [session.rr]);
  const threshold = useMemo(() => defaultEpisodeThreshold(summary.baseline, summary.hr), [summary.baseline, summary.hr]);
  const eventsById = useMemo(() => new Map(session.events.map((e) => [e.id, e])), [session.events]);
  const p = session.procedure;
  const workload = summary.workload ? (summary.workload.weighted ?? summary.workload.raw) : null;
  const episodeMinutes = summary.episodes.reduce((a, e) => a + e.durationSec, 0) / 60;
  const researchConfigured = settings.researchServerUrl.trim() !== '' && settings.researchToken.trim() !== '';
  const uploadedTag = (session.tags ?? []).find((t) => t.startsWith('uploaded:'));
  const isTimedSource = session.sensor.source === 'healthkit' || session.sensor.source === 'health-connect';
  const canImportHealth = healthStore.source != null && session.status !== 'recording';

  const guarded = (key: string, title: string, fn: () => Promise<void>) =>
    void run(key, async () => {
      try {
        await fn();
      } catch (e) {
        notify(title, errorMessage(e));
      }
    });

  const exportJson = () => guarded('json', 'Export failed', () => shareBundle([session], { deidentify: true, profile }));
  const exportCsv = (kind: 'samples' | 'rr' | 'events') => guarded(`csv-${kind}`, 'Export failed', () => shareSessionCsv(session, kind));

  const importHealth = () =>
    guarded('health', `Could not import from ${healthStore.label}`, async () => {
      const n = await useRecording.getState().importFromHealth(session.id);
      await reload();
      show(n > 0 ? `Imported ${n} heart-rate samples from ${healthStore.label}` : `No new data found in ${healthStore.label}`);
    });

  const upload = () =>
    guarded('upload', 'Upload failed', async () => {
      const res = await uploadSessions([session], { url: settings.researchServerUrl, token: settings.researchToken, profile });
      await useSessions.getState().refresh();
      await reload();
      if (res.rejected.length) notify('Upload rejected', res.rejected.map((r) => r.reason).join('\n'));
      else show('Uploaded to the study server');
    });

  const remove = async () => {
    const ok = await confirmAsync({
      title: 'Delete this session?',
      message: 'Heart-rate data, events and the debrief for this case will be permanently deleted from this device.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    guarded('delete', 'Could not delete', async () => {
      await useSessions.getState().deleteSession(session.id);
      if (router.canGoBack()) router.back();
      else router.replace('/history');
    });
  };

  const detailChips = [
    p.role ? ROLE_LABELS[p.role] : null,
    p.approach ? APPROACH_LABELS[p.approach] : null,
    p.urgency ? URGENCY_LABELS[p.urgency] : null,
    p.complexity ? `Complexity: ${COMPLEXITY_LABELS[p.complexity]}` : null,
    SENSOR_SOURCE_LABELS[session.sensor.source],
  ].filter((x): x is string => !!x);

  return (
    <View style={styles.fill}>
      <Stack.Screen options={{ title: p.name.length > 28 ? 'Session' : p.name }} />
      <Screen testID="session-detail">
        <View style={styles.header}>
          <AppText variant="title">{p.name}</AppText>
          <AppText variant="body" tone="muted">
            {formatDateTime(session.startedAt)} · {formatDuration(summary.durationSec)}
            {p.specialty ? ` · ${p.specialty}` : ''}
          </AppText>
          <View style={styles.chips}>
            {detailChips.map((c) => (
              <Chip key={c} label={c} />
            ))}
            {session.status !== 'completed' ? <Chip label={SESSION_STATUS_LABELS[session.status]} tone="warning" /> : null}
            {(session.tags ?? []).includes('demo') ? <Chip label="Demo data" tone="warning" /> : null}
            {uploadedTag ? <Chip label="Uploaded" tone="success" icon="cloud-done-outline" /> : null}
          </View>
        </View>

        {session.status === 'recording' ? (
          <Banner tone="warning" title="Unfinished session" message="This case was interrupted while recording. Its data is shown up to the last saved point." />
        ) : null}
        {session.sensor.source === 'simulated' ? <Banner tone="info" message="Simulated data — for demos and training only." live={false} /> : null}
        {isTimedSource && session.samples.length === 0 ? (
          <Banner
            tone="info"
            title="Heart rate not imported yet"
            message={`Import the data recorded by your watch from ${healthStore.label} using the action below.`}
          />
        ) : null}

        <StatGrid>
          <StatTile label="Mean HR" value={formatNumber(summary.hr?.mean ?? null)} unit="bpm" />
          <StatTile label="Peak HR" value={formatNumber(summary.hr?.max ?? null)} unit="bpm" />
          <StatTile
            label="vs resting"
            value={formatDelta(summary.meanHrDelta)}
            unit="bpm"
            detail={summary.baseline ? `Baseline ${Math.round(summary.baseline.restingHr)} bpm` : 'No baseline'}
          />
          <StatTile label="RMSSD" value={formatNumber(summary.hrv?.rmssd ?? null)} unit="ms" detail={summary.hrv ? `SDNN ${Math.round(summary.hrv.sdnn)} ms` : 'Needs RR data'} />
          <StatTile label="Stress index" value={formatNumber(summary.stressIndex, 0)} detail="Baevsky SI" />
          <StatTile
            label="Episodes"
            value={String(summary.episodes.length)}
            detail={summary.episodes.length ? `${episodeMinutes.toFixed(1)} min above threshold` : 'Sustained HR rises'}
          />
          <StatTile label="Workload" value={formatNumber(workload, 0)} unit="/100" detail={summary.workload ? 'SURG-TLX' : 'No debrief'} />
        </StatGrid>

        <Card>
          <HrTimelineChart
            title="Heart rate"
            samples={session.samples}
            startedAt={session.startedAt}
            endedAt={summary.endedAt}
            phases={summary.phases}
            events={session.events}
            baselineBpm={summary.baseline?.restingHr ?? null}
            thresholdBpm={threshold}
            height={240}
            testID="session-hr-chart"
          />
        </Card>

        <Card>
          <RollingHrvChart
            title="Heart-rate variability"
            subtitle="RMSSD in 1-minute windows (higher usually means more recovered / less stressed)"
            points={rolling}
            startedAt={session.startedAt}
            endedAt={summary.endedAt}
            phases={summary.phases}
          />
        </Card>

        <Card>
          <ZoneBar title="Time in zones" subtitle={summary.baseline ? 'Relative to your resting baseline' : 'Percent of max heart rate'} zones={summary.zones} />
        </Card>

        <Card>
          <PhaseBars title="Heart rate by phase" phases={summary.phases} />
          {summary.phases.length ? (
            <View style={styles.table} accessibilityLabel="Phase table">
              <View style={[styles.tr, styles.th]}>
                <AppText variant="caption" tone="muted" style={styles.tdName}>
                  Phase
                </AppText>
                <AppText variant="caption" tone="muted" style={styles.tdTime}>
                  Time
                </AppText>
                <AppText variant="caption" tone="muted" style={styles.td}>
                  HR
                </AppText>
                <AppText variant="caption" tone="muted" style={styles.td}>
                  Δ rest
                </AppText>
                <AppText variant="caption" tone="muted" style={styles.td}>
                  RMSSD
                </AppText>
              </View>
              {summary.phases.map((ph) => (
                <View
                  key={`${ph.phase}-${ph.index}`}
                  style={styles.tr}
                  accessible
                  accessibilityLabel={`${PHASE_LABELS[ph.phase]}: ${formatDuration(ph.durationSec)}, mean heart rate ${formatNumber(ph.hr?.mean ?? null)}, change ${formatDelta(ph.meanHrDelta)}, RMSSD ${formatNumber(ph.hrv?.rmssd ?? null)}`}
                >
                  <View style={[styles.tdName, styles.phaseName]}>
                    <View style={[styles.dot, { backgroundColor: PHASE_COLORS[ph.phase] }]} />
                    <AppText variant="label" numberOfLines={2} style={styles.flex}>
                      {PHASE_LABELS[ph.phase]}
                    </AppText>
                  </View>
                  <AppText variant="label" tabular style={styles.tdTime} numberOfLines={1}>
                    {formatDuration(ph.durationSec)}
                  </AppText>
                  <AppText variant="label" tabular style={styles.td}>
                    {formatNumber(ph.hr?.mean ?? null)}
                  </AppText>
                  <AppText variant="label" tabular style={styles.td}>
                    {formatDelta(ph.meanHrDelta)}
                  </AppText>
                  <AppText variant="label" tabular style={styles.td}>
                    {formatNumber(ph.hrv?.rmssd ?? null)}
                  </AppText>
                </View>
              ))}
            </View>
          ) : null}
        </Card>

        <Card title="Stress episodes" subtitle={threshold != null ? `Sustained HR ≥ ${Math.round(threshold)} bpm for at least a minute` : 'Needs heart-rate data'}>
          {summary.episodes.length === 0 ? (
            <AppText variant="label" tone="muted">
              No sustained heart-rate rises were detected.
            </AppText>
          ) : (
            summary.episodes.map((ep, i) => {
              const related = ep.relatedEventIds
                .map((eid) => eventsById.get(eid))
                .filter((e): e is NonNullable<typeof e> => e != null)
                .map((e) => (e.type === 'phase' ? PHASE_LABELS[e.phase] : MARKER_LABELS[e.marker]));
              return (
                <View key={`${ep.start}-${i}`} style={styles.episode} accessible>
                  <AppText variant="bodyStrong">
                    {formatElapsed(ep.start - session.startedAt, true)}–{formatElapsed(ep.end - session.startedAt, true)} · {formatDuration(ep.durationSec)}
                  </AppText>
                  <AppText variant="label" tone="muted">
                    Peak {Math.round(ep.peakBpm)} bpm, mean {Math.round(ep.meanBpm)} bpm{ep.phase ? ` · during ${PHASE_LABELS[ep.phase]}` : ''}
                  </AppText>
                  {related.length ? (
                    <AppText variant="caption" tone="faint">
                      Around: {related.join(', ')}
                    </AppText>
                  ) : null}
                </View>
              );
            })
          )}
        </Card>

        <PostOpCard session={session} summary={summary} />

        <Card title="Data quality" icon="pulse-outline">
          <StatGrid>
            <StatTile label="Coverage" value={formatPercent(summary.quality.coverage)} detail="of the case with HR data" />
            <StatTile label="Gaps" value={String(summary.quality.gapCount)} detail={summary.quality.gapCount ? `Longest ${formatDuration(summary.quality.longestGapSec)}` : 'No dropouts'} />
            <StatTile
              label="RR artefacts"
              value={summary.quality.rrArtifactRatio == null ? '—' : formatPercent(summary.quality.rrArtifactRatio, 1)}
              detail={summary.quality.rrArtifactRatio == null ? 'No beat-to-beat data' : 'Removed before HRV'}
            />
            <StatTile label="Sample rate" value={formatNumber(summary.quality.sampleRateHz, 2)} unit="Hz" />
          </StatGrid>
          {summary.quality.coverage < 0.8 && session.samples.length > 0 ? (
            <AppText variant="caption" tone="warning">
              Coverage is low. Moisten the strap electrodes and fit it snugly below the chest muscles for better contact.
            </AppText>
          ) : null}
        </Card>

        <SectionHeader title="Actions" />
        <ListGroup>
          <ListRow
            icon="create-outline"
            title="Edit events & times"
            subtitle={`${session.events.length} event${session.events.length === 1 ? '' : 's'} — correct times, add or remove`}
            onPress={() => router.push(`/session/events/${session.id}`)}
            testID="session-edit-events"
          />
          <ListRow icon="share-outline" title="Export session (JSON)" subtitle="De-identified" disabled={busy != null} onPress={exportJson} />
          <ListRow icon="grid-outline" title="Export heart rate (CSV)" disabled={busy != null || session.samples.length === 0} onPress={() => exportCsv('samples')} />
          <ListRow icon="grid-outline" title="Export RR intervals (CSV)" disabled={busy != null || session.rr.length === 0} onPress={() => exportCsv('rr')} />
          <ListRow icon="grid-outline" title="Export events (CSV)" disabled={busy != null || session.events.length === 0} onPress={() => exportCsv('events')} />
          {canImportHealth ? (
            <ListRow
              icon="download-outline"
              title={`Import from ${healthStore.label}`}
              subtitle="Merge heart rate recorded by your watch during this case"
              disabled={busy != null}
              onPress={importHealth}
            />
          ) : null}
          {researchConfigured && session.status === 'completed' ? (
            <ListRow
              icon="cloud-upload-outline"
              title={uploadedTag ? 'Upload again' : 'Upload to study server'}
              subtitle={uploadedTag ? `Last uploaded ${formatDateTime(Date.parse(uploadedTag.slice('uploaded:'.length)))}` : 'De-identified'}
              disabled={busy != null}
              onPress={upload}
            />
          ) : null}
          <ListRow icon="trash-outline" title="Delete session" destructive disabled={busy != null} onPress={() => void remove()} />
        </ListGroup>
        <AppText variant="caption" tone="faint" align="center">
          Research tool — not a medical device. Values describe your physiology during the case; they are not
          a diagnosis or a performance grade.
        </AppText>
      </Screen>
      <Toast visible={!!toast} message={toast?.message ?? ''} toastKey={toast?.key} onDismiss={hide} />
    </View>
  );
}

function PostOpCard({ session, summary }: { session: SurgicalSession; summary: SessionSummary }) {
  const styles = useStyles(makeStyles);
  const post = session.postOp;
  if (!post || Object.keys(post).length === 0) {
    return (
      <Card title="Post-op report" icon="clipboard-outline">
        <AppText variant="label" tone="muted">
          No debrief was recorded for this case.
        </AppText>
      </Card>
    );
  }
  const w = summary.workload;
  return (
    <Card title="Post-op report" icon="clipboard-outline">
      {w ? (
        <View style={styles.dims}>
          <View style={styles.dimRow}>
            <AppText variant="bodyStrong" style={styles.flex}>
              SURG-TLX workload
            </AppText>
            <AppText variant="bodyStrong" tabular>
              {formatNumber(w.weighted ?? w.raw, 1)}
              {w.weighted != null ? ' (weighted)' : ''}
            </AppText>
          </View>
          {SURG_TLX_DIMENSIONS.map((d) => {
            const v = w.dimensions[d.id];
            return (
              <View key={d.id} style={styles.dimRow} accessible accessibilityLabel={`${d.label} ${formatNumber(v ?? null)} out of 100`}>
                <AppText variant="label" tone="muted" style={styles.dimLabel}>
                  {d.label}
                </AppText>
                <View style={styles.dimTrack}>
                  <View style={[styles.dimFill, { width: `${Math.max(0, Math.min(100, v ?? 0))}%` }]} />
                </View>
                <AppText variant="label" tabular style={styles.dimValue}>
                  {formatNumber(v ?? null)}
                </AppText>
              </View>
            );
          })}
        </View>
      ) : null}
      <View style={styles.kv}>
        {post.performance != null ? <KeyValue k="Self-rated performance" v={`${post.performance} / 10`} /> : null}
        {post.perceivedStress != null ? <KeyValue k="Perceived stress" v={`${post.perceivedStress} / 10`} /> : null}
        {post.sleepHours != null ? <KeyValue k="Sleep the night before" v={`${post.sleepHours} h`} /> : null}
        {post.caffeine != null ? <KeyValue k="Caffeine within 2 h" v={post.caffeine ? 'Yes' : 'No'} /> : null}
        {post.outcome ? <KeyValue k="Outcome" v={OUTCOME_LABELS[post.outcome]} /> : null}
      </View>
      {post.notes ? (
        <AppText variant="label" tone="muted" style={styles.notes}>
          “{post.notes}”
        </AppText>
      ) : null}
    </Card>
  );
}

function KeyValue({ k, v }: { k: string; v: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.dimRow} accessible accessibilityLabel={`${k}: ${v}`}>
      <AppText variant="label" tone="muted" style={styles.flex}>
        {k}
      </AppText>
      <AppText variant="label">{v}</AppText>
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    fill: { flex: 1 },
    flex: { flex: 1 },
    header: { gap: t.space.xs },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.xs, marginTop: t.space.xs },
    table: { marginTop: t.space.sm },
    tr: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: t.space.xs + 2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.colors.border,
      gap: t.space.xs,
    },
    th: { paddingBottom: t.space.xs },
    tdName: { flex: 2.4 },
    tdTime: { flex: 1.4, textAlign: 'right' },
    phaseName: { flexDirection: 'row', alignItems: 'center', gap: t.space.xs },
    td: { flex: 1, textAlign: 'right' },
    dot: { width: 10, height: 10, borderRadius: 5 },
    episode: {
      gap: 2,
      paddingVertical: t.space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.colors.border,
    },
    dims: { gap: t.space.xs },
    dimRow: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm, minHeight: 24 },
    dimLabel: { width: 130 },
    dimTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: t.colors.surfaceAlt, overflow: 'hidden' },
    dimFill: { height: '100%', backgroundColor: t.colors.chartSecondary, borderRadius: 4 },
    dimValue: { width: 32, textAlign: 'right' },
    kv: { gap: t.space.xs, marginTop: t.space.xs },
    notes: { fontStyle: 'italic' },
  });
