/**
 * One-line beat-to-beat (RR interval) status for the sensor screens, so a
 * strap that sends heart rate without RR is noticed before a study case
 * (HRV, stress-index and per-phase RMSSD outcomes need RR intervals).
 */
import { StyleSheet, View } from 'react-native';

import { useBeatToBeat } from '@/hooks/useBeatToBeat';
import { useStyles, useTheme, type Theme } from '@/theme';

import { AppText } from './AppText';
import { Icon } from './Icon';

export function BeatToBeatNote({ testID = 'sensor-rr' }: { testID?: string }) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const rr = useBeatToBeat();
  if (rr == null) return null;
  const ok = rr === 'receiving';
  return (
    <View style={styles.row} accessible accessibilityLiveRegion="polite" testID={testID}>
      <Icon name={ok ? 'checkmark-circle' : 'warning'} size={18} color={ok ? theme.colors.success : theme.colors.warning} />
      <AppText variant="label" tone={ok ? 'muted' : 'warning'} style={styles.text}>
        {ok
          ? 'Beat-to-beat (RR) intervals: receiving.'
          : 'Beat-to-beat (RR) intervals: not received. Heart rate is recorded, but HRV and stress-index results will be missing. Check the sensor’s settings or use a chest strap that sends RR.'}
      </AppText>
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: t.space.sm },
    text: { flex: 1 },
  });
