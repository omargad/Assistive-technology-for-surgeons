/**
 * Pure-JS slider (no native slider dependency) for questionnaire ratings.
 *
 * - Drag horizontally or tap anywhere on the 44-pt-tall track (PanResponder;
 *   touch on iOS/Android, mouse on the web). Vertical swipes scroll the page.
 * - Screen readers: `accessibilityRole="adjustable"` with increment/decrement
 *   accessibility actions (VoiceOver swipe up/down, TalkBack volume keys).
 * - Optional −/+ step buttons for keyboard users on the web and gloved fingers.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useLatest } from '@/hooks/useLatest';
import { noTextSelect, useStyles, useTheme, type Theme } from '@/theme';

import { AppText } from './AppText';
import { Icon } from './Icon';

export interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  /** Called when a drag ends (or after a discrete step). */
  onChangeEnd?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Accessible name, e.g. the questionnaire dimension. */
  label: string;
  /** Spoken/visible value text, e.g. `v => `${v} / 100``. */
  formatValue?: (value: number) => string;
  /** Anchor texts under the track ends, e.g. "Very low" / "Very high". */
  lowLabel?: string;
  highLabel?: string;
  /** Show −/+ step buttons (default true). */
  showButtons?: boolean;
  /** Show the value above the track (default true). */
  showValue?: boolean;
  accent?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const THUMB = 28;
/** Movement (pt) below which a touch counts as a tap rather than a drag. */
const DRAG_SLOP = 4;

function decimalsOf(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** Clamp and snap `v` to the step grid starting at `min`. */
export function snapToStep(v: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(v)) return min;
  const clamped = Math.min(max, Math.max(min, v));
  const snapped = min + Math.round((clamped - min) / step) * step;
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(decimalsOf(step)));
}

