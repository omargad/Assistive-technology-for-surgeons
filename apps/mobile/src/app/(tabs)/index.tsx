/**
 * Record home: start a new case, see sensor readiness, return to a case in
 * progress, and glance at the most recent session.
 */
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { router, type Href } from 'expo-router';

import { SENSOR_SOURCE_LABELS, formatClock } from '@surgeonpulse/core';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Screen } from '@/components/Screen';
import { SensorStatusPill } from '@/components/SensorStatusPill';
import { SessionRow } from '@/components/SessionRow';
import { useElapsed } from '@/hooks/useNow';
import type { RecordingStage } from '@/state/types';
import { useRecording } from '@/state/recording';
import { useSessions } from '@/state/sessions';
import { useSettings } from '@/state/settings';
import { useStyles, type Theme } from '@/theme';

/** Where to continue an unfinished flow. */
const RESUME_ROUTE: Partial<Record<RecordingStage, Href>> = {
  setup: '/record/setup',
  baseline: '/record/baseline',
  ready: '/record/baseline',
  recording: '/record/live',
  debrief: '/record/debrief',
};

export default function RecordHome() {
  const styles = useStyles(makeStyles);
  const stage = useRecording((s) => s.stage);
  const liveSession = useRecording((s) => s.session);
  const sensorStatus = useRecording((s) => s.sensorStatus);
  const settings = useSettings((s) => s.settings);
  const profile = useSessions((s) => s.profile);
  const items = useSessions((s) => s.items);
  const elapsed = useElapsed(stage === 'recording' ? liveSession?.startedAt : null);

  const lastCompleted = useMemo(() => items.find((i) => i.meta.status === 'completed'), [items]);
  const resume = RESUME_ROUTE[stage];

  const startCase = () => {
    useRecording.getState().beginSetup();
    router.push('/record/setup');
  };

  return (
    <Screen testID="record-home">
      <View style={styles.hero}>
        <AppText variant="overline" tone="muted">
          {profile?.code ? `Participant ${profile.code}` : 'SurgeonPulse'}
        </AppText>
        <AppText variant="title">{stage === 'recording' ? 'Case in progress' : 'Ready for a case?'}</AppText>
        <AppText variant="body" tone="muted">
          Put the strap on a few minutes before scrubbing so the signal settles, then start a case and record a short
          resting baseline.
        </AppText>
      </View>

      {resume ? (
        <Card
          tone="primary"
          icon={stage === 'recording' ? 'radio-button-on' : 'play-circle-outline'}
          title={
            stage === 'recording'
              ? `Recording · ${formatClock(elapsed)}`
              : stage === 'debrief'
                ? 'Debrief waiting'
                : 'Case setup in progress'
          }
          subtitle={liveSession?.procedure.name ?? undefined}
        >
          <Button
            label={stage === 'recording' ? 'Return to live screen' : stage === 'debrief' ? 'Complete debrief' : 'Continue setup'}
            variant="primary"
            icon="arrow-forward"
            onPress={() => router.push(resume)}
            testID="record-resume"
          />
        </Card>
      ) : (
        <Button label="Start new case" variant="primary" size="lg" icon="add-circle-outline" onPress={startCase} testID="record-start" />
      )}

      <Card
        icon="bluetooth"
        title="Heart-rate sensor"
        subtitle={
          settings.preferredSource
            ? [SENSOR_SOURCE_LABELS[settings.preferredSource], settings.preferredDeviceName].filter(Boolean).join(' · ')
            : 'No sensor chosen yet — you can pick one during setup.'
        }
        right={<Button label="Manage" size="sm" variant="ghost" onPress={() => router.push('/sensors')} />}
      >
        {sensorStatus.state !== 'idle' ? <SensorStatusPill status={sensorStatus} /> : null}
        <AppText variant="caption" tone="faint">
          Chest straps such as the Polar H10 give beat-to-beat data for HRV. Apple Watch and Wear OS data can be
          imported after the case. The simulator is for demos and training.
        </AppText>
      </Card>

      {lastCompleted ? (
        <View style={styles.section}>
          <AppText variant="subheading" accessibilityRole="header">
            Last session
          </AppText>
          <SessionRow item={lastCompleted} onPress={() => router.push(`/session/${lastCompleted.meta.id}`)} />
        </View>
      ) : null}

      <AppText variant="caption" tone="faint" align="center" onPress={() => router.push('/about')}>
        Research tool — not a medical device. About & data handling ›
      </AppText>
    </Screen>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    hero: { gap: t.space.xs, paddingTop: t.space.sm },
    section: { gap: t.space.sm },
  });
