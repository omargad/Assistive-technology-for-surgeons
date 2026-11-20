/**
 * Resting baseline: a 1–5 minute countdown (default from settings) while the
 * surgeon sits or stands quietly, with live heart rate. Finishes
 * automatically; the result is shown before recording starts. Skippable.
 */
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { formatClock } from '@surgeonpulse/core';

import { AppText } from '@/components/AppText';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { ProgressRing } from '@/components/ProgressRing';
import { Screen } from '@/components/Screen';
import { openLiveScreen } from '@/components/navigation';
import { SegmentedControl } from '@/components/SegmentedControl';
import { SensorStatusPill } from '@/components/SensorStatusPill';
import { StatGrid, StatTile } from '@/components/StatTile';
import { useBusy } from '@/hooks/useBusy';
import { useElapsed } from '@/hooks/useNow';
import { useRecording } from '@/state/recording';
import { useSettings } from '@/state/settings';
import { formatNumber, useStyles, useTheme, type Theme } from '@/theme';

const DURATIONS = [1, 2, 3, 4, 5].map((m) => ({ value: m * 60, label: `${m} min`, accessibilityLabel: `${m} minute${m === 1 ? '' : 's'}` }));

export default function BaselineScreen() {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const stage = useRecording((s) => s.stage);
  const startedAt = useRecording((s) => s.baselineStartedAt);
  const storeDuration = useRecording((s) => s.baselineDurationSec);
  const baseline = useRecording((s) => s.baseline);
  const currentBpm = useRecording((s) => s.currentBpm);
  const sensorStatus = useRecording((s) => s.sensorStatus);
  const error = useRecording((s) => s.error);
  const defaultDuration = useSettings((s) => s.settings.baselineDurationSec);
  const [duration, setDuration] = useState(defaultDuration);
  const { busy, run } = useBusy();

  const running = stage === 'baseline';
  const elapsed = useElapsed(running ? startedAt : null, 250);
  const totalMs = (running ? storeDuration : duration) * 1000;
  const remaining = Math.max(0, totalMs - elapsed);
  const progress = running ? Math.min(1, elapsed / totalMs) : stage === 'ready' && baseline ? 1 : 0;

  useEffect(() => {
    if (running && startedAt != null && remaining <= 0) useRecording.getState().finishBaseline();
  }, [running, startedAt, remaining]);

  const startRecording = () =>
    run('record', async () => {
      await useRecording.getState().startRecording();
      if (useRecording.getState().stage === 'recording') openLiveScreen();
    });

  const skip = () =>
    run('record', async () => {
      useRecording.getState().skipBaseline();
      await useRecording.getState().startRecording();
      if (useRecording.getState().stage === 'recording') openLiveScreen();
    });

  const ready = stage === 'ready';

  const footer = ready ? (
    <View style={styles.row}>
      <Button label="Redo baseline" onPress={() => void useRecording.getState().startBaseline(duration)} style={styles.grow} />
      <Button
        label="Start recording"
        variant="primary"
        icon="radio-button-on"
        loading={busy === 'record'}
        onPress={() => void startRecording()}
        style={styles.grow}
        testID="baseline-start-recording"
      />
    </View>
  ) : running ? (
    <View style={styles.row}>
      <Button label="Finish early" onPress={() => useRecording.getState().finishBaseline()} style={styles.flex} />
      <Button label="Skip baseline" variant="ghost" loading={busy === 'record'} onPress={() => void skip()} style={styles.flex} />
    </View>
  ) : (
    <View style={styles.row}>
      <Button label="Skip" loading={busy === 'record'} onPress={() => void skip()} style={styles.flex} testID="baseline-skip" />
      <Button
        label="Start baseline"
        variant="primary"
        icon="timer-outline"
        onPress={() => void useRecording.getState().startBaseline(duration)}
        style={styles.flex}
        testID="baseline-start"
      />
    </View>
  );

  return (
    <Screen edges={['left', 'right', 'bottom']} footer={footer} testID="record-baseline">
      <AppText variant="body" tone="muted">
        Sit or stand quietly and breathe normally — ideally before scrubbing. This resting reference makes your
        intra-operative changes meaningful.
      </AppText>

      <View style={styles.center}>
        <ProgressRing progress={progress} size={220} strokeWidth={10} color={theme.colors.primary}>
          <AppText
            variant="display"
            tabular
            accessibilityRole="timer"
            accessibilityLabel={running ? `${Math.ceil(remaining / 1000)} seconds remaining` : undefined}
          >
            {ready ? 'Done' : formatClock(remaining).slice(3)}
          </AppText>
          <AppText variant="label" tone="muted">
            {running ? 'remaining' : ready ? 'baseline recorded' : 'baseline length'}
          </AppText>
        </ProgressRing>
        <View style={styles.liveHr} accessible accessibilityLabel={currentBpm != null ? `Current heart rate ${Math.round(currentBpm)} beats per minute` : 'Waiting for heart rate'}>
          <AppText variant="title" tabular>
            {currentBpm != null ? Math.round(currentBpm) : '--'}
          </AppText>
          <AppText variant="label" tone="muted">
            bpm now
          </AppText>
        </View>
        <SensorStatusPill status={sensorStatus} compact />
      </View>

      {!running && !ready ? (
        <Card title="Length">
          <SegmentedControl options={DURATIONS} value={duration} onChange={setDuration} accessibilityLabel="Baseline length" size="sm" />
        </Card>
      ) : null}

      {ready && baseline ? (
        <Card title="Your resting baseline" icon="checkmark-circle" tone="success">
          <StatGrid>
            <StatTile label="Resting HR" value={formatNumber(baseline.restingHr)} unit="bpm" />
            <StatTile label="RMSSD" value={formatNumber(baseline.rmssd ?? null)} unit="ms" detail={baseline.rmssd == null ? 'Needs beat-to-beat data' : undefined} />
          </StatGrid>
        </Card>
      ) : null}
      {ready && !baseline ? (
        <Banner
          tone="warning"
          title="No baseline captured"
          message="Not enough heart-rate data arrived. You can redo it, or start without one (your profile resting HR will be used if set)."
        />
      ) : null}
      {error ? <Banner tone="danger" message={error} /> : null}
    </Screen>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    flex: { flex: 1 },
    /** Share spare room but start from the label's own width (a 0 basis wraps long labels). */
    grow: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto' },
    row: { flexDirection: 'row', gap: t.space.sm },
    center: { alignItems: 'center', gap: t.space.lg, paddingVertical: t.space.lg },
    liveHr: { flexDirection: 'row', alignItems: 'baseline', gap: t.space.xs },
  });
