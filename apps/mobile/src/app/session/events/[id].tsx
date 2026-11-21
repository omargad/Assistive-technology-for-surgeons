/**
 * Retrospective event editor: correct event times with ±1 min / ±10 s nudges,
 * change an event's kind, add phases or markers (logged as 'retrospective'),
 * and remove events. Edits use core `addEvent` / `updateEvent` /
 * `removeEvent`; saving persists the events and re-computes the summary.
 */
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Stack, router, useLocalSearchParams, usePreventRemove } from 'expo-router';

import {
  EVENT_LOGGER_LABELS,
  MARKER_ICONS,
  MARKER_KINDS,
  MARKER_LABELS,
  PHASE_COLORS,
  PHASE_LABELS,
  PHASE_ORDER,
  addEvent,
  derivePhases,
  removeEvent,
  sessionEnd,
  summarizeSession,
  updateEvent,
} from '@surgeonpulse/core';
import type { MarkerKind, PhaseKind, SessionEvent, SurgicalSession } from '@surgeonpulse/core';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { confirmAsync, notify } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Screen } from '@/components/Screen';
import { SegmentedControl } from '@/components/SegmentedControl';
import { HrTimelineChart } from '@/components/charts/HrTimelineChart';
import { errorMessage, useBusy } from '@/hooks/useBusy';
import { summaryOptions, useSessionDetail } from '@/hooks/useSessionDetail';
import { repository } from '@/services/storage';
import { useRecording } from '@/state/recording';
import { activeSessionOf, shouldAutoUpload } from '@/state/recordingStore';
import { useSessions } from '@/state/sessions';
import { useSettings } from '@/state/settings';
import { uploadSessions, withoutUploadedTag } from '@/services/upload/research';
import { formatElapsed, useStyles, useTheme, withAlpha, type Theme } from '@/theme';

const NUDGES = [
  { deltaMs: -60_000, label: '−1 min', spoken: '1 minute earlier' },
  { deltaMs: -10_000, label: '−10 s', spoken: '10 seconds earlier' },
  { deltaMs: 10_000, label: '+10 s', spoken: '10 seconds later' },
  { deltaMs: 60_000, label: '+1 min', spoken: '1 minute later' },
] as const;

function eventLabel(e: SessionEvent): string {
  return e.type === 'phase' ? PHASE_LABELS[e.phase] : MARKER_LABELS[e.marker];
}

export default function EventEditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session, loading, error } = useSessionDetail(typeof id === 'string' ? id : undefined);
  // The recording store owns the case until its debrief is saved: edits here would be overwritten by the
  // next live event and missing from the summary, so they wait until the case has ended.
  const inProgress = useRecording((s) => typeof id === 'string' && activeSessionOf(s) === id);

  if (inProgress) {
    return (
      <Screen>
        <EmptyState
          icon="time-outline"
          title="Case in progress"
          message="Events can be corrected once the case has ended. Until then, mark and undo events on the live screen."
          testID="events-in-progress"
        >
          <Button label="Go back" onPress={() => router.back()} />
        </EmptyState>
      </Screen>
    );
  }
  if (loading && !session) {
    return (
      <Screen>
        <AppText variant="label" tone="muted" align="center">
          Loading events…
        </AppText>
      </Screen>
    );
  }
  if (error || !session) {
    return (
      <Screen>
        <EmptyState icon="alert-circle-outline" title="Session unavailable" message={error ?? undefined}>
          <Button label="Go back" onPress={() => router.back()} />
        </EmptyState>
      </Screen>
    );
  }
  return <Editor original={session} />;
}

