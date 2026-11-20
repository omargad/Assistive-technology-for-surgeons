/**
 * Case setup: procedure (catalogue or custom), role / approach / urgency /
 * complexity, and the heart-rate source (connect a strap, the browser chooser,
 * a health-store "timed" session, or the simulator). Also used to reconnect a
 * sensor when resuming an interrupted session.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Stack, router } from 'expo-router';

import { APPROACH_LABELS, COMPLEXITY_LABELS, ROLE_LABELS, URGENCY_LABELS } from '@surgeonpulse/core';
import type { ProcedureInfo, SurgeonRole, SurgicalApproach, Urgency } from '@surgeonpulse/core';

import { AppText } from '@/components/AppText';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { confirmAsync } from '@/components/ConfirmDialog';
import { SectionHeader } from '@/components/Controls';
import { Icon, type IconName } from '@/components/Icon';
import { ProcedurePicker, type ProcedureChoice } from '@/components/ProcedurePicker';
import { Screen } from '@/components/Screen';
import { openLiveScreen } from '@/components/navigation';
import { SegmentedControl } from '@/components/SegmentedControl';
import { SensorStatusPill } from '@/components/SensorStatusPill';
import { useBusy } from '@/hooks/useBusy';
import { availableSources, type SourceOption } from '@/services/sensors/registry';
import type { SourceChoice } from '@/services/sensors/types';
import { useRecording } from '@/state/recording';
import { useSettings } from '@/state/settings';
import { useStyles, useTheme, type Theme } from '@/theme';

const ROLES = Object.keys(ROLE_LABELS) as SurgeonRole[];
const APPROACHES = Object.keys(APPROACH_LABELS) as SurgicalApproach[];
const URGENCIES = Object.keys(URGENCY_LABELS) as Urgency[];
const COMPLEXITIES = [1, 2, 3, 4, 5] as const;

const SOURCE_ICON: Record<SourceChoice, IconName> = {
  ble: 'bluetooth',
  'web-bluetooth': 'bluetooth',
  healthkit: 'watch-outline',
  'health-connect': 'watch-outline',
  simulated: 'pulse-outline',
};

export default function SetupScreen() {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const stage = useRecording((s) => s.stage);
  const storedProcedure = useRecording((s) => s.procedure);
  const resumeSession = useRecording((s) => s.session);
  const sourceChoice = useRecording((s) => s.sourceChoice);
  const sensorStatus = useRecording((s) => s.sensorStatus);
  const sensor = useRecording((s) => s.sensor);
  const timedOnly = useRecording((s) => s.timedOnly);
  const error = useRecording((s) => s.error);
  const settings = useSettings((s) => s.settings);
  const [sources, setSources] = useState<SourceOption[] | null>(null);
  const [procedure, setProcedureLocal] = useState<ProcedureInfo | null>(storedProcedure);
  const { busy, run } = useBusy();

  const resuming = resumeSession != null;

  // Deep link / reload safety: make sure a setup flow exists.
  useEffect(() => {
    if (useRecording.getState().stage === 'idle') useRecording.getState().beginSetup();
  }, []);

  useEffect(() => {
    let alive = true;
    availableSources()
      .then((list) => {
        if (alive) setSources(list);
      })
      .catch(() => {
        if (alive) setSources([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Pre-select the remembered source once options are known.
  useEffect(() => {
    if (!sources || sourceChoice) return;
    const preferred = settings.preferredSource;
    const option = sources.find((o) => o.choice === preferred && o.supported);
    if (option) void useRecording.getState().chooseSource(option.choice);
  }, [sources, sourceChoice, settings.preferredSource]);

  const updateProcedure = (patch: Partial<ProcedureInfo>) => {
    const next: ProcedureInfo = { ...(procedure ?? { name: '' }), ...patch };
    setProcedureLocal(next);
    if (next.name) useRecording.getState().setProcedure(next);
  };

  const onPickProcedure = (choice: ProcedureChoice) => {
    const next: ProcedureInfo = {
      ...procedure,
      name: choice.name,
      catalogId: choice.catalogId,
      specialty: choice.specialty,
      approach: choice.approach ?? procedure?.approach,
    };
    if (!choice.catalogId) delete next.catalogId;
    setProcedureLocal(next);
    useRecording.getState().setProcedure(next);
  };

  const connected = sensorStatus.state === 'connected' || sensorStatus.state === 'streaming';
  const selectedOption = sources?.find((o) => o.choice === sourceChoice) ?? null;
  const isLive = selectedOption ? selectedOption.live : !timedOnly;
  const hasProcedure = !!procedure?.name;
  const sensorReady = sourceChoice != null && (isLive ? connected && sensor != null : true);
  const canContinue = hasProcedure && sensorReady && stage !== 'recording';

  const connect = (deviceId?: string) => run('connect', () => useRecording.getState().connect(deviceId));

  const startTimedOrResume = () =>
    run('start', async () => {
      const rec = useRecording.getState();
      if (!rec.sensor) await rec.connect();
      if (!useRecording.getState().sensor) return;
      useRecording.getState().skipBaseline();
      await useRecording.getState().startRecording();
      if (useRecording.getState().stage === 'recording') openLiveScreen();
    });

  const cancel = async () => {
    const ok = await confirmAsync({
      title: resuming ? 'Leave without resuming?' : 'Cancel this case?',
      message: resuming
        ? 'The interrupted session stays in History; you can finish it later.'
        : 'Nothing has been recorded yet.',
      confirmLabel: resuming ? 'Leave' : 'Cancel case',
      cancelLabel: 'Stay',
    });
    if (!ok) return;
    if (!resuming) await useRecording.getState().abort();
    else useRecording.getState().reset();
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const footer = (
    <>
      {!hasProcedure ? (
        <AppText variant="caption" tone="muted" align="center">
          Choose the procedure to continue.
        </AppText>
      ) : !sensorReady ? (
        <AppText variant="caption" tone="muted" align="center">
          {sourceChoice ? 'Connect the sensor to continue.' : 'Choose a heart-rate source to continue.'}
        </AppText>
      ) : null}
      {resuming || !isLive ? (
        <Button
          label={resuming ? 'Resume recording' : 'Start case'}
          variant="primary"
          size="lg"
          icon="radio-button-on"
          disabled={!canContinue || (!resuming && !hasProcedure)}
          loading={busy === 'start'}
          onPress={() => void startTimedOrResume()}
          testID="setup-start"
        />
      ) : (
        <>
          <Button
            label="Continue to resting baseline"
            variant="primary"
            size="lg"
            iconRight="arrow-forward"
            disabled={!canContinue}
            onPress={() => router.push('/record/baseline')}
            testID="setup-continue"
          />
          <Button
            label="Skip baseline and start recording"
            variant="ghost"
            size="sm"
            disabled={!canContinue}
            loading={busy === 'start'}
            onPress={() => void startTimedOrResume()}
            testID="setup-skip-baseline"
          />
        </>
      )}
    </>
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: resuming ? 'Resume case' : 'New case',
          headerRight: () => <Button label="Cancel" size="sm" variant="ghost" onPress={() => void cancel()} />,
        }}
      />
      <Screen edges={['left', 'right', 'bottom']} footer={footer} testID="record-setup">
        {resuming ? (
          <Banner
            tone="info"
            title={`Resuming “${resumeSession.procedure.name}”`}
            message="Reconnect the heart-rate source. Recording continues in the same session; the gap while the app was closed is kept as a gap."
          />
        ) : (
          <>
            <SectionHeader title="Procedure" />
            <Card>
              <ProcedurePicker value={procedure?.name ? procedure : null} onChange={onPickProcedure} testID="procedure-picker" />
            </Card>

            {hasProcedure ? (
              <Card title="Case details" subtitle="Optional, but helps compare like with like">
                <AppText variant="label" tone="muted">
                  Your role
                </AppText>
                <SegmentedControl
                  options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
                  value={procedure?.role ?? null}
                  onChange={(role) => updateProcedure({ role })}
                  accessibilityLabel="Your role"
                  wrap
                  size="sm"
                />
                <AppText variant="label" tone="muted">
                  Approach
                </AppText>
                <View style={styles.chips}>
                  {APPROACHES.map((a) => (
                    <Chip
                      key={a}
                      label={APPROACH_LABELS[a]}
                      selected={procedure?.approach === a}
                      onPress={() => updateProcedure({ approach: a })}
                    />
                  ))}
                </View>
                <AppText variant="label" tone="muted">
                  Urgency
                </AppText>
                <SegmentedControl
                  options={URGENCIES.map((u) => ({ value: u, label: URGENCY_LABELS[u] }))}
                  value={procedure?.urgency ?? null}
                  onChange={(urgency) => updateProcedure({ urgency })}
                  accessibilityLabel="Urgency"
                  size="sm"
                />
                <AppText variant="label" tone="muted">
                  Anticipated complexity{procedure?.complexity ? `: ${COMPLEXITY_LABELS[procedure.complexity]}` : ''}
                </AppText>
                <SegmentedControl
                  options={COMPLEXITIES.map((c) => ({ value: c, label: String(c), accessibilityLabel: `${c}, ${COMPLEXITY_LABELS[c]}` }))}
                  value={procedure?.complexity ?? null}
                  onChange={(complexity) => updateProcedure({ complexity })}
                  accessibilityLabel="Anticipated complexity, 1 routine to 5 very complex"
                  size="sm"
                />
              </Card>
            ) : null}
          </>
        )}

        <SectionHeader title="Heart-rate source" />
        <View style={styles.sources} accessibilityRole="radiogroup" accessibilityLabel="Heart-rate source">
          {sources == null ? (
            <AppText variant="label" tone="muted">
              Checking what this device supports…
            </AppText>
          ) : (
            sources.map((o) => {
              const selected = o.choice === sourceChoice;
              return (
                <Pressable
                  key={o.choice}
                  onPress={o.supported ? () => void useRecording.getState().chooseSource(o.choice) : undefined}
                  disabled={!o.supported}
                  accessibilityRole="radio"
                  accessibilityLabel={`${o.label}. ${o.description}${o.supported ? '' : ' Not available on this device.'}`}
                  aria-checked={selected}
                  aria-disabled={!o.supported}
                  testID={`source-${o.choice}`}
                  style={({ pressed }) => [
                    styles.source,
                    selected ? { borderColor: theme.colors.primary, backgroundColor: theme.colors.primarySoft } : null,
                    !o.supported ? styles.disabled : null,
                    pressed ? styles.pressed : null,
                  ]}
                >
                  <Icon name={SOURCE_ICON[o.choice]} size={22} color={selected ? theme.colors.primary : theme.colors.textMuted} />
                  <View style={styles.flex}>
                    <AppText variant="bodyStrong">{o.label}</AppText>
                    <AppText variant="caption" tone="muted">
                      {o.supported ? o.description : 'Not available on this device or browser.'}
                    </AppText>
                  </View>
                  <Icon
                    name={selected ? 'radio-button-on' : 'radio-button-off'}
                    size={22}
                    color={selected ? theme.colors.primary : theme.colors.borderStrong}
                  />
                </Pressable>
              );
            })
          )}
        </View>

        {sourceChoice ? (
          <Card>
            <SensorStatusPill status={sensorStatus} />
            {sourceChoice === 'ble' ? (
              <View style={styles.actions}>
                {settings.preferredDeviceId && !connected ? (
                  <Button
                    label={`Connect ${settings.preferredDeviceName ?? 'last sensor'}`}
                    variant="primary"
                    icon="bluetooth"
                    loading={busy === 'connect'}
                    onPress={() => void connect(settings.preferredDeviceId ?? undefined)}
                  />
                ) : null}
                <Button
                  label={connected ? 'Change sensor' : 'Find sensors'}
                  icon="search"
                  variant={settings.preferredDeviceId && !connected ? 'secondary' : 'primary'}
                  onPress={() => router.push('/sensors')}
                  testID="setup-find-sensors"
                />
              </View>
            ) : null}
            {sourceChoice === 'web-bluetooth' && !connected ? (
              <Button
                label="Choose sensor in browser"
                variant="primary"
                icon="bluetooth"
                loading={busy === 'connect'}
                onPress={() => void connect()}
                accessibilityHint="Opens the browser's Bluetooth device chooser"
              />
            ) : null}
            {sourceChoice === 'simulated' && !connected ? (
              <Button label="Start simulator" variant="primary" icon="pulse" loading={busy === 'connect'} onPress={() => void connect()} testID="setup-connect-sim" />
            ) : null}
            {selectedOption && !selectedOption.live ? (
              <AppText variant="label" tone="muted">
                Heart rate will be imported after the case. Start a workout on your watch before the case so it records
                continuously.
              </AppText>
            ) : null}
            {sourceChoice === 'simulated' ? (
              <AppText variant="caption" tone="warning">
                Simulated data — for demos and training only.
              </AppText>
            ) : null}
          </Card>
        ) : null}

        {error ? <Banner tone="danger" message={error} /> : null}
      </Screen>
    </>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    flex: { flex: 1 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm },
    sources: { gap: t.space.sm },
    source: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.md,
      padding: t.space.lg,
      borderRadius: t.radius.lg,
      borderWidth: 1.5,
      borderColor: t.colors.border,
      backgroundColor: t.colors.surface,
      minHeight: 64,
    },
    disabled: { opacity: 0.5 },
    pressed: { opacity: 0.85 },
    actions: { gap: t.space.sm },
  });
