import { Pressable, StyleSheet, View } from 'react-native';

import type { BeatToBeat } from '@/hooks/useBeatToBeat';
import type { SensorState, SensorStatus } from '@/services/sensors/types';
import { useStyles, useTheme, type Theme } from '@/theme';

import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';

/** Short user-facing names for the sensor connection lifecycle. */
export const SENSOR_STATE_LABELS: Readonly<Record<SensorState, string>> = {
  idle: 'Not connected',
  unsupported: 'Not supported',
  'permission-denied': 'Permission needed',
  scanning: 'Scanning',
  connecting: 'Connecting',
  connected: 'Connected',
  streaming: 'Live',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
  error: 'Error',
};

type Health = 'good' | 'pending' | 'bad' | 'off';

function healthOf(state: SensorState): Health {
  switch (state) {
    case 'streaming':
    case 'connected':
      return 'good';
    case 'scanning':
    case 'connecting':
    case 'reconnecting':
      return 'pending';
    case 'idle':
      return 'off';
    default:
      return 'bad';
  }
}

function batteryIcon(level: number): IconName {
  if (level >= 60) return 'battery-full';
  if (level >= 20) return 'battery-half';
  return 'battery-dead';
}

/** Human description of BLE signal strength. */
export function signalLabel(rssi: number | undefined): { label: string; bars: 1 | 2 | 3 } {
  if (rssi == null) return { label: 'Signal unknown', bars: 1 };
  if (rssi >= -65) return { label: 'Strong signal', bars: 3 };
  if (rssi >= -80) return { label: 'Good signal', bars: 2 };
  return { label: 'Weak signal', bars: 1 };
}

export interface SensorStatusPillProps {
  status: SensorStatus;
  /**
   * The connection is up but no heart-rate data has arrived for a while (the live screen's
   * "signal lost"): shown as a warning instead of "Live".
   */
  noData?: boolean;
  /** Beat-to-beat (RR) status: 'missing' shows a "No RR" warning (HRV needs RR intervals). */
  rr?: BeatToBeat | null;
  /** Hide the device name (tight layouts). */
  compact?: boolean;
  onPress?: () => void;
  testID?: string;
}

/** Sensor connection status: state dot + label, device, battery and skin contact. */
export function SensorStatusPill({ status, noData, rr, compact, onPress, testID }: SensorStatusPillProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const c = theme.colors;
  const stale = !!noData && healthOf(status.state) === 'good';
  const health: Health = stale ? 'pending' : healthOf(status.state);
  const dot = { good: c.success, pending: c.warning, bad: c.danger, off: c.textFaint }[health];
  const label = stale ? 'No data' : SENSOR_STATE_LABELS[status.state];
  const lowBattery = typeof status.battery === 'number' && status.battery < 20;

  const spoken = [
    `Sensor ${label}`,
    status.deviceName && !compact ? status.deviceName : null,
    typeof status.battery === 'number' ? `battery ${status.battery} percent` : null,
    status.contact === false ? 'no skin contact' : null,
    rr === 'receiving' ? 'beat-to-beat data received' : rr === 'missing' ? 'no beat-to-beat (RR) data' : null,
    status.message ?? null,
  ]
    .filter(Boolean)
    .join(', ');

  const content = (
    <>
      <View style={[styles.dot, { backgroundColor: dot }]} />
      <AppText variant="label" numberOfLines={1} style={styles.label}>
        {label}
        {status.deviceName && !compact ? ` · ${status.deviceName}` : ''}
      </AppText>
      {typeof status.battery === 'number' ? (
        <View style={styles.meta}>
          <Icon name={batteryIcon(status.battery)} size={16} color={lowBattery ? c.danger : c.textMuted} />
          <AppText variant="caption" color={lowBattery ? c.danger : c.textMuted} tabular>
            {status.battery}%
          </AppText>
        </View>
      ) : null}
      {rr === 'missing' ? (
        <View style={styles.meta} testID={testID ? `${testID}-no-rr` : undefined}>
          <Icon name="pulse" size={16} color={c.warning} />
          <AppText variant="caption" tone="warning">
            No RR
          </AppText>
        </View>
      ) : null}
      {status.contact === false ? (
        <View style={styles.meta}>
          <Icon name="hand-left-outline" size={16} color={c.warning} />
          {!compact ? (
            <AppText variant="caption" tone="warning">
              No contact
            </AppText>
          ) : null}
        </View>
      ) : null}
    </>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={spoken}
        accessibilityHint="Opens sensor settings"
        testID={testID}
        style={({ pressed }) => [styles.pill, styles.pressable, pressed ? styles.pressed : null]}
      >
        {content}
      </Pressable>
    );
  }
  return (
    <View style={styles.pill} accessible accessibilityLabel={spoken} testID={testID}>
      {content}
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: t.space.sm,
      minHeight: 36,
      paddingHorizontal: t.space.md,
      paddingVertical: t.space.xs,
      borderRadius: t.radius.pill,
      backgroundColor: t.colors.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.colors.border,
      maxWidth: '100%',
    },
    // Tappable pill: full 44-pt target (hitSlop is not applied on the web).
    pressable: { minHeight: t.layout.minTouch },
    pressed: { opacity: 0.8 },
    dot: { width: 10, height: 10, borderRadius: 5 },
    label: { flexShrink: 1 },
    meta: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  });
