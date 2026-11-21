/**
 * Live "OR mode" screen. Readable from 1–2 m and operable by a non-sterile
 * team member: big zone-coloured HR with trend, elapsed clock, current phase,
 * sensor status, signal-lost notice, phase buttons (PHASE_ORDER, current
 * highlighted, next emphasised), marker buttons (hold for a quick note),
 * "Logged by: Self / Team", a 10-second undo bar and a press-and-hold
 * "End case". Landscape puts HR (and the logger toggle) on the left and the
 * event controls on the right.
 *
 * Transient messages (undo bar, hints, signal lost) are shown in a fixed-height
 * area of the HR panel (over the sparkline), never over the buttons, and they
 * never change the layout: a tap aimed at a button always lands on that button.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState, BackHandler, Platform, Pressable, ScrollView, StyleSheet, View, type GestureResponderEvent } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  MARKER_ICONS,
  MARKER_KINDS,
  MARKER_LABELS,
  PHASE_COLORS,
  PHASE_LABELS,
  PHASE_ORDER,
  formatClock,
  sessionMaxHr,
} from '@surgeonpulse/core';
import type { MarkerKind, PhaseKind, SessionEvent } from '@surgeonpulse/core';

import { AppText } from '@/components/AppText';
import { Banner } from '@/components/Banner';
import { BigButton } from '@/components/BigButton';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { confirmAsync } from '@/components/ConfirmDialog';
import { Dialog } from '@/components/Dialog';
import { EmptyState } from '@/components/EmptyState';
import { Icon } from '@/components/Icon';
import { SegmentedControl } from '@/components/SegmentedControl';
import { SensorStatusPill } from '@/components/SensorStatusPill';
import { TextField } from '@/components/TextField';
import { goHome } from '@/components/navigation';
import { Toast } from '@/components/Toast';
import { HoldToEndButton } from '@/components/live/HoldToEndButton';
import { LiveHeartRate } from '@/components/live/LiveHeartRate';
import { useBeatToBeat } from '@/hooks/useBeatToBeat';
import { useHrTrend } from '@/hooks/useHrTrend';
import { useElapsed } from '@/hooks/useNow';
import { useOrientation } from '@/hooks/useOrientation';
import { useRecording } from '@/state/recording';
import { UNDO_WINDOW_MS } from '@/state/recordingStore';
import { useSettings } from '@/state/settings';
import { ThemeProvider, useStyles, useTheme, zonesFor, type Theme } from '@/theme';

const UNDO_MS = UNDO_WINDOW_MS;
/** Narrowest phase/event button (pt): two columns on phones, three when three fit. */
const CELL_MIN = 140;
const MARKER_CELL_MIN = 180;

export default function LiveScreen() {
  const orModeDark = useSettings((s) => s.settings.orModeDark);
  return (
    <ThemeProvider mode={orModeDark ? 'or' : undefined}>
      <LiveView />
    </ThemeProvider>
  );
}

function describeEvent(e: SessionEvent): string {
  const what = e.type === 'phase' ? `Phase: ${PHASE_LABELS[e.phase]}` : `Marked: ${MARKER_LABELS[e.marker]}`;
  const who = e.loggedBy === 'team' ? ' (team)' : '';
  return `${what}${who}${e.note ? ` — “${e.note}”` : ''}`;
}

function hasShift(event: GestureResponderEvent): boolean {
  return (event?.nativeEvent as { shiftKey?: unknown } | undefined)?.shiftKey === true;
}

function nextPhase(current: PhaseKind | null): PhaseKind | null {
  if (current == null) return PHASE_ORDER[0] ?? null;
  const i = PHASE_ORDER.indexOf(current);
  return i >= 0 && i < PHASE_ORDER.length - 1 ? (PHASE_ORDER[i + 1] ?? null) : null;
}

