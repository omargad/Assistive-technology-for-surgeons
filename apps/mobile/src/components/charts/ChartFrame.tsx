/**
 * Shared chart container: responsive width (onLayout), a title, an empty
 * state, and a single accessible element whose label is the chart's textual
 * summary (screen readers get the summary instead of SVG fragments).
 */
import { useState, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

import { useStyles, type Theme } from '@/theme';

import { AppText } from '../AppText';

export interface ChartFrameProps {
  title?: string;
  subtitle?: string;
  /** Accessible summary of what the chart shows. */
  summary: string;
  /** Plot height (px). */
  height: number;
  empty?: boolean;
  emptyMessage?: string;
  /** Renders the plot for the measured width. */
  children: (width: number) => ReactNode;
  /** Content between the title and the plot (e.g. an interactive readout). */
  toolbar?: ReactNode;
  /** Content below the plot (legend, caption). */
  footer?: ReactNode;
  /** Width used before the first layout pass (and in tests). */
  initialWidth?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function ChartFrame({
  title,
  subtitle,
  summary,
  height,
  empty,
  emptyMessage = 'No data yet',
  children,
  toolbar,
  footer,
  initialWidth = 320,
  style,
  testID,
}: ChartFrameProps) {
  const styles = useStyles(makeStyles);
  const [width, setWidth] = useState(initialWidth);
  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w > 0 && Math.abs(w - width) >= 1) setWidth(w);
  };

  return (
    <View style={[styles.root, style]} testID={testID}>
      {title || subtitle ? (
        <View style={styles.header}>
          {title ? (
            <AppText variant="subheading" accessibilityRole="header">
              {title}
            </AppText>
          ) : null}
          {subtitle ? (
            <AppText variant="caption" tone="muted">
              {subtitle}
            </AppText>
          ) : null}
        </View>
      ) : null}
      {toolbar && !empty ? toolbar : null}
      <View
        onLayout={onLayout}
        accessible
        accessibilityRole="image"
        accessibilityLabel={summary}
        style={[styles.plot, { minHeight: empty ? 0 : height }]}
        testID={testID ? `${testID}-plot` : undefined}
      >
        {empty ? (
          <View style={[styles.empty, { height: Math.min(height, 120) }]}>
            <AppText variant="label" tone="muted" align="center">
              {emptyMessage}
            </AppText>
          </View>
        ) : (
          children(width)
        )}
      </View>
      {footer && !empty ? footer : null}
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    root: { gap: t.space.sm, width: '100%' },
    header: { gap: 2 },
    plot: { width: '100%' },
    empty: {
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: t.radius.md,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: t.colors.border,
      padding: t.space.lg,
    },
  });
