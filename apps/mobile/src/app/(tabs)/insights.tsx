/**
 * Insights: plain-language reflection cards (core `generateInsights`), a
 * per-session trend for a chosen metric (core `metricSeries` + `linearTrend`)
 * and a by-procedure comparison (core `aggregateMetric`). Framed as
 * reflection, never as evaluation.
 *
 * Only the participant's own cases are "your" insights. Demo and simulator
 * sessions are shown separately (clearly labelled), either because there are
 * no own cases yet or when the participant switches to the demo view.
 */
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { METRICS, aggregateMetric, generateInsights, metricSeries } from '@surgeonpulse/core';
import type { MetricKey } from '@surgeonpulse/core';

import { AppText } from '@/components/AppText';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { notify } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { InsightCard } from '@/components/InsightCard';
import { Screen } from '@/components/Screen';
import { SegmentedControl } from '@/components/SegmentedControl';
import { GroupBarChart } from '@/components/charts/GroupBarChart';
import { TrendChart } from '@/components/charts/TrendChart';
import { errorMessage, useBusy } from '@/hooks/useBusy';
import { useInsightSources } from '@/hooks/useSummaries';
import { useSessions } from '@/state/sessions';
import { useStyles, type Theme } from '@/theme';

const TREND_METRICS: readonly MetricKey[] = ['meanHrDelta', 'rmssd', 'workload'];

const SHORT_LABEL: Partial<Record<MetricKey, string>> = {
  meanHrDelta: 'HR vs rest',
  rmssd: 'HRV',
  workload: 'Workload',
};

export default function InsightsScreen() {
  const styles = useStyles(makeStyles);
  const { own, practice } = useInsightSources();
  const loading = useSessions((s) => s.loading);
  const [metric, setMetric] = useState<MetricKey>('meanHrDelta');
  const [view, setView] = useState<'own' | 'demo'>('own');
  const { busy, run } = useBusy();

  // Demo/simulator data is shown only on its own: when there are no own cases yet, or on request.
  const showingDemo = practice.summaries.length > 0 && (own.summaries.length === 0 || view === 'demo');
  const data = showingDemo ? practice : own;
  const summaries = data.summaries;
  const hasDemo = practice.sessions.some((s) => s.tags?.includes('demo'));
  const insights = useMemo(() => generateInsights(data.summaries, { sessions: data.sessions }), [data]);
  const series = useMemo(() => metricSeries(summaries, metric), [summaries, metric]);
  const byProcedure = useMemo(() => aggregateMetric(summaries, metric, 'procedure'), [summaries, metric]);
  const info = METRICS[metric];

  const loadDemo = () =>
    void run('demo', async () => {
      try {
        await useSessions.getState().loadDemoData();
      } catch (e) {
        notify('Could not load demo data', errorMessage(e));
      }
    });

  if (summaries.length === 0) {
    return (
      <Screen testID="insights">
        <EmptyState
          icon="analytics-outline"
          title="Insights appear after your first cases"
          message="Complete a few recorded cases (with the debrief) to see how your heart rate and workload vary by phase, procedure and over time. Or load simulated demo data to explore."
        >
          <Button
            label="Load demo data"
            variant="primary"
            icon="sparkles-outline"
            loading={busy === 'demo' || loading}
            onPress={loadDemo}
            testID="insights-load-demo"
          />
        </EmptyState>
      </Screen>
    );
  }

  return (
    <Screen testID="insights" onRefresh={() => void useSessions.getState().refresh()} refreshing={loading}>
      <View style={styles.intro}>
        <AppText variant="title">Insights</AppText>
        <AppText variant="body" tone="muted" testID="insights-intro">
          {showingDemo
            ? `Patterns across ${summaries.length} simulated session${summaries.length === 1 ? '' : 's'} (demo data and simulator recordings). `
            : `Patterns across your ${summaries.length} completed session${summaries.length === 1 ? '' : 's'}. `}
          These are prompts for reflection — physiological responses vary for many reasons, and none of this is a
          judgement of performance.
        </AppText>
      </View>

      {own.summaries.length > 0 && practice.summaries.length > 0 ? (
        <SegmentedControl
          options={[
            { value: 'own', label: `Your cases (${own.summaries.length})`, accessibilityLabel: `Your cases, ${own.summaries.length}` },
            { value: 'demo', label: `Demo (${practice.summaries.length})`, accessibilityLabel: `Demo and simulator sessions, ${practice.summaries.length}` },
          ]}
          value={view}
          onChange={setView}
          accessibilityLabel="Which sessions to show"
          testID="insights-view"
        />
      ) : null}
      {showingDemo ? (
        <Banner
          tone="warning"
          title="Simulated data — not your cases"
          message={
            own.summaries.length === 0
              ? 'These show what Insights looks like. Your own recorded cases replace them here once you complete one. Demo data can be deleted in Settings.'
              : 'Demo data and simulator recordings are kept out of your own Insights.'
          }
          live={false}
          testID="insights-demo-banner"
        />
      ) : null}

      {insights.length > 0 ? (
        <View style={styles.list}>
          {insights.map((i) => (
            <InsightCard key={i.id} insight={i} testID={`insight-${i.id}`} />
          ))}
        </View>
      ) : (
        <Card icon="hourglass-outline" title="Keep recording">
          <AppText variant="label" tone="muted">
            Most observations need at least three to five sessions. They will appear here automatically.
          </AppText>
        </Card>
      )}

      <Card title="Over time" subtitle={`${info.label}${info.unit ? ` (${info.unit})` : ''} per session`}>
        <SegmentedControl
          options={TREND_METRICS.map((k) => ({ value: k, label: SHORT_LABEL[k] ?? METRICS[k].label, accessibilityLabel: METRICS[k].label }))}
          value={metric}
          onChange={setMetric}
          accessibilityLabel="Metric"
          testID="insights-metric"
        />
        <TrendChart points={series} label={info.label} unit={info.unit} decimals={info.decimals} testID="insights-trend" />
      </Card>

      <Card title="By procedure" subtitle={`${info.label}: mean ± SD per procedure`}>
        <GroupBarChart groups={byProcedure} label={info.label} unit={info.unit} decimals={info.decimals} testID="insights-groups" />
      </Card>

      {!hasDemo && own.summaries.length < 3 ? (
        <Card icon="sparkles-outline" title="Want to explore first?">
          <AppText variant="label" tone="muted">
            Load a set of simulated sessions (tagged “Demo”) to see what Insights looks like with more data. They are
            kept apart from your own cases, and you can delete them later in Settings.
          </AppText>
          <Button
            label="Load demo data"
            icon="sparkles-outline"
            loading={busy === 'demo'}
            onPress={loadDemo}
          />
        </Card>
      ) : null}
    </Screen>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    intro: { gap: t.space.xs },
    list: { gap: t.space.md },
  });
