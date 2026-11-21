/**
 * Pure-JS slider (no native slider dependency) for questionnaire ratings.
 *
 * - Drag horizontally or tap anywhere on the 44-pt-tall track (PanResponder;
 *   touch on iOS/Android, mouse on the web). Vertical swipes scroll the page.
 * - Screen readers: `accessibilityRole="adjustable"` with increment/decrement
 *   accessibility actions (VoiceOver swipe up/down, TalkBack volume keys).
 * - Optional −/+ step buttons for keyboard users on the web and gloved fingers.
 * - Web keyboard: the track is a tab stop (ARIA slider pattern): Arrow keys step,
 *   PageUp/PageDown move by about a tenth of the scale, Home/End jump to the ends.
 * - `value={null}` means "not answered yet": no thumb or fill is drawn, no
 *   `aria-valuenow` is exposed, and the first tap, drag, step or key press
 *   records an answer — even when it lands on the scale's midpoint.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  Platform,
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
  /** Current value, or `null` while the question is unanswered (no thumb is drawn). */
  value: number | null;
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
  /** Spoken/visible text while `value` is null (default "Not answered"). */
  unansweredText?: string;
  /** Where the first −/+ step or arrow key lands while unanswered (default: middle of the scale). */
  startValue?: number;
  /** Shows a "Clear" button while answered (optional questions). */
  onClear?: () => void;
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

export interface SliderScale {
  min: number;
  max: number;
  step: number;
  /** Value used for the first step while unanswered. */
  start: number;
}

/**
 * Value after a key press on the slider (ARIA slider keyboard pattern), or `undefined`
 * for keys the slider does not handle. While unanswered (`value == null`), any step key
 * answers with `start`; Home/End answer with the ends of the scale.
 */
export function valueForKey(key: string, value: number | null, scale: SliderScale): number | undefined {
  const { min, max, step, start } = scale;
  const big = Math.max(step, snapToStep((max - min) / 10, 0, max - min, step));
  const from = (delta: number) => (value == null ? snapToStep(start, min, max, step) : snapToStep(value + delta, min, max, step));
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return from(step);
    case 'ArrowLeft':
    case 'ArrowDown':
      return from(-step);
    case 'PageUp':
      return from(big);
    case 'PageDown':
      return from(-big);
    case 'Home':
      return min;
    case 'End':
      return max;
    default:
      return undefined;
  }
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
  unansweredText = 'Not answered',
  startValue,
  onClear,
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

  const current = value != null && Number.isFinite(value) ? value : null;
  const answered = current != null;
  const start = snapToStep(startValue ?? (min + max) / 2, min, max, step);
  // Latest props for the PanResponder and step handlers (created once).
  const live = useLatest({ width, value: current, min, max, step, start, disabled, onChange, onChangeEnd });
  const dragStartX = useRef(0);
  const dragging = useRef(false);
  const lastEmitted = useRef<number | null>(current);

  const valueText = current != null ? (formatValue ? formatValue(current) : String(current)) : unansweredText;
  const fraction = current != null && max > min ? (snapToStep(current, min, max, step) - min) / (max - min) : 0;

  // An unanswered slider records any tap, drag or step, even one that lands on the value a thumb would show.
  const emit = useCallback((next: number) => {
    const { value: now, onChange: cb } = live.current;
    lastEmitted.current = next;
    if (now == null || next !== now) cb(next);
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
          if (lastEmitted.current != null) live.current.onChangeEnd?.(lastEmitted.current);
        },
        onPanResponderTerminate: () => {
          dragging.current = false;
        },
      }),
    [emit, valueAtX],
  );

  const setTo = useCallback((next: number) => {
    const { value: v, onChange: cb, onChangeEnd: end } = live.current;
    if (v == null || next !== v) cb(next);
    end?.(next);
  }, []);

  // While unanswered, the first step answers with the start value (the middle of the scale by default).
  const stepBy = useCallback(
    (direction: 1 | -1) => {
      const { value: v, min: lo, max: hi, step: st, start: first } = live.current;
      setTo(v == null ? first : snapToStep(v + direction * st, lo, hi, st));
    },
    [setTo],
  );

  const onKeyDown = useCallback(
    (e: { key?: string; nativeEvent?: { key?: string }; preventDefault?: () => void }) => {
      const { value: v, min: lo, max: hi, step: st, start: first, disabled: off } = live.current;
      if (off) return;
      const next = valueForKey(e.key ?? e.nativeEvent?.key ?? '', v, { min: lo, max: hi, step: st, start: first });
      if (next === undefined) return;
      e.preventDefault?.(); // keep arrow / page keys from scrolling the page
      setTo(next);
    },
    [setTo],
  );
  // Web only: make the track a keyboard tab stop (RN's own `tabIndex`/`onKeyDown` are not used on native).
  const webKeyboard: Record<string, unknown> = Platform.OS === 'web' && !disabled ? { tabIndex: 0, onKeyDown } : {};

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
      {showValue || (onClear && answered) ? (
        <View style={styles.valueRow}>
          {showValue ? (
            <AppText
              variant="bodyStrong"
              tabular
              align="center"
              tone={answered ? undefined : 'muted'}
              aria-hidden
              testID={testID ? `${testID}-value` : undefined}
            >
              {answered ? valueText : `${valueText} · tap the scale to answer`}
            </AppText>
          ) : null}
          {onClear && answered ? (
            <Pressable
              onPress={onClear}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={`Clear ${label}`}
              style={({ pressed }) => [styles.clear, pressed ? styles.stepPressed : null]}
              testID={testID ? `${testID}-clear` : undefined}
            >
              <AppText variant="label" tone="muted">
                Clear
              </AppText>
            </Pressable>
          ) : null}
        </View>
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
          aria-valuenow={current ?? undefined}
          aria-valuetext={valueText}
          aria-disabled={!!disabled}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={onAccessibilityAction}
          testID={testID}
          {...webKeyboard}
          {...responder.panHandlers}
        >
          <View pointerEvents="none" style={[styles.track, answered ? null : styles.trackUnanswered]}>
            {answered ? <View style={[styles.fill, { width: thumbLeft + THUMB / 2, backgroundColor: color }]} /> : null}
          </View>
          {answered ? (
            <View
              pointerEvents="none"
              style={[styles.thumb, { left: thumbLeft, borderColor: color, backgroundColor: theme.colors.surface }]}
              testID={testID ? `${testID}-thumb` : undefined}
            />
          ) : null}
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
    valueRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.space.sm, minHeight: 24 },
    clear: { minHeight: 44, minWidth: 44, paddingHorizontal: t.space.sm, alignItems: 'center', justifyContent: 'center', borderRadius: t.radius.sm },
    trackUnanswered: { borderStyle: 'dashed' },
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
