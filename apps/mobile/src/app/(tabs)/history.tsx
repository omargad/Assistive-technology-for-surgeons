/**
 * Session history: searchable by procedure, filterable by specialty, with
 * summary chips per session. Pull to refresh.
 */
import { useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { notify } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SessionRow } from '@/components/SessionRow';
import { TextField } from '@/components/TextField';
import { errorMessage, useBusy } from '@/hooks/useBusy';
import type { SessionListItem } from '@/services/storage/types';
import { useRecording } from '@/state/recording';
import { useSessions } from '@/state/sessions';
import { useStyles, useTheme, type Theme } from '@/theme';

export default function HistoryScreen() {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const items = useSessions((s) => s.items);
  const loading = useSessions((s) => s.loading);
  const [query, setQuery] = useState('');
  const [specialty, setSpecialty] = useState<string | null>(null);
  const { busy, run } = useBusy();

  const specialties = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) if (i.meta.procedure.specialty) set.add(i.meta.procedure.specialty);
    return [...set].sort();
  }, [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (i) =>
        (!specialty || i.meta.procedure.specialty === specialty) &&
        (!q || i.meta.procedure.name.toLowerCase().includes(q) || (i.meta.procedure.specialty ?? '').toLowerCase().includes(q)),
    );
  }, [items, query, specialty]);

  const loadDemo = () =>
    run('demo', async () => {
      try {
        await useSessions.getState().loadDemoData();
      } catch (e) {
        notify('Could not load demo data', errorMessage(e));
      }
    });

  const header = (
    <View style={styles.header}>
      <TextField
        label="Search"
        value={query}
        onChangeText={setQuery}
        placeholder="Procedure or specialty"
        autoCorrect={false}
        autoCapitalize="none"
        clearButtonMode="while-editing"
        returnKeyType="search"
        testID="history-search"
      />
      {specialties.length > 1 ? (
        <View style={styles.chips} accessibilityLabel="Filter by specialty">
          <Chip label="All" selected={specialty == null} onPress={() => setSpecialty(null)} />
          {specialties.map((s) => (
            <Chip key={s} label={s} selected={specialty === s} onPress={() => setSpecialty(specialty === s ? null : s)} />
          ))}
        </View>
      ) : null}
      {items.length > 0 ? (
        <AppText variant="caption" tone="muted" accessibilityLiveRegion="polite">
          {filtered.length === items.length ? `${items.length} sessions` : `${filtered.length} of ${items.length} sessions`}
        </AppText>
      ) : null}
    </View>
  );

  const renderItem = ({ item }: { item: SessionListItem }) => (
    <SessionRow item={item} onPress={() => router.push(`/session/${item.meta.id}`)} testID={`session-row-${item.meta.id}`} />
  );

  return (
    <FlatList
      style={{ backgroundColor: theme.colors.bg }}
      contentContainerStyle={styles.content}
      data={filtered}
      keyExtractor={(i) => i.meta.id}
      renderItem={renderItem}
      ItemSeparatorComponent={Separator}
      ListHeaderComponent={header}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={() => void useSessions.getState().refresh()} tintColor={theme.colors.primary} />
      }
      ListEmptyComponent={
        items.length === 0 ? (
          <EmptyState
            icon="time-outline"
            title="No sessions yet"
            message="Recorded cases appear here. You can also load simulated demo sessions to explore the app."
          >
            <Button
              label="Start a case"
              variant="primary"
              icon="add-circle-outline"
              onPress={() => {
                useRecording.getState().beginSetup();
                router.push('/record/setup');
              }}
            />
            <Button label="Load demo data" icon="sparkles-outline" loading={busy === 'demo'} onPress={() => void loadDemo()} />
          </EmptyState>
        ) : (
          <EmptyState icon="search" title="No matching sessions" message="Try a different search or clear the filter." />
        )
      }
      testID="history-list"
    />
  );
}

function Separator() {
  return <View style={{ height: 10 }} />;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    content: {
      padding: t.space.lg,
      paddingBottom: t.space.xxxl,
      width: '100%',
      maxWidth: t.layout.maxContentWidth,
      alignSelf: 'center',
    },
    header: { gap: t.space.md, marginBottom: t.space.md },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm },
  });
