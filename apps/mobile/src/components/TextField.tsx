import { StyleSheet, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';

import { useStyles, useTheme, type Theme } from '@/theme';

import { AppText } from './AppText';

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  /** Helper text under the field. */
  hint?: string;
  /** Validation message (replaces hint, red). */
  error?: string | null;
  style?: StyleProp<ViewStyle>;
}

/** Labelled text input with hint and validation message. */
export function TextField({
  label,
  hint,
  error,
  style,
  multiline,
  editable = true,
  accessibilityLabel,
  accessibilityHint,
  ...rest
}: TextFieldProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.root, style]}>
      <AppText variant="label" tone="muted" aria-hidden>
        {label}
      </AppText>
      <TextInput
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityHint={error ?? accessibilityHint ?? hint}
        aria-disabled={!editable}
        placeholderTextColor={theme.colors.textFaint}
        editable={editable}
        multiline={multiline}
        allowFontScaling
        style={[
          styles.input,
          multiline ? styles.multiline : null,
          error ? { borderColor: theme.colors.danger } : null,
          !editable ? styles.disabled : null,
        ]}
        {...rest}
      />
      {error ? (
        <AppText variant="caption" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : hint ? (
        <AppText variant="caption" tone="faint">
          {hint}
        </AppText>
      ) : null}
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    root: { gap: t.space.xs },
    input: {
      minHeight: t.layout.minTouch + 4,
      borderWidth: 1,
      borderColor: t.colors.borderStrong,
      borderRadius: t.radius.md,
      backgroundColor: t.colors.surface,
      color: t.colors.text,
      paddingHorizontal: t.space.md,
      paddingVertical: t.space.sm,
      fontSize: t.fontSize.md,
    },
    multiline: { minHeight: 96, textAlignVertical: 'top' },
    disabled: { opacity: 0.6 },
  });
