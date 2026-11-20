/**
 * Optional participant-profile fields (training level, specialty, experience,
 * birth year, resting / max HR) shared by onboarding and Settings. Holds the
 * typed text, validates it, and reports the parsed values upward.
 */
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PROCEDURE_CATALOG, TRAINING_LEVEL_LABELS } from '@surgeonpulse/core';
import type { ParticipantProfile, TrainingLevel } from '@surgeonpulse/core';

import { useLatest } from '@/hooks/useLatest';
import { useStyles, type Theme } from '@/theme';

import { AppText } from './AppText';
import { Chip } from './Chip';
import { TextField } from './TextField';
import { numberText, parseOptionalInt, type ParsedNumber } from './forms';

export type ProfileDetails = Pick<
  ParticipantProfile,
  'trainingLevel' | 'specialty' | 'yearsExperience' | 'birthYear' | 'restingHr' | 'maxHr'
>;

export interface ProfileFieldsProps {
  initial: ProfileDetails;
  /** Called whenever a field changes, with the parsed values and whether every field is valid. */
  onChange: (details: ProfileDetails, valid: boolean) => void;
  /** Show the measured max-HR override (Settings only). */
  showMaxHr?: boolean;
}

interface FormText {
  trainingLevel?: TrainingLevel;
  specialty?: string;
  years: string;
  birthYear: string;
  restingHr: string;
  maxHr: string;
}

const TRAINING_LEVELS = Object.keys(TRAINING_LEVEL_LABELS) as TrainingLevel[];

function parseForm(form: FormText, thisYear: number) {
  const fields = {
    years: parseOptionalInt(form.years, 0, 60, 'Years of experience'),
    birthYear: parseOptionalInt(form.birthYear, thisYear - 90, thisYear - 16, 'Birth year'),
    restingHr: parseOptionalInt(form.restingHr, 30, 120, 'Resting heart rate'),
    maxHr: parseOptionalInt(form.maxHr, 100, 230, 'Maximum heart rate'),
  };
  const value = (p: ParsedNumber) => (p.ok ? p.value : undefined);
  const details: ProfileDetails = {
    trainingLevel: form.trainingLevel,
    specialty: form.specialty,
    yearsExperience: value(fields.years),
    birthYear: value(fields.birthYear),
    restingHr: value(fields.restingHr),
    maxHr: value(fields.maxHr),
  };
  const valid = Object.values(fields).every((p) => p.ok);
  const error = (p: ParsedNumber) => (p.ok ? null : p.error);
  return {
    details,
    valid,
    errors: {
      years: error(fields.years),
      birthYear: error(fields.birthYear),
      restingHr: error(fields.restingHr),
      maxHr: error(fields.maxHr),
    },
  };
}

export function ProfileFields({ initial, onChange, showMaxHr }: ProfileFieldsProps) {
  const styles = useStyles(makeStyles);
  const thisYear = new Date().getFullYear();
  const specialties = useMemo(() => [...new Set(PROCEDURE_CATALOG.map((p) => p.specialty))], []);
  const [form, setForm] = useState<FormText>(() => ({
    trainingLevel: initial.trainingLevel,
    specialty: initial.specialty,
    years: numberText(initial.yearsExperience),
    birthYear: numberText(initial.birthYear),
    restingHr: numberText(initial.restingHr),
    maxHr: numberText(initial.maxHr),
  }));
  const parsed = useMemo(() => parseForm(form, thisYear), [form, thisYear]);
  const onChangeRef = useLatest(onChange);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (touched) onChangeRef.current(parsed.details, parsed.valid);
  }, [parsed, touched, onChangeRef]);

  const set = (patch: Partial<FormText>) => {
    setTouched(true);
    setForm((f) => ({ ...f, ...patch }));
  };

  return (
    <View style={styles.root}>
      <View style={styles.group}>
        <AppText variant="label" tone="muted">
          Training level
        </AppText>
        <View style={styles.chips}>
          {TRAINING_LEVELS.map((lvl) => (
            <Chip
              key={lvl}
              label={TRAINING_LEVEL_LABELS[lvl]}
              selected={form.trainingLevel === lvl}
              onPress={() => set({ trainingLevel: form.trainingLevel === lvl ? undefined : lvl })}
            />
          ))}
        </View>
      </View>
      <View style={styles.group}>
        <AppText variant="label" tone="muted">
          Specialty
        </AppText>
        <View style={styles.chips}>
          {specialties.map((s) => (
            <Chip
              key={s}
              label={s}
              selected={form.specialty === s}
              onPress={() => set({ specialty: form.specialty === s ? undefined : s })}
            />
          ))}
        </View>
      </View>
      <View style={styles.row}>
        <TextField
          style={styles.cell}
          label="Years of surgical experience"
          value={form.years}
          onChangeText={(years) => set({ years })}
          keyboardType="number-pad"
          maxLength={2}
          error={parsed.errors.years}
        />
        <TextField
          style={styles.cell}
          label="Birth year"
          value={form.birthYear}
          onChangeText={(birthYear) => set({ birthYear })}
          keyboardType="number-pad"
          maxLength={4}
          hint="Year only — used for age-predicted max HR"
          error={parsed.errors.birthYear}
        />
      </View>
      <View style={styles.row}>
        <TextField
          style={styles.cell}
          label="Typical resting HR (bpm)"
          value={form.restingHr}
          onChangeText={(restingHr) => set({ restingHr })}
          keyboardType="number-pad"
          maxLength={3}
          hint="Used when no baseline is recorded"
          error={parsed.errors.restingHr}
        />
        {showMaxHr ? (
          <TextField
            style={styles.cell}
            label="Measured max HR (bpm)"
            value={form.maxHr}
            onChangeText={(maxHr) => set({ maxHr })}
            keyboardType="number-pad"
            maxLength={3}
            hint="Optional, e.g. from an exercise test"
            error={parsed.errors.maxHr}
          />
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    root: { gap: t.space.lg },
    group: { gap: t.space.sm },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.md },
    cell: { flexGrow: 1, flexBasis: 200 },
  });
