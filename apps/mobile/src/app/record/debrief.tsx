/**
 * Post-operative debrief (1–2 minutes): SURG-TLX (six 0–100 ratings in steps
 * of 5, wording from core `SURG_TLX_DIMENSIONS`), optional pairwise weighting
 * (core `tlxPairs`), live workload score (core `scoreWorkload`), then
 * self-rated performance, perceived stress, sleep, caffeine, outcome and notes.
 *
 * Every rating starts unanswered (no thumb, no default value): the score appears
 * once all six SURG-TLX items are rated, and saving with some unrated asks whether
 * to save the debrief without the workload ratings (never filled with defaults).
 */
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';

import {
  OUTCOME_LABELS,
  SURG_TLX_DIMENSIONS,
  formatDuration,
  scoreWorkload,
  tlxPairs,
} from '@surgeonpulse/core';
import type { CaseOutcome, PostOpReport } from '@surgeonpulse/core';

import { AppText } from '@/components/AppText';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { confirmAsync, notify } from '@/components/ConfirmDialog';
import { SectionHeader, SwitchRow } from '@/components/Controls';
import { EmptyState } from '@/components/EmptyState';
import { Screen } from '@/components/Screen';
import { goHome } from '@/components/navigation';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Slider } from '@/components/Slider';
import { TextField } from '@/components/TextField';
import {
  EMPTY_RATINGS,
  buildPostOpReport,
  completeRatings,
  missingRatings,
  weightsFromChoices,
  type DraftRatings,
} from '@/components/debriefReport';
import { errorMessage, useBusy } from '@/hooks/useBusy';
import { healthStore } from '@/services/health';
import { useRecording } from '@/state/recording';
import { useSessions } from '@/state/sessions';
import { formatNumber, useStyles, type Theme } from '@/theme';

const OUTCOMES = Object.keys(OUTCOME_LABELS) as CaseOutcome[];
const DIM_LABEL = new Map(SURG_TLX_DIMENSIONS.map((d) => [d.id as string, d.label]));