function Editor({ original }: { original: SurgicalSession }) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const [draft, setDraft] = useState<SurgicalSession>(original);
  const [dirty, setDirty] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addType, setAddType] = useState<'phase' | 'marker'>('phase');
  const { busy, run } = useBusy();

  const start = original.startedAt;
  const end = useMemo(() => Math.max(sessionEnd(original), start + 60_000), [original, start]);
  const phases = useMemo(() => derivePhases(draft), [draft]);
  const selected = draft.events.find((e) => e.id === selectedId) ?? null;

  // Keep the selection valid after removals.
  useEffect(() => {
    if (selectedId && !draft.events.some((e) => e.id === selectedId)) setSelectedId(null);
  }, [draft.events, selectedId]);

  // Unsaved edits: every way of leaving (iOS swipe-back, Android back, header back, browser back) asks first.
  const allowLeave = usePreventRemove(dirty, ({ repeat }) => {
    void confirmDiscard().then((ok) => {
      if (!ok) return;
      // Clear `dirty` in the same handler so the hook's prevention state and its prop stay in sync.
      setDirty(false);
      allowLeave();
      repeat();
    });
  });
  const confirmDiscard = () =>
    confirmAsync({ title: 'Discard changes?', message: 'Your edits to the event times will be lost.', confirmLabel: 'Discard', destructive: true });

  const clampT = (t: number) => Math.min(end, Math.max(start, t));
  const apply = (next: SurgicalSession) => {
    setDraft(next);
    setDirty(true);
  };

  // An event whose time or kind is changed after the case is no longer a live record: it is marked
  // 'retrospective', so analyses restricted to live-logged timing exclude reconstructed times (RV-12).
  const nudge = (e: SessionEvent, deltaMs: number) =>
    apply(updateEvent(draft, e.id, { t: clampT(e.t + deltaMs), loggedBy: 'retrospective' }));
  const remove = (e: SessionEvent) => apply(removeEvent(draft, e.id));
  const changeKind = (e: SessionEvent, kind: PhaseKind | MarkerKind) =>
    apply(
      updateEvent(
        draft,
        e.id,
        e.type === 'phase'
          ? { phase: kind as PhaseKind, loggedBy: 'retrospective' }
          : { marker: kind as MarkerKind, loggedBy: 'retrospective' },
      ),
    );

  const addNew = (kind: PhaseKind | MarkerKind) => {
    const last = draft.events[draft.events.length - 1];
    const anchor = selected?.t ?? last?.t ?? start;
    const t = clampT(anchor + (selected || last ? 60_000 : 0));
    const next =
      addType === 'phase'
        ? addEvent(draft, { type: 'phase', phase: kind as PhaseKind, t, loggedBy: 'retrospective' })
        : addEvent(draft, { type: 'marker', marker: kind as MarkerKind, t, loggedBy: 'retrospective' });
    const added = next.events.find((e) => !draft.events.some((d) => d.id === e.id));
    apply(next);
    if (added) setSelectedId(added.id);
  };

  const save = () =>
    void run('save', async () => {
      try {
        // Edited events make an earlier upload out of date: drop the "uploaded" marker (RV-3).
        const tags = withoutUploadedTag(original.tags);
        await repository.updateMeta(original.id, tags === undefined ? { events: draft.events } : { events: draft.events, tags });
        const updated: SurgicalSession = { ...original, events: draft.events, ...(tags === undefined ? {} : { tags }) };
        const profile = useSessions.getState().profile;
        const summary = summarizeSession(updated, summaryOptions(profile));
        await repository.saveSummary(original.id, summary);
        await useSessions.getState().refresh();
        const settings = useSettings.getState().settings;
        if (updated.status === 'completed' && shouldAutoUpload(settings, profile)) {
          // Fire and forget, like the upload after the debrief; the server replaces its copy.
          void uploadSessions([updated], { url: settings.researchServerUrl, token: settings.researchToken, profile })
            .then(() => useSessions.getState().refresh())
            .catch(() => undefined);
        }
        setDirty(false);
        allowLeave();
        if (router.canGoBack()) router.back();
        else router.replace(`/session/${original.id}`);
      } catch (e) {
        notify('Could not save events', errorMessage(e));
      }
    });

  const discard = async () => {
    if (dirty) {
      if (!(await confirmDiscard())) return;
      setDirty(false);
      allowLeave();
    }
    if (router.canGoBack()) router.back();
    else router.replace(`/session/${original.id}`);
  };

  const footer = (
    <View style={styles.row}>
      <Button label={dirty ? 'Discard' : 'Close'} onPress={() => void discard()} style={styles.flex} />
      <Button
        label="Save changes"
        variant="primary"
        icon="checkmark"
        disabled={!dirty}
        loading={busy === 'save'}
        onPress={save}
        style={styles.flex}
        testID="events-save"
      />
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ title: 'Edit events', headerBackVisible: !dirty }} />
      <Screen edges={['left', 'right', 'bottom']} footer={footer} testID="event-editor">
        <AppText variant="body" tone="muted">
          Correct times that were tapped late or early, fix a wrong phase, or add events you remember. Times are
          elapsed from the start of the case.
        </AppText>

        <Card>
          <HrTimelineChart
            samples={draft.samples}
            startedAt={start}
            endedAt={end}
            phases={phases}
            events={draft.events}
            highlightEventId={selectedId}
            height={170}
            showLegend={false}
            testID="events-chart"
          />
        </Card>

        <Card title={`Events (${draft.events.length})`}>
          {draft.events.length === 0 ? (
            <AppText variant="label" tone="muted">
              No events yet. Add the phases and markers you remember below.
            </AppText>
          ) : (
            draft.events.map((e) => {
              const isSel = e.id === selectedId;
              const color = e.type === 'phase' ? PHASE_COLORS[e.phase] : theme.colors.textMuted;
              return (
                <View key={e.id} style={[styles.event, isSel ? { borderColor: theme.colors.primary, backgroundColor: withAlpha(theme.colors.primary, 0.06) } : null]}>
                  <Pressable
                    onPress={() => setSelectedId(isSel ? null : e.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`${eventLabel(e)} at ${formatElapsed(e.t - start, true)}${e.loggedBy ? `, ${EVENT_LOGGER_LABELS[e.loggedBy]}` : ''}`}
                    aria-expanded={isSel}
                    accessibilityHint={isSel ? 'Collapses the editing controls' : 'Shows controls to adjust or remove this event'}
                    style={styles.eventHead}
                    testID={`event-${e.id}`}
                  >
                    <View style={[styles.badge, { borderColor: color, backgroundColor: withAlpha(color, 0.18) }]}>
                      <AppText variant="caption" weight="bold">
                        {e.type === 'phase' ? 'P' : MARKER_ICONS[e.marker]}
                      </AppText>
                    </View>
                    <View style={styles.flex}>
                      <AppText variant="bodyStrong">{eventLabel(e)}</AppText>
                      <AppText variant="caption" tone="muted">
                        {e.type === 'phase' ? 'Phase' : 'Marker'}
                        {e.loggedBy ? ` · ${EVENT_LOGGER_LABELS[e.loggedBy]}` : ''}
                        {e.note ? ` · “${e.note}”` : ''}
                      </AppText>
                    </View>
                    <AppText variant="bodyStrong" tabular>
                      {formatElapsed(e.t - start, true)}
                    </AppText>
                  </Pressable>
                  {isSel ? (
                    <View style={styles.editor}>
                      <View style={styles.nudges}>
                        {NUDGES.map((n) => (
                          <Button
                            key={n.label}
                            label={n.label}
                            size="sm"
                            onPress={() => nudge(e, n.deltaMs)}
                            accessibilityLabel={`Move ${eventLabel(e)} ${n.spoken}`}
                            style={styles.nudge}
                            testID={`nudge-${n.deltaMs}`}
                          />
                        ))}
                      </View>
                      <View style={styles.chips}>
                        {(e.type === 'phase' ? PHASE_ORDER : MARKER_KINDS).map((k) => (
                          <Chip
                            key={k}
                            label={e.type === 'phase' ? PHASE_LABELS[k as PhaseKind] : MARKER_LABELS[k as MarkerKind]}
                            dotColor={e.type === 'phase' ? PHASE_COLORS[k as PhaseKind] : undefined}
                            selected={e.type === 'phase' ? e.phase === k : e.marker === k}
                            onPress={() => changeKind(e, k)}
                          />
                        ))}
                      </View>
                      <Button label="Remove event" variant="ghost" icon="trash-outline" size="sm" onPress={() => remove(e)} accessibilityLabel={`Remove ${eventLabel(e)}`} />
                    </View>
                  ) : null}
                </View>
              );
            })
          )}
        </Card>

        <Card title="Add an event" subtitle={selected ? `Added 1 minute after “${eventLabel(selected)}” — then nudge it into place` : 'Added after the last event — then nudge it into place'}>
          <SegmentedControl
            options={[
              { value: 'phase', label: 'Phase' },
              { value: 'marker', label: 'Marker' },
            ]}
            value={addType}
            onChange={setAddType}
            accessibilityLabel="Type of event to add"
            size="sm"
          />
          <View style={styles.chips}>
            {addType === 'phase'
              ? PHASE_ORDER.map((p) => (
                  <Chip key={p} label={PHASE_LABELS[p]} dotColor={PHASE_COLORS[p]} icon="add" onPress={() => addNew(p)} accessibilityLabel={`Add phase ${PHASE_LABELS[p]}`} />
                ))
              : MARKER_KINDS.map((m) => (
                  <Chip key={m} label={MARKER_LABELS[m]} icon="add" onPress={() => addNew(m)} accessibilityLabel={`Add marker ${MARKER_LABELS[m]}`} />
                ))}
          </View>
        </Card>
      </Screen>
    </>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    flex: { flex: 1 },
    row: { flexDirection: 'row', gap: t.space.sm },
    event: {
      borderWidth: 1,
      borderColor: t.colors.border,
      borderRadius: t.radius.md,
      overflow: 'hidden',
    },
    eventHead: { flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.md, minHeight: 56 },
    badge: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
    editor: { gap: t.space.sm, paddingHorizontal: t.space.md, paddingBottom: t.space.md },
    nudges: { flexDirection: 'row', gap: t.space.xs },
    nudge: { flex: 1, minWidth: 0 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.xs },
  });
