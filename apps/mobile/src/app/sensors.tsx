/**
 * Sensor chooser (modal). During case setup it connects the chosen device;
 * from Settings it remembers the preferred source/device for next time.
 * - Native BLE: scan list with signal strength (RSSI), "Show all devices".
 * - Web: the browser's own Web Bluetooth chooser.
 * - Health stores: no live connection; offers to grant read access.
 * - Simulator: for demos and training.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Stack, router } from 'expo-router';

import { AppText } from '@/components/AppText';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { notify } from '@/components/ConfirmDialog';
import { SwitchRow } from '@/components/Controls';
import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { SegmentedControl } from '@/components/SegmentedControl';
import { SensorStatusPill, signalLabel } from '@/components/SensorStatusPill';
import { errorMessage, useBusy } from '@/hooks/useBusy';
import { healthStore } from '@/services/health';
import { availableSources, type SourceOption } from '@/services/sensors/registry';
import type { DiscoveredDevice, SourceChoice } from '@/services/sensors/types';
import { useRecording } from '@/state/recording';
import { useSettings } from '@/state/settings';
import { useStyles, useTheme, type Theme } from '@/theme';

const SHORT_LABEL: Record<SourceChoice, string> = {
  ble: 'Bluetooth',
  'web-bluetooth': 'Bluetooth',
  healthkit: 'Apple Health',
  'health-connect': 'Health Connect',
  simulated: 'Simulator',
};

export default function SensorsModal() {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const stage = useRecording((s) => s.stage);
  const sourceChoice = useRecording((s) => s.sourceChoice);
  const devices = useRecording((s) => s.devices);
  const scanning = useRecording((s) => s.scanning);
  const sensorStatus = useRecording((s) => s.sensorStatus);
  const error = useRecording((s) => s.error);
  const settings = useSettings((s) => s.settings);
  const [sources, setSources] = useState<SourceOption[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const { busy, run } = useBusy();

  const inSetup = stage === 'setup' || stage === 'ready';
  const recording = stage === 'recording' || stage === 'baseline';
  const choice: SourceChoice | null = sourceChoice ?? settings.preferredSource;
  const option = sources?.find((o) => o.choice === choice) ?? null;
  const connected = sensorStatus.state === 'connected' || sensorStatus.state === 'streaming';

  useEffect(() => {
    let alive = true;
    availableSources()
      .then((list) => alive && setSources(list))
      .catch(() => alive && setSources([]));
    return () => {
      alive = false;
    };
  }, []);

  // Make sure the store has the source selected (needed for scanning / connecting).
  useEffect(() => {
    if (recording || !sources) return;
    const target = choice && sources.some((o) => o.choice === choice && o.supported) ? choice : sources.find((o) => o.supported)?.choice;
    if (target && target !== sourceChoice) void useRecording.getState().chooseSource(target);
  }, [sources, choice, sourceChoice, recording]);

  // Native BLE: scan while the modal is open.
  useEffect(() => {
    if (recording || sourceChoice !== 'ble' || connected) return undefined;
    void useRecording.getState().startScan({ showAll });
    return () => useRecording.getState().stopScan();
  }, [sourceChoice, showAll, recording, connected]);

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const pickDevice = (device: DiscoveredDevice) =>
    void run(`device-${device.id}`, async () => {
      useRecording.getState().stopScan();
      if (inSetup) {
        await useRecording.getState().connect(device.id);
        const st = useRecording.getState().sensorStatus.state;
        if (st === 'connected' || st === 'streaming') close();
      } else {
        await useSettings.getState().update({ preferredSource: 'ble', preferredDeviceId: device.id, preferredDeviceName: device.name });
        close();
      }
    });

  const connectDefault = () =>
    void run('connect', async () => {
      await useRecording.getState().connect();
      const st = useRecording.getState().sensorStatus.state;
      if (inSetup && (st === 'connected' || st === 'streaming')) close();
    });

  const requestHealth = () =>
    void run('health', async () => {
      try {
        const ok = await healthStore.requestAccess();
        notify(ok ? 'Access granted' : 'Access not granted', ok ? `SurgeonPulse can read heart rate from ${healthStore.label}.` : `You can allow access later in ${healthStore.label}'s settings.`);
      } catch (e) {
        notify('Could not request access', errorMessage(e));
      }
    });

  return (
    <>
      <Stack.Screen options={{ headerRight: () => <Button label="Done" size="sm" variant="ghost" onPress={close} /> }} />
      <Screen edges={['left', 'right', 'bottom']} testID="sensors">
        {recording ? (
          <Card title="Recording in progress" icon="radio-button-on" tone="primary">
            <SensorStatusPill status={sensorStatus} />
            <AppText variant="label" tone="muted">
              The sensor reconnects automatically if the signal drops. If it stays disconnected: moisten the electrodes,
              check the strap is snug, and keep the phone within a few metres.
            </AppText>
          </Card>
        ) : (
          <>
            {sources && sources.filter((o) => o.supported).length > 1 ? (
              <SegmentedControl
                options={sources.filter((o) => o.supported).map((o) => ({ value: o.choice, label: SHORT_LABEL[o.choice], accessibilityLabel: o.label }))}
                value={sourceChoice}
                onChange={(c) => void useRecording.getState().chooseSource(c)}
                accessibilityLabel="Heart-rate source"
              />
            ) : null}
            {option ? (
              <AppText variant="label" tone="muted">
                {option.description}
              </AppText>
            ) : null}
            {sources
              ?.filter((o) => !o.supported)
              .map((o) => (
                <AppText key={o.choice} variant="caption" tone="faint">
                  {o.label}: not available here
                  {o.choice === 'web-bluetooth' ? ' — use Chrome or Edge on desktop or Android.' : '.'}
                </AppText>
              ))}
            <SensorStatusPill status={sensorStatus} />

            {sourceChoice === 'ble' ? (
              <>
                <View style={styles.scanHeader}>
                  <AppText variant="subheading" accessibilityRole="header" style={styles.flex}>
                    Nearby sensors
                  </AppText>
                  {scanning ? (
                    <AppText variant="label" tone="muted" accessibilityLiveRegion="polite">
                      Scanning…
                    </AppText>
                  ) : (
                    <Button label="Scan again" size="sm" icon="refresh" onPress={() => void useRecording.getState().startScan({ showAll })} />
                  )}
                </View>
                <View style={styles.devices}>
                  {devices.length === 0 ? (
                    <AppText variant="label" tone="muted">
                      {scanning
                        ? 'Looking for heart-rate sensors… Wear the strap (moisten the electrodes) so it wakes up.'
                        : 'No sensors found. Make sure the strap is worn and not connected to another app or watch.'}
                    </AppText>
                  ) : (
                    devices.map((d) => {
                      const sig = signalLabel(d.rssi);
                      const preferred = d.id === settings.preferredDeviceId;
                      return (
                        <Pressable
                          key={d.id}
                          onPress={() => pickDevice(d)}
                          disabled={busy != null}
                          accessibilityRole="button"
                          accessibilityLabel={`${d.name || 'Unnamed device'}, ${sig.label}${d.rssi != null ? ` ${d.rssi} dBm` : ''}${d.advertisesHeartRate ? ', heart-rate sensor' : ''}${preferred ? ', your usual sensor' : ''}`}
                          accessibilityHint={inSetup ? 'Connects to this sensor' : 'Remembers this sensor for your next case'}
                          style={({ pressed }) => [styles.device, pressed ? styles.pressed : null]}
                          testID={`device-${d.id}`}
                        >
                          <Icon name={d.advertisesHeartRate ? 'heart' : 'bluetooth'} size={22} color={d.advertisesHeartRate ? theme.colors.chartLine : theme.colors.textMuted} />
                          <View style={styles.flex}>
                            <AppText variant="bodyStrong">{d.name || 'Unnamed device'}</AppText>
                            <AppText variant="caption" tone="muted">
                              {sig.label}
                              {d.rssi != null ? ` · ${d.rssi} dBm` : ''}
                              {preferred ? ' · your usual sensor' : ''}
                            </AppText>
                          </View>
                          <View style={styles.bars} aria-hidden>
                            {[1, 2, 3].map((b) => (
                              <View
                                key={b}
                                style={[
                                  styles.bar,
                                  { height: 6 + b * 5, backgroundColor: b <= sig.bars ? theme.colors.success : theme.colors.border },
                                ]}
                              />
                            ))}
                          </View>
                          {busy === `device-${d.id}` ? <AppText variant="caption">Connecting…</AppText> : null}
                        </Pressable>
                      );
                    })
                  )}
                </View>
                <View style={styles.switchWrap}>
                  <SwitchRow
                    title="Show all devices"
                    subtitle="Some straps don't advertise the heart-rate service until connected"
                    value={showAll}
                    onValueChange={setShowAll}
                  />
                </View>
              </>
            ) : null}

            {sourceChoice === 'web-bluetooth' ? (
              <Card icon="bluetooth" title="Connect in the browser">
                <AppText variant="label" tone="muted">
                  Your browser shows its own list of nearby heart-rate sensors. Works in Chrome and Edge (desktop and
                  Android). Keep this tab open and visible while recording.
                </AppText>
                <Button
                  label={connected ? 'Choose a different sensor' : 'Choose sensor'}
                  variant="primary"
                  icon="bluetooth"
                  loading={busy === 'connect'}
                  onPress={connectDefault}
                  testID="sensors-web-chooser"
                />
              </Card>
            ) : null}

            {sourceChoice === 'healthkit' || sourceChoice === 'health-connect' ? (
              <Card icon="watch-outline" title={healthStore.label || 'Health data'}>
                <AppText variant="label" tone="muted">
                  There is no live connection: start a workout on your watch before the case, and SurgeonPulse imports
                  the heart rate for the case window afterwards.
                </AppText>
                <Button label={`Allow access to ${healthStore.label}`} loading={busy === 'health'} onPress={requestHealth} />
              </Card>
            ) : null}

            {sourceChoice === 'simulated' ? (
              <Card icon="pulse-outline" title="Simulator">
                <AppText variant="label" tone="muted">
                  Generates realistic heart-rate data that responds to the phases and events you mark. Use it to try the
                  app or train the team — never for real cases.
                </AppText>
                {inSetup && !connected ? (
                  <Button label="Start simulator" variant="primary" loading={busy === 'connect'} onPress={connectDefault} />
                ) : null}
              </Card>
            ) : null}
          </>
        )}
        {error && !recording ? <Banner tone="danger" message={error} /> : null}
        {!inSetup && !recording ? (
          <AppText variant="caption" tone="faint">
            Your choice is remembered and used next time you start a case.
          </AppText>
        ) : null}
      </Screen>
    </>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    flex: { flex: 1 },
    scanHeader: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
    devices: { gap: t.space.sm },
    device: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.md,
      padding: t.space.md,
      minHeight: 60,
      borderRadius: t.radius.md,
      backgroundColor: t.colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.colors.border,
    },
    pressed: { backgroundColor: t.colors.surfaceAlt },
    bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
    bar: { width: 4, borderRadius: 1 },
    switchWrap: { borderRadius: t.radius.lg, overflow: 'hidden' },
  });
