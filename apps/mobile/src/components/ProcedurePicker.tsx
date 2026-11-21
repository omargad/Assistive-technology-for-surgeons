/**
 * Procedure chooser: searchable catalogue grouped by specialty, plus a custom
 * entry. Catalogue entries are preferred because they keep names consistent
 * for analysis and cannot leak patient details.
 */
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { APPROACH_LABELS, PROCEDURE_CATALOG, UNSPECIFIED_PROCEDURE_NAME } from '@surgeonpulse/core';
import type { ProcedureInfo } from '@surgeonpulse/core';

import { useStyles, useTheme, type Theme } from '@/theme';

import { AppText } from './AppText';
import { Banner } from './Banner';
import { Button } from './Button';
import { Chip } from './Chip';
import { Icon } from './Icon';
import { TextField } from './TextField';

export type ProcedureChoice = Pick<ProcedureInfo, 'name' | 'catalogId' | 'specialty' | 'approach'>;

export interface ProcedurePickerProps {
  value: ProcedureChoice | null;
  onChange: (value: ProcedureChoice) => void;
  testID?: string;
}

const MAX_RESULTS = 40;

/** Specialties in catalogue order. */
function specialtiesOf(): string[] {
  const seen = new Set<string>();
  for (const p of PROCEDURE_CATALOG) seen.add(p.specialty);
  return [...seen];
}

export function ProcedurePicker({ value, onChange, testID }: ProcedurePickerProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const [open, setOpen] = useState(value == null);
  const [query, setQuery] = useState('');
  const [specialty, setSpecialty] = useState<string | null>(value?.specialty ?? null);
  const [custom, setCustom] = useState('');
  const specialties = useMemo(specialtiesOf, []);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = PROCEDURE_CATALOG.filter((p) => {
      if (q) return p.name.toLowerCase().includes(q) || p.specialty.toLowerCase().includes(q);
      return specialty != null && p.specialty === specialty;
    }).slice(0, MAX_RESULTS);
    const bySpecialty = new Map<string, typeof matches>();
    for (const m of matches) {
      const list = bySpecialty.get(m.specialty) ?? [];
      list.push(m);
      bySpecialty.set(m.specialty, list);
    }
    return specialties.filter((s) => bySpecialty.has(s)).map((s) => ({ specialty: s, items: bySpecialty.get(s) ?? [] }));
  }, [query, specialty, specialties]);

  const choose = (choice: ProcedureChoice) => {
    onChange(choice);
    setOpen(false);
    setQuery('');
  };

  if (!open && value) {
    return (
      <View style={styles.selected} testID={testID}>
        <View style={styles.selectedText}>
          <AppText variant="bodyStrong">{value.name}</AppText>
          <AppText variant="label" tone="muted">
            {[value.specialty ?? (value.catalogId ? undefined : 'Custom procedure'), value.approach ? APPROACH_LABELS[value.approach] : undefined]
              .filter(Boolean)
              .join(' · ')}
          </AppText>
        </View>
        <Button label="Change" size="sm" variant="ghost" onPress={() => setOpen(true)} accessibilityLabel="Change procedure" />
      </View>
    );
  }

  const trimmedCustom = custom.trim();

  return (
    <View style={styles.root} testID={testID}>
      <TextField
        label="Search procedures"
        value={query}
        onChangeText={setQuery}
        placeholder="e.g. cholecystectomy"
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        clearButtonMode="while-editing"
        testID={testID ? `${testID}-search` : undefined}
      />
      {!query ? (
        <View style={styles.chips} accessibilityLabel="Filter by specialty">
          {specialties.map((s) => (
            <Chip key={s} label={s} selected={specialty === s} onPress={() => setSpecialty(specialty === s ? null : s)} />
          ))}
        </View>
      ) : null}

      {groups.length > 0 ? (
        <View style={styles.list}>
          {groups.map((g) => (
            <View key={g.specialty} style={styles.group}>
              <AppText variant="overline" tone="muted" accessibilityRole="header">
                {g.specialty}
              </AppText>
              {g.items.map((p) => {
                const isSelected = value?.catalogId === p.id;
                return (
                  <Pressable
                    key={p.id}
                    onPress={() =>
                      choose({ name: p.name, catalogId: p.id, specialty: p.specialty, approach: p.defaultApproach })
                    }
                    accessibilityRole="button"
                    accessibilityLabel={`${p.name}, ${p.specialty}`}
                    aria-selected={isSelected}
                    style={({ pressed }) => [styles.option, pressed ? styles.optionPressed : null]}
                  >
                    <View style={styles.optionText}>
                      <AppText variant="body">{p.name}</AppText>
                      {p.defaultApproach ? (
                        <AppText variant="caption" tone="faint">
                          Usually {APPROACH_LABELS[p.defaultApproach].toLowerCase()}
                        </AppText>
                      ) : null}
                    </View>
                    {isSelected ? <Icon name="checkmark" size={20} color={theme.colors.primary} /> : null}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      ) : query ? (
        <AppText variant="label" tone="muted">
          No catalogue match for “{query.trim()}”. You can enter a custom name below.
        </AppText>
      ) : (
        <AppText variant="label" tone="muted">
          Search, or pick a specialty to browse the catalogue.
        </AppText>
      )}

      <View style={styles.custom}>
        <AppText variant="subheading">Not listed?</AppText>
        <Banner
          tone="warning"
          message="Enter the type of procedure only. Never enter patient names, record numbers, dates of birth or other identifiers."
          live={false}
        />
        <AppText variant="caption" tone="muted" testID={testID ? `${testID}-custom-note` : undefined}>
          A custom name stays on this device. Research exports and uploads record it as “{UNSPECIFIED_PROCEDURE_NAME}”,
          keeping only the specialty, so choose the specialty above first.
        </AppText>
        <TextField
          label="Custom procedure name"
          value={custom}
          onChangeText={setCustom}
          placeholder="e.g. Revision hernia repair"
          maxLength={80}
          autoCapitalize="sentences"
          testID={testID ? `${testID}-custom` : undefined}
        />
        <Button
          label="Use custom name"
          icon="create-outline"
          disabled={trimmedCustom.length < 3}
          onPress={() => choose({ name: trimmedCustom, specialty: specialty ?? undefined })}
        />
      </View>
      {value ? <Button label="Cancel" variant="ghost" onPress={() => setOpen(false)} /> : null}
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    root: { gap: t.space.md },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm },
    list: { gap: t.space.md },
    group: { gap: t.space.xs },
    option: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.sm,
      minHeight: 48,
      paddingVertical: t.space.sm,
      paddingHorizontal: t.space.md,
      borderRadius: t.radius.md,
      backgroundColor: t.colors.surfaceAlt,
    },
    optionPressed: { backgroundColor: t.colors.border },
    optionText: { flex: 1, gap: 2 },
    custom: {
      gap: t.space.sm,
      paddingTop: t.space.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.colors.border,
    },
    selected: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.sm,
      padding: t.space.md,
      borderRadius: t.radius.md,
      backgroundColor: t.colors.primarySoft,
    },
    selectedText: { flex: 1, gap: 2 },
  });
