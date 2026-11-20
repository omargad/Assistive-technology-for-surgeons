/**
 * Live "OR mode" screen. Readable from 1–2 m and operable by a non-sterile
 * team member: big zone-coloured HR with trend, elapsed clock, current phase,
 * sensor status, signal-lost banner, phase buttons (PHASE_ORDER, current
 * highlighted, next emphasised), marker buttons (hold for a quick note),
 * "Logged by: Self / Team", a 10-second undo snackbar and a press-and-hold
 * "End case". Landscape puts HR on the left and controls on the right.
 */
import { useEffect, useMemo, useState } from 'react';
import { BackHandler, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  MARKER_ICONS,
  MARKER_KINDS,
  MARKER_LABELS,
  PHASE_COLORS,
  PHASE_LABELS,
  PHASE_ORDER,
  estimateMaxHr,
  formatClock,
} from '@surgeonpulse/core';
import type { MarkerKind, PhaseKind, SessionEvent } from '@surgeonpulse/core';

import { AppText } from '@/components/AppText';
import { Banner } from '@/components/Banner';
import { BigButton } from '@/components/BigButton';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Dialog } from '@/components/Dialog';
import { EmptyState } from '@/components/EmptyState';
import { SegmentedControl } from '@/components/SegmentedControl';
import { SensorStatusPill } from '@/components/SensorStatusPill';
import { TextField } from '@/components/TextField';
import { goHome } from '@/components/navigation';
import { Toast } from '@/components/Toast';
import { HoldToEndButton } from '@/components/live/HoldToEndButton';
import { LiveHeartRate } from '@/components/live/LiveHeartRate';
import { useHrTrend } from '@/hooks/useHrTrend';
import { useElapsed } from '@/hooks/useNow';
import { useOrientation } from '@/hooks/useOrientation';
import { useRecording } from '@/state/recording';
import { useSessions } from '@/state/sessions';
import { useSettings } from '@/state/settings';
import { ThemeProvider, useStyles, useTheme, zonesFor, type Theme } from '@/theme';

const UNDO_MS = 10_000;

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
  const profile = useSessions((s) => s.profile);

  const [hint, setHint] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<MarkerKind | null>(null);
  const [noteText, setNoteText] = useState('');
  const [ending, setEnding] = useState(false);

  const elapsed = useElapsed(session?.startedAt);
  const trend = useHrTrend(session?.samples);
  const baselineBpm = session?.baseline?.restingHr ?? storeBaseline?.restingHr ?? profile?.restingHr ?? null;
  const zones = useMemo(() => {
    const maxHr =
      profile?.maxHr ?? (profile?.birthYear ? estimateMaxHr(profile.birthYear, new Date().getFullYear()) : null);
    return zonesFor(baselineBpm, maxHr);
  }, [baselineBpm, profile?.maxHr, profile?.birthYear]);

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

  const compact = isLandscape && height < 500;
  // Two columns on phones; three when the controls area is tablet-wide.
  const controlsWidth = isLandscape ? width * 0.6 : width;
  const columns = controlsWidth >= 680 ? 3 : 2;
  const cellBasis = `${Math.floor(100 / columns) - 2}%` as const;

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
      {!timedOnly ? <SensorStatusPill status={sensorStatus} compact onPress={() => router.push('/sensors')} /> : null}
    </View>
  );
  const minimiseButton = (
    <Button
      label="Minimise"
      size="sm"
      variant="ghost"
      icon="chevron-down"
      accessibilityHint="Leaves the live screen; recording continues"
      onPress={minimise}
    />
  );
  // Portrait: clock + minimise, then the status chips. Landscape: one row to save height.
  const topBar = isLandscape ? (
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
        large={isWide && !compact}
      />
      {signalLost ? (
        <Banner
          tone="warning"
          title="Signal lost"
          message="No heart-rate data for over 15 seconds. Check strap contact and battery — recording continues."
          testID="live-signal-lost"
        />
      ) : null}
      {error ? <Banner tone="danger" message={error} /> : null}
    </View>
  );

  const controls = (
    <ScrollView
      style={styles.controlsScroll}
      contentContainerStyle={[styles.controls, { paddingBottom: 96 + insets.bottom }]}
      keyboardShouldPersistTaps="handled"
    >
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
          size="sm"
          style={styles.logger}
          testID="live-logger"
        />
      </View>

      <AppText variant="overline" tone="muted" accessibilityRole="header">
        Phase
      </AppText>
      <View style={styles.grid}>
        {PHASE_ORDER.map((phase) => (
          <View key={phase} style={[styles.cell, { flexBasis: cellBasis }]}>
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
        Events · hold for a note
      </AppText>
      <View style={styles.grid}>
        {MARKER_KINDS.map((marker) => (
          <View key={marker} style={[styles.cell, { flexBasis: cellBasis }]}>
            <BigButton
              label={MARKER_LABELS[marker]}
              glyph={MARKER_ICONS[marker]}
              labelSize="medium"
              accent={marker === 'complication' ? theme.colors.danger : theme.colors.textMuted}
              onPress={() => onMarker(marker)}
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
          {hrPanel}
          <View style={styles.landscapeControls}>{controls}</View>
        </View>
      ) : (
        <>
          {hrPanel}
          {controls}
        </>
      )}

      <Toast
        visible={!!lastEvent}
        toastKey={lastEvent?.id}
        message={lastEvent ? describeEvent(lastEvent) : ''}
        actionLabel="Undo"
        onAction={() => rec().undoLastEvent()}
        onDismiss={clearUndo}
        durationMs={UNDO_MS}
        showCountdown
        large
        icon={lastEvent?.type === 'phase' ? 'flag' : 'pin'}
        bottomOffset={insets.bottom + theme.space.md}
        testID="live-undo"
      />
      <Toast
        visible={!lastEvent && !!hint}
        message={hint ?? ''}
        toastKey={hint ?? undefined}
        onDismiss={() => setHint(null)}
        durationMs={4000}
        icon="information-circle"
        bottomOffset={insets.bottom + theme.space.md}
      />

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
    topMeta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: t.space.sm },
    hrPanel: { gap: t.space.sm },
    hrPanelLandscape: { flex: 4, justifyContent: 'center' },
    landscape: { flex: 1, flexDirection: 'row', gap: t.space.xl },
    landscapeControls: { flex: 6 },
    controlsScroll: { flex: 1 },
    controls: { gap: t.space.md, paddingTop: t.space.xs },
    sectionHead: { flexDirection: 'row', alignItems: 'center', gap: t.space.md, flexWrap: 'wrap' },
    logger: { flex: 1, minWidth: 180, maxWidth: 320 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm },
    cell: { flexGrow: 1, minWidth: 140 },
  });
