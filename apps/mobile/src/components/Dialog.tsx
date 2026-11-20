/**
 * In-app modal dialog for choices that need more than OK/Cancel (e.g. the
 * interrupted-session recovery prompt) or custom content (quick-note entry).
 * Works identically on iOS, Android and the web.
 */
import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { useStyles, type Theme } from '@/theme';

import { AppText } from './AppText';
import { Button, type ButtonVariant } from './Button';

export interface DialogAction {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  testID?: string;
  disabled?: boolean;
}

export interface DialogProps {
  visible: boolean;
  title: string;
  message?: string;
  children?: ReactNode;
  actions: readonly DialogAction[];
  /** Back button / scrim tap. Omit to make the dialog non-dismissable. */
  onRequestClose?: () => void;
  testID?: string;
}

export function Dialog({ visible, title, message, children, actions, onRequestClose, testID }: DialogProps) {
  const styles = useStyles(makeStyles);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onRequestClose ?? (() => undefined)}
      supportedOrientations={['portrait', 'landscape']}
    >
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onRequestClose}
          accessible={false}
          aria-hidden
        />
        <View style={styles.card} role="dialog" aria-modal accessibilityViewIsModal aria-label={title} testID={testID}>
          <AppText variant="heading" accessibilityRole="header">
            {title}
          </AppText>
          {message ? (
            <AppText variant="body" tone="muted">
              {message}
            </AppText>
          ) : null}
          {children}
          <View style={styles.actions}>
            {actions.map((a) => (
              <Button
                key={a.label}
                label={a.label}
                onPress={a.onPress}
                variant={a.variant ?? 'secondary'}
                disabled={a.disabled}
                fullWidth
                testID={a.testID}
              />
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: t.colors.overlay,
      alignItems: 'center',
      justifyContent: 'center',
      padding: t.space.lg,
    },
    card: {
      width: '100%',
      maxWidth: 480,
      backgroundColor: t.colors.surface,
      borderRadius: t.radius.xl,
      padding: t.space.xl,
      gap: t.space.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.colors.border,
    },
    actions: { gap: t.space.sm, marginTop: t.space.sm },
  });