export function Slider({
  value,
  onChange,
  onChangeEnd,
  min = 0,
  max = 100,
  step = 1,
  label,
  formatValue,
  lowLabel,
  highLabel,
  showButtons = true,
  showValue = true,
  accent,
  disabled,
  style,
  testID,
}: SliderProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const color = accent ?? theme.colors.primary;
  const [width, setWidth] = useState(0);

  // Latest props for the PanResponder and step handlers (created once).
  const live = useLatest({ width, value, min, max, step, disabled, onChange, onChangeEnd });
  const dragStartX = useRef(0);
  const dragging = useRef(false);
  const lastEmitted = useRef(value);

  const valueText = formatValue ? formatValue(value) : String(value);
  const fraction = max > min ? (snapToStep(value, min, max, step) - min) / (max - min) : 0;

  const emit = useCallback((next: number) => {
    const { value: current, onChange: cb } = live.current;
    lastEmitted.current = next;
    if (next !== current) cb(next);
  }, []);

  const valueAtX = useCallback((x: number) => {
    const { width: w, min: lo, max: hi, step: st } = live.current;
    const usable = Math.max(1, w - THUMB);
    const f = (x - THUMB / 2) / usable;
    return snapToStep(lo + f * (hi - lo), lo, hi, st);
  }, []);

  /**
   * Gesture handling that cooperates with a parent ScrollView on every platform:
   * - touching down does not change the value (a vertical swipe that starts on the
   *   slider scrolls the form instead of setting a rating);
   * - a horizontal drag sets the value and keeps the gesture;
   * - a tap without movement sets the value at the tap position;
   * - a vertical gesture is released to the ScrollView (Android honours this flag;
   *   iOS / web scroll views take over natively).
   */
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !live.current.disabled,
        onMoveShouldSetPanResponder: (_e, g) => !live.current.disabled && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderTerminationRequest: (_e, g) => !dragging.current && Math.abs(g.dy) >= Math.abs(g.dx),
        onPanResponderGrant: (e: GestureResponderEvent, g) => {
          // When granted mid-move, locationX is the current point: subtract the travel so far.
          dragStartX.current = e.nativeEvent.locationX - g.dx;
          dragging.current = false;
          lastEmitted.current = live.current.value;
        },
        onPanResponderMove: (_e, g) => {
          if (!dragging.current && Math.abs(g.dx) > DRAG_SLOP && Math.abs(g.dx) >= Math.abs(g.dy)) dragging.current = true;
          if (dragging.current) emit(valueAtX(dragStartX.current + g.dx));
        },
        onPanResponderRelease: (_e, g) => {
          const tap = !dragging.current && Math.abs(g.dx) <= DRAG_SLOP && Math.abs(g.dy) <= DRAG_SLOP;
          if (tap) emit(valueAtX(dragStartX.current));
          dragging.current = false;
          live.current.onChangeEnd?.(lastEmitted.current);
        },
        onPanResponderTerminate: () => {
          dragging.current = false;
        },
      }),
    [emit, valueAtX],
  );

  const stepBy = useCallback(
    (direction: 1 | -1) => {
      const { value: v, min: lo, max: hi, step: st, onChange: cb, onChangeEnd: end } = live.current;
      const next = snapToStep(v + direction * st, lo, hi, st);
      if (next !== v) cb(next);
      end?.(next);
    },
    [],
  );

  const onAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (live.current.disabled) return;
      if (event.nativeEvent.actionName === 'increment') stepBy(1);
      else if (event.nativeEvent.actionName === 'decrement') stepBy(-1);
    },
    [stepBy],
  );

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const thumbLeft = fraction * Math.max(0, width - THUMB);

  return (
    <View style={[styles.root, disabled ? styles.disabled : null, style]}>
      {showValue ? (
        <AppText variant="bodyStrong" tabular align="center" aria-hidden>
          {valueText}
        </AppText>
      ) : null}
      <View style={styles.row}>
        {showButtons ? (
          <Pressable
            onPress={() => stepBy(-1)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={`Decrease ${label}`}
            hitSlop={4}
            style={({ pressed }) => [styles.stepButton, pressed ? styles.stepPressed : null]}
            testID={testID ? `${testID}-decrement` : undefined}
          >
            <Icon name="remove" size={20} color={theme.colors.text} />
          </Pressable>
        ) : null}
        <View
          style={styles.trackArea}
          onLayout={onLayout}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={label}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={valueText}
          aria-disabled={!!disabled}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={onAccessibilityAction}
          testID={testID}
          {...responder.panHandlers}
        >
          <View pointerEvents="none" style={styles.track}>
            <View style={[styles.fill, { width: thumbLeft + THUMB / 2, backgroundColor: color }]} />
          </View>
          <View
            pointerEvents="none"
            style={[styles.thumb, { left: thumbLeft, borderColor: color, backgroundColor: theme.colors.surface }]}
          />
        </View>
        {showButtons ? (
          <Pressable
            onPress={() => stepBy(1)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={`Increase ${label}`}
            hitSlop={4}
            style={({ pressed }) => [styles.stepButton, pressed ? styles.stepPressed : null]}
            testID={testID ? `${testID}-increment` : undefined}
          >
            <Icon name="add" size={20} color={theme.colors.text} />
          </Pressable>
        ) : null}
      </View>
      {lowLabel || highLabel ? (
        <View style={[styles.anchors, showButtons ? styles.anchorsInset : null]} aria-hidden>
          <AppText variant="caption" tone="muted">
            {lowLabel ?? ''}
          </AppText>
          <AppText variant="caption" tone="muted" align="right">
            {highLabel ?? ''}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    root: { gap: t.space.xs, ...noTextSelect },
    disabled: { opacity: 0.45 },
    row: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
    trackArea: { flex: 1, height: 44, justifyContent: 'center' },
    track: {
      height: 6,
      borderRadius: 3,
      backgroundColor: t.colors.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.colors.borderStrong,
      overflow: 'hidden',
    },
    fill: { height: '100%', borderRadius: 3 },
    thumb: {
      position: 'absolute',
      top: (44 - THUMB) / 2,
      width: THUMB,
      height: THUMB,
      borderRadius: THUMB / 2,
      borderWidth: 3,
    },
    stepButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.colors.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.colors.border,
    },
    stepPressed: { backgroundColor: t.colors.border },
    anchors: { flexDirection: 'row', justifyContent: 'space-between', gap: t.space.md },
    anchorsInset: { paddingHorizontal: 48 },
  });