function LiveView() {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { isLandscape, isWide, height, width } = useOrientation();

  const stage = useRecording((s) => s.stage);
  const session = useRecording((s) => s.session);
  const currentBpm = useRecording((s) => s.currentBpm);
  const currentPhase = useRecording((s) => s.currentPhase);
  const lastEvent = useRecording((s) => s.lastEvent);
  const logger = useRecording((s) => s.logger);
  const signalLost = useRecording((s) => s.signalLost);
  const timedOnly = useRecording((s) => s.timedOnly);
  const sensorStatus = useRecording((s) => s.sensorStatus);
  const storeBaseline = useRecording((s) => s.baseline);
  const error = useRecording((s) => s.error);
  const showLiveHr = useSettings((s) => s.settings.showLiveHr);
  const beatToBeat = useBeatToBeat();

  const [hint, setHint] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<MarkerKind | null>(null);
  const [noteText, setNoteText] = useState('');
  const [ending, setEnding] = useState(false);
  const [wasBackgrounded, setWasBackgrounded] = useState(false);

  const elapsed = useElapsed(session?.startedAt);
  const trend = useHrTrend(session?.samples);
  // Zones come from the session itself (its baseline and the participant snapshot taken when it started), exactly as
  // the stored summary derives them, never from the current profile: a profile edited mid-case changes neither.
  const baselineBpm =
    session?.baseline?.restingHr ?? storeBaseline?.restingHr ?? session?.participantSnapshot?.restingHr ?? null;
  const maxHr = session ? sessionMaxHr(session) : null;
  const zones = useMemo(() => zonesFor(baselineBpm, maxHr), [baselineBpm, maxHr]);

  // The undo snackbar only covers what is left of the event's undo window (it is not restarted when the
  // screen is reopened after "Minimise"); a stale `lastEvent` is cleared instead of shown again.
  const undoMs = useMemo(() => (lastEvent ? Math.min(UNDO_MS, UNDO_MS - (Date.now() - lastEvent.t)) : UNDO_MS), [lastEvent]);
  useEffect(() => {
    if (lastEvent && undoMs <= 0 && typeof useRecording.setState === 'function') useRecording.setState({ lastEvent: null });
  }, [lastEvent, undoMs]);

  // Android has no background recording service: JS timers stop while the app is in the background or the
  // screen is locked. Pending data is flushed when that happens (recording store); tell the team afterwards.
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    let left = false;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') left = true;
      else if (state === 'active' && left) {
        left = false;
        setWasBackgrounded(true);
      }
    });
    return () => sub.remove();
  }, []);

  // Android hardware back: keep the live screen unless the user explicitly minimises.
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setHint('Recording continues. Use “Minimise” to leave this screen, or hold “End case” to finish.');
      return true;
    });
    return () => sub.remove();
  }, []);

  if (stage !== 'recording' || !session) {
    return (
      <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <EmptyState icon="radio-button-off" title="No case is being recorded" message="Start a new case from the Record tab.">
          {stage === 'debrief' ? (
            <Button label="Go to debrief" variant="primary" onPress={() => router.replace('/record/debrief')} />
          ) : (
            <Button label="Go to Record" variant="primary" onPress={goHome} />
          )}
        </EmptyState>
      </View>
    );
  }

  const rec = useRecording.getState;
  const next = nextPhase(currentPhase);

  const onPhase = (phase: PhaseKind) => rec().markPhase(phase);
  const onMarker = (marker: MarkerKind) => {
    if (marker === 'note') {
      setNoteText('');
      setNoteFor('note');
      return;
    }
    rec().addMarker(marker);
  };
  const openNote = (marker: MarkerKind) => {
    setNoteText('');
    setNoteFor(marker);
  };
  const submitNote = () => {
    if (!noteFor) return;
    const text = noteText.trim();
    if (text) rec().addMarker(noteFor, text);
    else rec().addMarker(noteFor);
    setNoteFor(null);
  };

  // Web keyboard / assistive-technology users cannot hold the button: ask instead.
  const confirmEnd = async () => {
    const ok = await confirmAsync({
      title: 'End the case now?',
      message: 'Recording stops and the debrief opens.',
      confirmLabel: 'End case',
      cancelLabel: 'Keep recording',
      destructive: true,
    });
    if (ok) await endCase();
  };

  const endCase = async () => {
    if (ending) return;
    setEnding(true);
    try {
      await rec().endRecording();
      router.replace('/record/debrief');
    } finally {
      setEnding(false);
    }
  };

  // Back to the tabs; recording continues and Record offers "Return to live screen".
  const minimise = goHome;

  const clearUndo = () => {
    // The store keeps `lastEvent` until the UI clears it after the undo window.
    if (typeof useRecording.setState === 'function') useRecording.setState({ lastEvent: null });
  };

  const undoEvent = () => {
    const before = rec().session?.events.length ?? 0;
    const event = lastEvent;
    rec().undoLastEvent();
    // Confirm what was removed (the undo bar itself disappears).
    if (event && (rec().session?.events.length ?? 0) < before) setHint(`Undone: ${describeEvent(event)}`);
  };

  // Short phone screens: landscape below 500 pt high, or portrait below 740 pt (e.g. 360 × 640, iPhone SE).
  const compact = isLandscape && height < 500;
  const dense = !isLandscape && !isWide && height < 740;
  // Two columns on phones; three when the controls column fits three 140-pt buttons.
  const contentWidth = width - insets.left - insets.right - 2 * theme.space.lg;
  const controlsWidth = isLandscape ? (contentWidth - theme.space.xl) * 0.6 : contentWidth;
  const basis = (min: number) => {
    const columns = controlsWidth >= 3 * min + 2 * theme.space.sm ? 3 : 2;
    return `${Math.floor(100 / columns) - 2}%` as const;
  };
  const phaseBasis = basis(CELL_MIN);
  // Event buttons carry a glyph badge: three columns only when each is wide enough for "Complication".
  const markerBasis = basis(MARKER_CELL_MIN);

  const clock = (
    <View style={styles.clock} accessible accessibilityLabel={`Elapsed ${formatClock(elapsed)}`}>
      <AppText variant="overline" tone="muted">
        Elapsed
      </AppText>
      <AppText variant="heading" tabular accessibilityRole="timer">
        {formatClock(elapsed)}
      </AppText>
    </View>
  );
  const status = (
    <View style={styles.topMeta}>
      {currentPhase ? (
        <Chip
          label={PHASE_LABELS[currentPhase]}
          dotColor={PHASE_COLORS[currentPhase]}
          accessibilityLabel={`Current phase ${PHASE_LABELS[currentPhase]}`}
        />
      ) : (
        <Chip label="No phase yet" />
      )}
      {!timedOnly ? (
        <SensorStatusPill status={sensorStatus} noData={signalLost} rr={beatToBeat} compact onPress={() => router.push('/sensors')} testID="live-sensor" />
      ) : null}
    </View>
  );
  const minimiseButton = dense ? (
    // Short portrait phones: icon-only so clock, sensor and Minimise share one row (44-pt target).
    <Pressable
      onPress={minimise}
      accessibilityRole="button"
      accessibilityLabel="Minimise"
      accessibilityHint="Leaves the live screen; recording continues"
      style={({ pressed }) => [styles.iconButton, pressed ? styles.pressed : null]}
      testID="live-minimise"
    >
      <Icon name="chevron-down" size={24} color={theme.colors.primary} />
    </Pressable>
  ) : (
    <Button
      label="Minimise"
      variant="ghost"
      icon="chevron-down"
      accessibilityHint="Leaves the live screen; recording continues"
      onPress={minimise}
      testID="live-minimise"
    />
  );
  // Portrait: clock + minimise, then the status chips. Landscape: one row to save height. Short portrait
  // phones: clock, sensor and minimise in one row (the current phase is highlighted in the phase grid).
  const topBar = dense ? (
    <View style={styles.topRow}>
      {clock}
      <View style={[styles.flex, styles.topMeta]}>
        {!timedOnly ? (
          <SensorStatusPill status={sensorStatus} noData={signalLost} rr={beatToBeat} compact onPress={() => router.push('/sensors')} testID="live-sensor" />
        ) : null}
      </View>
      {minimiseButton}
    </View>
  ) : isLandscape ? (
    <View style={styles.topRow}>
      {clock}
      <View style={styles.flex}>{status}</View>
      {minimiseButton}
    </View>
  ) : (
    <View style={styles.topBar}>
      <View style={styles.topRow}>
        {clock}
        {minimiseButton}
      </View>
      {status}
    </View>
  );

  // One fixed-height area shows, in order of priority: the undo bar, a hint, or the signal-lost notice.
  const undoVisible = !!lastEvent && undoMs > 0;
  let overlay: ReactNode = null;
  if (undoVisible && lastEvent) {
    overlay = (
      <Toast
        inline
        visible
        toastKey={lastEvent.id}
        message={describeEvent(lastEvent)}
        actionLabel="Undo"
        onAction={undoEvent}
        onDismiss={clearUndo}
        durationMs={Math.max(1, undoMs)}
        showCountdown
        large={!compact}
        icon={compact ? undefined : lastEvent.type === 'phase' ? 'flag' : 'pin'}
        testID="live-undo"
      />
    );
  } else if (hint) {
    overlay = (
      <Toast
        inline
        visible
        message={hint}
        toastKey={hint}
        onDismiss={() => setHint(null)}
        durationMs={4000}
        large={!compact}
        icon={compact ? undefined : 'information-circle'}
        testID="live-hint"
      />
    );
  } else if (signalLost) {
    overlay = (
      <View
        style={styles.notice}
        accessible
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        accessibilityLabel="Signal lost. No heart-rate data for over 15 seconds. Check strap contact and battery. Recording continues."
        testID="live-signal-lost"
      >
        <Icon name="warning" size={22} color={theme.colors.warning} />
        <View style={styles.flex}>
          <AppText variant="bodyStrong" tone="warning" numberOfLines={1}>
            Signal lost
          </AppText>
          <AppText variant="label" numberOfLines={dense || compact ? 1 : 2}>
            No data for over 15 s. Check strap contact and battery — recording continues.
          </AppText>
        </View>
      </View>
    );
  }

  const loggerToggle = (
    <View style={styles.sectionHead}>
      <AppText variant="overline" tone="muted" accessibilityRole="header">
        Logged by
      </AppText>
      <SegmentedControl
        options={[
          { value: 'self', label: 'Self', accessibilityLabel: 'Logged by me (surgeon)' },
          { value: 'team', label: 'Team', accessibilityLabel: 'Logged by a team member' },
        ]}
        value={logger}
        onChange={(v) => rec().setLogger(v)}
        accessibilityLabel="Who is logging events"
        style={styles.logger}
        testID="live-logger"
      />
    </View>
  );

  const hrPanel = (
    <View style={[styles.hrPanel, isLandscape ? styles.hrPanelLandscape : null]}>
      <LiveHeartRate
        bpm={currentBpm}
        trend={trend}
        zones={zones}
        samples={session.samples}
        baselineBpm={baselineBpm}
        timedOnly={timedOnly}
        elapsedMs={elapsed}
        compact={compact}
        dense={dense}
        large={isWide && !compact}
        signalLost={signalLost}
        hidden={showLiveHr === false}
        overlay={overlay}
      />
      {error ? <Banner tone="danger" message={error} /> : null}
      {wasBackgrounded ? (
        <Banner
          tone="warning"
          title="SurgeonPulse was in the background"
          message="Heart-rate data may be missing for that time. Keep the app open with the screen on until the case ends."
          action={<Button label="OK" size="sm" variant="ghost" onPress={() => setWasBackgrounded(false)} />}
          testID="live-backgrounded"
        />
      ) : null}
    </View>
  );

  const controls = (
    <ScrollView
      style={styles.controlsScroll}
      contentContainerStyle={[
        styles.controls,
        compact || dense ? styles.controlsTight : null,
        { paddingBottom: theme.space.lg + insets.bottom },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      {isLandscape ? null : loggerToggle}

      {compact ? null : (
        // Short landscape phones drop this heading so "Complication" stays above the fold.
        <AppText variant="overline" tone="muted" accessibilityRole="header">
          Phase
        </AppText>
      )}
      <View style={styles.grid}>
        {PHASE_ORDER.map((phase) => (
          <View key={phase} style={[styles.cell, { flexBasis: phaseBasis }]}>
            <BigButton
              label={PHASE_LABELS[phase]}
              accent={PHASE_COLORS[phase]}
              emphasis={phase === currentPhase ? 'current' : phase === next ? 'next' : 'none'}
              sublabel={phase === currentPhase ? 'Current' : phase === next ? 'Next' : undefined}
              onPress={() => onPhase(phase)}
              accessibilityHint={phase === currentPhase ? 'This phase is in progress' : `Marks the start of ${PHASE_LABELS[phase]}`}
              testID={`phase-${phase}`}
            />
          </View>
        ))}
      </View>

      <AppText variant="overline" tone="muted" accessibilityRole="header">
        {Platform.OS === 'web' ? 'Events · hold or Shift+Enter for a note' : 'Events · hold for a note'}
      </AppText>
      <View style={styles.grid}>
        {MARKER_KINDS.map((marker) => (
          <View key={marker} style={[styles.cell, { flexBasis: markerBasis }]}>
            <BigButton
              label={MARKER_LABELS[marker]}
              glyph={MARKER_ICONS[marker]}
              labelSize="medium"
              accent={marker === 'complication' ? theme.colors.danger : theme.colors.textMuted}
              // Web: Shift+Enter (or Shift+click) adds a note — keyboards cannot long-press.
              onPress={(e) => (Platform.OS === 'web' && hasShift(e) ? openNote(marker) : onMarker(marker))}
              onLongPress={() => openNote(marker)}
              delayLongPress={500}
              accessibilityHint={marker === 'note' ? 'Adds a timestamped note' : 'Marks this event now. Hold to add a note.'}
              accessibilityActions={[{ name: 'addNote', label: `${MARKER_LABELS[marker]} with a note` }]}
              onAccessibilityAction={(e) => {
                if (e.nativeEvent.actionName === 'addNote') openNote(marker);
              }}
              testID={`marker-${marker}`}
            />
          </View>
        ))}
      </View>

      <HoldToEndButton
        onConfirm={() => void endCase()}
        onTap={() => setHint('Press and hold “End case” for 1.5 seconds to finish.')}
        onConfirmRequest={() => void confirmEnd()}
        disabled={ending}
        testID="live-end"
      />
    </ScrollView>
  );

  return (
    <View
      style={[
        styles.root,
        { paddingTop: insets.top + theme.space.sm, paddingLeft: insets.left + theme.space.lg, paddingRight: insets.right + theme.space.lg },
      ]}
      testID="record-live"
    >
      {topBar}
      {isLandscape ? (
        <View style={styles.landscape}>
          <View style={styles.landscapeSide}>
            {hrPanel}
            {loggerToggle}
          </View>
          <View style={styles.landscapeControls}>{controls}</View>
        </View>
      ) : (
        <>
          {hrPanel}
          {controls}
        </>
      )}

      <Dialog
        visible={noteFor != null}
        title={noteFor ? (noteFor === 'note' ? 'Add a note' : `${MARKER_LABELS[noteFor]} — add a note`) : ''}
        message="The time is recorded when you tap Add. Do not enter patient names or identifiers."
        onRequestClose={() => setNoteFor(null)}
        actions={[
          { label: 'Add', variant: 'primary', onPress: submitNote, testID: 'note-add' },
          { label: 'Cancel', variant: 'ghost', onPress: () => setNoteFor(null) },
        ]}
      >
        <TextField
          label="Note (optional)"
          value={noteText}
          onChangeText={setNoteText}
          placeholder="e.g. bleeding from cystic artery"
          maxLength={140}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={submitNote}
          testID="note-input"
        />
      </Dialog>
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.colors.bg, gap: t.space.sm },
    flex: { flex: 1 },
    topBar: { gap: t.space.xs },
    topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.space.md },
    clock: { minWidth: 110 },
    iconButton: {
      minWidth: t.layout.minTouch,
      minHeight: t.layout.minTouch,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: t.radius.md,
    },
    pressed: { opacity: 0.6 },
    topMeta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: t.space.sm },
    hrPanel: { gap: t.space.sm },
    hrPanelLandscape: { justifyContent: 'center' },
    landscape: { flex: 1, flexDirection: 'row', gap: t.space.xl },
    landscapeSide: { flex: 4, justifyContent: 'center', gap: t.space.md },
    landscapeControls: { flex: 6 },
    controlsScroll: { flex: 1 },
    controls: { gap: t.space.md, paddingTop: t.space.xs },
    controlsTight: { gap: t.space.sm },
    notice: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.md,
      paddingHorizontal: t.space.md,
      borderRadius: t.radius.md,
      borderLeftWidth: 4,
      borderColor: t.colors.warning,
      backgroundColor: t.colors.warningSoft,
    },
    sectionHead: { flexDirection: 'row', alignItems: 'center', gap: t.space.md, flexWrap: 'wrap' },
    logger: { flex: 1, minWidth: 180, maxWidth: 320 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm },
    cell: { flexGrow: 1, minWidth: CELL_MIN },
  });
