/**
 * Insights: plain-language reflection cards (core `generateInsights`), a
 * per-session trend for a chosen metric (core `metricSeries` + `linearTrend`)
 * and a by-procedure comparison (core `aggregateMetric`). Framed as
 * reflection, never as evaluation.
 */
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { METRICS, aggregateMetric, generateInsights, metricSeries } from '@surgeonpulse/core';
import type { MetricKey } from '@surgeonpulse/core';

import { AppText } from '@/components/AppText';
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
import { useSummaries } from '@/hooks/useSummaries';
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
  const summaries = useSummaries();
  const loading = useSessions((s) => s.loading);
  const [metric, setMetric] = useState<MetricKey>('meanHrDelta');
  const { busy, run } = useBusy();

  const insights = useMemo(() => generateInsights(summaries), [summaries]);
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
        <AppText variant="body" tone="muted">
          Patterns across your {summaries.length} completed session{summaries.length === 1 ? '' : 's'}. These are prompts
          for reflection — physiological responses vary for many reasons, and none of this is a judgement of performance.
        </AppText>
      </View>

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

      {summaries.length < 3 ? (
        <Card icon="sparkles-outline" title="Want to explore first?">
          <AppText variant="label" tone="muted">
            Load a set of simulated sessions (tagged “Demo”) to see what Insights looks like with more data. You can
            delete them later in Settings.
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
