import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useStyles, useTheme, type Theme } from '@/theme';

import { AppText } from './AppText';

export interface SegmentOption<T extends string | number> {
  value: T;
  label: string;
  accessibilityLabel?: string;
}

export interface SegmentedControlProps<T extends string | number> {
  options: readonly SegmentOption<T>[];
  /** Selected value; `null` when nothing is chosen yet. */
  value: T | null | undefined;
  onChange: (value: T) => void;
  /** Group label for screen readers. */
  accessibilityLabel?: string;
  /** Wrap onto several lines instead of squeezing (for long labels / many options). */
  wrap?: boolean;
  size?: 'sm' | 'md';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Single-choice segmented control (radio group semantics). */
export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  accessibilityLabel,
  wrap,
  size = 'md',
  disabled,
  style,
  testID,
}: SegmentedControlProps<T>) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      style={[styles.track, wrap ? styles.wrap : null, style]}
      testID={testID}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={String(opt.value)}
            onPress={disabled ? undefined : () => onChange(opt.value)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityLabel={opt.accessibilityLabel ?? opt.label}
            aria-checked={selected}
            aria-disabled={!!disabled}
            testID={testID ? `${testID}-${String(opt.value)}` : undefined}
            style={({ pressed }) => [
              styles.segment,
              { minHeight: size === 'sm' ? 36 : theme.layout.minTouch },
              wrap ? styles.segmentWrap : null,
              selected ? styles.selected : null,
              pressed && !selected ? styles.pressed : null,
              disabled ? styles.disabled : null,
            ]}
          >
            <AppText
              variant={size === 'sm' ? 'caption' : 'label'}
              weight={selected ? 'semibold' : 'medium'}
              color={selected ? theme.colors.onPrimary : theme.colors.text}
              align="center"
              numberOfLines={2}
            >
              {opt.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    track: {
      flexDirection: 'row',
      backgroundColor: t.colors.surfaceAlt,
      borderRadius: t.radius.md,
      padding: 3,
      gap: 3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.colors.border,
    },
    wrap: { flexWrap: 'wrap' },
    segment: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: t.space.sm,
      paddingVertical: t.space.xs,
      borderRadius: t.radius.sm,
    },
    segmentWrap: { flexGrow: 1, flexBasis: 'auto', minWidth: 96 },
    selected: { backgroundColor: t.colors.primary },
    pressed: { backgroundColor: t.colors.border },
    disabled: { opacity: 0.45 },
  });
