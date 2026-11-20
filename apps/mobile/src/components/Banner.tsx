import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useStyles, useTheme, type Theme } from '@/theme';

import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';

export type BannerTone = 'info' | 'warning' | 'danger' | 'success';

export interface BannerProps {
  tone?: BannerTone;
  title?: string;
  message?: string;
  icon?: IconName;
  /** Action (e.g. a small Button). */
  action?: ReactNode;
  /** Announce politely to screen readers when it appears (default: true for warning/danger). */
  live?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const DEFAULT_ICON: Record<BannerTone, IconName> = {
  info: 'information-circle',
  warning: 'warning',
  danger: 'alert-circle',
  success: 'checkmark-circle',
};

/** Inline status message (warning/info). */
export function Banner({ tone = 'info', title, message, icon, action, live, style, testID }: BannerProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const c = theme.colors;
  const palette = {
    info: { bg: c.infoSoft, fg: c.info },
    warning: { bg: c.warningSoft, fg: c.warning },
    danger: { bg: c.dangerSoft, fg: c.danger },
    success: { bg: c.successSoft, fg: c.success },
  }[tone];
  const announce = live ?? (tone === 'warning' || tone === 'danger');

  return (
    <View
      style={[styles.banner, { backgroundColor: palette.bg, borderColor: palette.fg }, style]}
      accessible={!action}
      accessibilityRole={tone === 'danger' || tone === 'warning' ? 'alert' : 'summary'}
      accessibilityLiveRegion={announce ? 'polite' : 'none'}
      accessibilityLabel={[title, message].filter(Boolean).join('. ')}
      testID={testID}
    >
      <Icon name={icon ?? DEFAULT_ICON[tone]} size={22} color={palette.fg} />
      <View style={styles.text}>
        {title ? (
          <AppText variant="bodyStrong" color={tone === 'info' ? c.text : palette.fg}>
            {title}
          </AppText>
        ) : null}
        {message ? (
          <AppText variant="label" tone="default">
            {message}
          </AppText>
        ) : null}
      </View>
      {action}
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.md,
      padding: t.space.md,
      borderRadius: t.radius.md,
      borderLeftWidth: 4,
    },
    text: { flex: 1, gap: 2 },
  });
