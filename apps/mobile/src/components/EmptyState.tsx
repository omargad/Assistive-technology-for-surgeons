import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { useStyles, useTheme, type Theme } from '@/theme';

import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  message?: string;
  /** Action buttons. */
  children?: ReactNode;
  testID?: string;
}

/** Friendly placeholder for empty lists and screens without data. */
export function EmptyState({ icon = 'pulse-outline', title, message, children, testID }: EmptyStateProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.iconCircle}>
        <Icon name={icon} size={32} color={theme.colors.primary} />
      </View>
      <AppText variant="subheading" align="center" accessibilityRole="header">
        {title}
      </AppText>
      {message ? (
        <AppText variant="body" tone="muted" align="center" style={styles.message}>
          {message}
        </AppText>
      ) : null}
      {children ? <View style={styles.actions}>{children}</View> : null}
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    root: { alignItems: 'center', paddingVertical: t.space.xxl, paddingHorizontal: t.space.lg, gap: t.space.md },
    iconCircle: {
      width: 64,
      height: 64,
      borderRadius: 32,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.colors.primarySoft,
    },
    message: { maxWidth: 420 },
    actions: { alignSelf: 'stretch', alignItems: 'center', gap: t.space.sm, marginTop: t.space.sm },
  });