export default function DebriefScreen() {
  const styles = useStyles(makeStyles);
  const stage = useRecording((s) => s.stage);
  const session = useRecording((s) => s.session);
  const timedOnly = useRecording((s) => s.timedOnly);
  const pairs = useMemo(() => tlxPairs('surg-tlx'), []);

  const [ratings, setRatings] = useState<DraftRatings>(EMPTY_RATINGS);
  const [weighting, setWeighting] = useState(false);
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [performance, setPerformance] = useState<number | null>(null);
  const [perceivedStress, setPerceivedStress] = useState<number | null>(null);
  const [sleepHours, setSleepHours] = useState<number | null>(null);
  const [caffeine, setCaffeine] = useState<boolean | null>(null);
  const [outcome, setOutcome] = useState<CaseOutcome | null>(null);
  const [notes, setNotes] = useState('');
  const [imported, setImported] = useState<number | null>(null);
  const { busy, run } = useBusy();

  const weights = weighting ? weightsFromChoices(pairs, choices) : null;
  const answered = Object.keys(choices).length;
  const missing = missingRatings(ratings);
  const score = useMemo(() => {
    const complete = completeRatings(ratings);
    return complete ? scoreWorkload({ instrument: 'surg-tlx', ratings: complete, ...(weights ? { weights } : {}), completedAt: 0 }) : null;
  }, [ratings, weights]);

  if (stage !== 'debrief' || !session) {
    return (
      <Screen>
        <EmptyState icon="clipboard-outline" title="No debrief waiting" message="The debrief opens automatically when you end a case.">
          <Button label="Go to Record" variant="primary" onPress={goHome} />
        </EmptyState>
      </Screen>
    );
  }

  const durationSec = ((session.endedAt ?? Date.now()) - session.startedAt) / 1000;

  const finish = (report: PostOpReport) =>
    run('submit', async () => {
      try {
        const id = await useRecording.getState().submitDebrief(report);
        await useSessions.getState().refresh();
        useRecording.getState().reset();
        router.replace(`/session/${id}`);
      } catch (e) {
        notify('Could not save the debrief', errorMessage(e));
      }
    });

  const submit = async () => {
    if (missing.length > 0) {
      // Never store midpoint defaults as ratings: either all six are rated or the workload is left out.
      const names = missing.map((id) => DIM_LABEL.get(id) ?? id).join(', ');
      const ok = await confirmAsync({
        title: 'Workload ratings incomplete',
        message: `Not rated yet: ${names}. The workload score needs all six ratings. Save this debrief without the workload ratings?`,
        confirmLabel: 'Save without workload',
        cancelLabel: 'Rate the rest',
      });
      if (!ok) return;
    }
    void finish(
      buildPostOpReport(
        { ratings, weights, performance, perceivedStress, sleepHours, caffeine, outcome, notes },
        Date.now(),
      ),
    );
  };

  const skip = async () => {
    const ok = await confirmAsync({
      title: 'Skip the questionnaire?',
      message: 'The recording is kept, but without your workload ratings it is less useful for feedback and research.',
      confirmLabel: 'Skip',
      cancelLabel: 'Go back',
    });
    if (ok) void finish({});
  };

  const importHr = () =>
    run('import', async () => {
      try {
        const n = await useRecording.getState().importFromHealth(session.id);
        setImported(n);
      } catch (e) {
        notify(`Could not import from ${healthStore.label}`, errorMessage(e));
      }
    });

  const footer = (
    <View style={styles.row}>
      <Button label="Skip" variant="ghost" onPress={() => void skip()} disabled={busy != null} />
      <Button
        label="Save debrief"
        variant="primary"
        icon="checkmark"
        style={styles.flex}
        loading={busy === 'submit'}
        disabled={busy != null}
        onPress={() => void submit()}
        testID="debrief-submit"
      />
    </View>
  );

  return (
    <Screen edges={['left', 'right', 'bottom']} footer={footer} testID="record-debrief">
      <View style={styles.header}>
        <AppText variant="title">How was that case?</AppText>
        <AppText variant="body" tone="muted">
          {session.procedure.name} · {formatDuration(durationSec)}. Answer for the case as a whole — about 1–2 minutes.
        </AppText>
      </View>

      {timedOnly ? (
        <Card icon="watch-outline" title={`Heart rate from ${healthStore.label}`} tone="primary">
          <AppText variant="label" tone="muted">
            Your watch data may take a few minutes to sync. You can import now or later from the session page.
          </AppText>
          {imported != null ? (
            <AppText variant="bodyStrong" tone={imported > 0 ? 'success' : 'warning'}>
              {imported > 0 ? `Imported ${imported} heart-rate samples.` : 'No samples found yet — try again later from the session page.'}
            </AppText>
          ) : null}
          <Button label="Import heart rate now" icon="download-outline" loading={busy === 'import'} onPress={() => void importHr()} />
        </Card>
      ) : null}

      <SectionHeader title="Workload (SURG-TLX)" />
      <AppText variant="caption" tone="faint">
        Tap each scale to rate the demand from very low to very high. Use the whole scale.
      </AppText>
      {SURG_TLX_DIMENSIONS.map((dim) => (
        <Card key={dim.id} style={styles.dimCard}>
          <AppText variant="subheading">{dim.label}</AppText>
          <AppText variant="label" tone="muted">
            {dim.question}
          </AppText>
          <Slider
            label={dim.label}
            value={ratings[dim.id]}
            onChange={(v) => setRatings((r) => ({ ...r, [dim.id]: v }))}
            unansweredText="Not rated"
            min={0}
            max={100}
            step={5}
            lowLabel={dim.low}
            highLabel={dim.high}
            formatValue={(v) => `${v} / 100`}
            testID={`tlx-${dim.id}`}
          />
        </Card>
      ))}

      <Card>
        <View
          style={styles.scoreRow}
          accessible
          accessibilityLabel={
            score
              ? `Workload score ${formatNumber(score.weighted ?? score.raw, 1)} out of 100${score.weighted != null ? ', weighted' : ''}`
              : `Workload score not available yet: ${6 - missing.length} of 6 rated`
          }
        >
          <AppText variant="bodyStrong">Workload score</AppText>
          <AppText variant="title" tabular testID="debrief-score">
            {score ? formatNumber(score.weighted ?? score.raw, 1) : '—'}
          </AppText>
        </View>
        <AppText variant="caption" tone="faint">
          {!score
            ? `Rate all six demands to see the score (${6 - missing.length} of 6 rated).`
            : score.weighted != null
              ? `Weighted by your pairwise choices (unweighted ${formatNumber(score.raw, 1)}).`
              : 'Mean of the six ratings (0–100).'}
        </AppText>
      </Card>

      <View style={styles.weighting}>
        <SwitchRow
          title="Weight the dimensions (optional)"
          subtitle="15 quick choices: which mattered more to your workload in this case?"
          value={weighting}
          onValueChange={setWeighting}
          testID="debrief-weighting"
        />
      </View>
      {weighting ? (
        <Card subtitle={`${answered} of ${pairs.length} answered`}>
          {pairs.map(([a, b], i) => (
            <View key={`${a}-${b}`} style={styles.pair}>
              <AppText variant="caption" tone="muted">
                {i + 1}. Which contributed more?
              </AppText>
              <SegmentedControl
                options={[
                  { value: a, label: DIM_LABEL.get(a) ?? a },
                  { value: b, label: DIM_LABEL.get(b) ?? b },
                ]}
                value={choices[i] ?? null}
                onChange={(v) => setChoices((c) => ({ ...c, [i]: v }))}
                accessibilityLabel={`Comparison ${i + 1}: ${DIM_LABEL.get(a)} or ${DIM_LABEL.get(b)}`}
                size="sm"
                testID={`pair-${i}`}
              />
            </View>
          ))}
          {answered < pairs.length ? (
            <AppText variant="caption" tone="warning">
              Weights are used only when all {pairs.length} comparisons are answered.
            </AppText>
          ) : null}
        </Card>
      ) : null}

      <SectionHeader title="About the case" />
      <Card title="Your performance" subtitle="How well did you perform, overall?">
        <Slider
          label="Self-rated performance"
          value={performance}
          onChange={setPerformance}
          onClear={() => setPerformance(null)}
          unansweredText="Not rated"
          min={0}
          max={10}
          step={1}
          lowLabel="Very poor"
          highLabel="Excellent"
          formatValue={(v) => `${v} / 10`}
          testID="debrief-performance"
        />
      </Card>
      <Card title="Perceived stress" subtitle="How stressed did you feel during the case?">
        <Slider
          label="Perceived stress"
          value={perceivedStress}
          onChange={setPerceivedStress}
          onClear={() => setPerceivedStress(null)}
          unansweredText="Not rated"
          min={0}
          max={10}
          step={1}
          lowLabel="None"
          highLabel="Extreme"
          formatValue={(v) => `${v} / 10`}
          testID="debrief-stress"
        />
      </Card>
      <Card title="Last night’s sleep">
        <Slider
          label="Hours slept last night"
          value={sleepHours}
          onChange={setSleepHours}
          onClear={() => setSleepHours(null)}
          min={0}
          max={12}
          step={0.5}
          startValue={7}
          formatValue={(v) => `${v} h`}
          testID="debrief-sleep"
        />
      </Card>
      <Card title="Caffeine in the 2 hours before the case?">
        <SegmentedControl
          options={[
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]}
          value={caffeine == null ? null : caffeine ? 'yes' : 'no'}
          onChange={(v) => setCaffeine(v === 'yes')}
          accessibilityLabel="Caffeine in the two hours before the case"
        />
      </Card>
      <Card title="How did the case go?">
        <SegmentedControl
          options={OUTCOMES.map((o) => ({ value: o, label: OUTCOME_LABELS[o] }))}
          value={outcome}
          onChange={setOutcome}
          accessibilityLabel="Case outcome"
          wrap
        />
      </Card>
      <Card title="Notes (optional)">
        <Banner tone="warning" message="Never enter patient names, record numbers or other identifiers." live={false} />
        <TextField
          label="Anything you want to remember about this case"
          value={notes}
          onChangeText={setNotes}
          multiline
          maxLength={1000}
          hint="Notes stay on this device and are removed from exports by default."
        />
      </Card>
    </Screen>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    flex: { flex: 1 },
    row: { flexDirection: 'row', gap: t.space.sm, alignItems: 'center' },
    header: { gap: t.space.xs },
    dimCard: { gap: t.space.xs },
    scoreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    weighting: { borderRadius: t.radius.lg, overflow: 'hidden' },
    pair: { gap: t.space.xs },
  });
