/**
 * Settings: profile, recording preferences, sensor, research enrolment &
 * upload, data (export / import / demo / delete), privacy & consent, about.
 */
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';

import { SENSOR_SOURCE_LABELS, isValidParticipantCode } from '@surgeonpulse/core';
import type { SurgicalSession } from '@surgeonpulse/core';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { confirmAsync, notify } from '@/components/ConfirmDialog';
import { SectionHeader, SwitchRow } from '@/components/Controls';
import { ListGroup, ListRow } from '@/components/ListRow';
import { ProfileFields, type ProfileDetails } from '@/components/ProfileFields';
import { Screen } from '@/components/Screen';
import { SegmentedControl } from '@/components/SegmentedControl';
import { TextField } from '@/components/TextField';
import { Toast } from '@/components/Toast';
import { normaliseCode } from '@/components/forms';
import { errorMessage, useBusy } from '@/hooks/useBusy';
import { useToast } from '@/hooks/useToast';
import { pickImportFile, shareBundle, shareSummariesCsv } from '@/services/export/share';
import { consentVersion } from '@/services/platform';
import { repository } from '@/services/storage';
import { checkEnrolment, uploadSessions } from '@/services/upload/research';
import { useSessions } from '@/state/sessions';
import { useSettings } from '@/state/settings';
import { formatDate, useStyles, type Theme } from '@/theme';

const BASELINE_OPTIONS = [1, 2, 3, 4, 5].map((m) => ({ value: m * 60, label: `${m} min`, accessibilityLabel: `${m} minute${m === 1 ? '' : 's'}` }));

async function loadFullSessions(ids: readonly string[]): Promise<SurgicalSession[]> {
  const loaded = await Promise.all(ids.map((id) => repository.getSession(id)));
  return loaded.filter((s): s is SurgicalSession => s != null);
}

export default function SettingsScreen() {
  const styles = useStyles(makeStyles);
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const profile = useSessions((s) => s.profile);
  const items = useSessions((s) => s.items);
  const { busy, run } = useBusy();
  const { toast, show, hide } = useToast();

  // Research form
  const [serverUrl, setServerUrl] = useState(settings.researchServerUrl);
  const [token, setToken] = useState(settings.researchToken);
  const researchDirty = serverUrl.trim() !== settings.researchServerUrl || token.trim() !== settings.researchToken;
  const researchConfigured = settings.researchServerUrl.trim() !== '' && settings.researchToken.trim() !== '';

  const completed = useMemo(() => items.filter((i) => i.meta.status === 'completed'), [items]);
  const notUploaded = useMemo(
    () => completed.filter((i) => !(i.meta.tags ?? []).some((t) => t.startsWith('uploaded:'))),
    [completed],
  );

  const guarded = (key: string, title: string, fn: () => Promise<void>) =>
    void run(key, async () => {
      try {
        await fn();
      } catch (e) {
        notify(title, errorMessage(e));
      }
    });

  const saveResearch = () =>
    guarded('research', 'Could not save', async () => {
      await update({ researchServerUrl: serverUrl.trim(), researchToken: token.trim() });
      show('Research settings saved');
    });

  const verifyEnrolment = () =>
    guarded('enrol', 'Enrolment check failed', async () => {
      const res = await checkEnrolment({ url: settings.researchServerUrl, token: settings.researchToken });
      notify(
        'Enrolment confirmed',
        `The study server knows this device as ${res.participantCode} and holds ${res.sessionCount} session${res.sessionCount === 1 ? '' : 's'}.` +
          (profile?.code && profile.code !== res.participantCode ? `\n\nNote: your profile code is ${profile.code}.` : ''),
      );
    });

  const uploadNow = () =>
    guarded('upload', 'Upload failed', async () => {
      const sessions = await loadFullSessions(notUploaded.map((i) => i.meta.id));
      if (sessions.length === 0) {
        show('Everything is already uploaded');
        return;
      }
      const res = await uploadSessions(sessions, { url: settings.researchServerUrl, token: settings.researchToken, profile });
      await useSessions.getState().refresh();
      const rejected = res.rejected.length;
      notify(
        rejected ? 'Upload finished with problems' : 'Upload complete',
        `${res.accepted.length} session${res.accepted.length === 1 ? '' : 's'} accepted` +
          (rejected ? `, ${rejected} rejected:\n${res.rejected.map((r) => `• ${r.reason}`).join('\n')}` : '.'),
      );
    });

  const exportAll = () =>
    guarded('export', 'Export failed', async () => {
      const sessions = await loadFullSessions(items.map((i) => i.meta.id));
      if (sessions.length === 0) {
        notify('Nothing to export', 'There are no sessions on this device yet.');
        return;
      }
      await shareBundle(sessions, { deidentify: true, profile });
    });

  const exportCsv = () =>
    guarded('csv', 'Export failed', async () => {
      const summaries = completed.map((i) => i.summary).filter((s): s is NonNullable<typeof s> => s != null);
      if (summaries.length === 0) {
        notify('Nothing to export', 'Complete a session first.');
        return;
      }
      await shareSummariesCsv(summaries);
    });

  const importFile = () =>
    guarded('import', 'Import failed', async () => {
      const text = await pickImportFile();
      if (text == null) return;
      const res = await useSessions.getState().importBundle(text);
      notify(
        `Imported ${res.imported} session${res.imported === 1 ? '' : 's'}`,
        res.warnings.length ? `Some items were skipped:\n${res.warnings.slice(0, 5).join('\n')}` : undefined,
      );
    });

  const loadDemo = () =>
    guarded('demo', 'Could not load demo data', async () => {
      await useSessions.getState().loadDemoData();
      show('Demo sessions loaded (tagged “Demo”)');
    });

  const deleteAll = async () => {
    const ok = await confirmAsync({
      title: 'Delete all data?',
      message: 'Every session on this device will be permanently deleted. Data already uploaded to the study server is not affected.',
      confirmLabel: 'Delete everything',
      destructive: true,
    });
    if (ok) guarded('delete', 'Could not delete', async () => {
      await useSessions.getState().deleteAll();
      show('All sessions deleted');
    });
  };

  const withdraw = async () => {
    const ok = await confirmAsync({
      title: 'Withdraw consent?',
      message:
        'Automatic upload will be turned off and your withdrawal date recorded. Sessions stay on this device until you delete them. Contact the research team to remove data already uploaded.',
      confirmLabel: 'Withdraw',
      destructive: true,
    });
    if (!ok || !profile) return;
    guarded('withdraw', 'Could not update consent', async () => {
      await useSessions.getState().saveProfile({
        ...profile,
        consent: { version: profile.consent?.version ?? consentVersion, givenAt: profile.consent?.givenAt ?? Date.now(), withdrawnAt: Date.now() },
      });
      await update({ autoUpload: false });
      show('Consent withdrawn');
    });
  };

  const consent = profile?.consent;

  return (
    <View style={styles.fill}>
      <Screen testID="settings">
        <SectionHeader title="Profile" />
        <ProfileSection key={profile?.code ?? 'no-profile'} onSaved={() => show('Profile saved')} />

        <SectionHeader title="Recording" />
        <Card>
          <AppText variant="bodyStrong">Resting baseline length</AppText>
          <SegmentedControl
            options={BASELINE_OPTIONS}
            value={settings.baselineDurationSec}
            onChange={(v) => void update({ baselineDurationSec: v })}
            accessibilityLabel="Resting baseline length"
            size="sm"
          />
          <AppText variant="caption" tone="faint">
            Sit or stand quietly before scrubbing. Three minutes is a good balance between accuracy and time.
          </AppText>
        </Card>
        <ListGroup>
          <SwitchRow
            icon="sunny-outline"
            title="Keep screen awake"
            subtitle="While recording, so the live screen stays visible on its stand"
            value={settings.keepAwake}
            onValueChange={(v) => void update({ keepAwake: v })}
          />
          <SwitchRow
            icon="phone-portrait-outline"
            title="Haptic feedback"
            subtitle="A short vibration confirms each tap on the live screen"
            value={settings.haptics}
            onValueChange={(v) => void update({ haptics: v })}
          />
          <SwitchRow
            icon="moon-outline"
            title="OR mode (dark live screen)"
            subtitle="Low-glare display for dark laparoscopic and robotic theatres"
            value={settings.orModeDark}
            onValueChange={(v) => void update({ orModeDark: v })}
          />
          <ListRow
            icon="bluetooth"
            title="Heart-rate sensor"
            value={
              settings.preferredSource
                ? settings.preferredDeviceName ?? SENSOR_SOURCE_LABELS[settings.preferredSource]
                : 'Not set'
            }
            onPress={() => router.push('/sensors')}
          />
        </ListGroup>

        <SectionHeader title="Research study" />
        <Card>
          <TextField
            label="Study server URL"
            value={serverUrl}
            onChangeText={setServerUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://study.example.org"
          />
          <TextField
            label="Enrolment token"
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            hint="Issued by the research team. Stored only on this device."
          />
          <View style={styles.buttonRow}>
            <Button label="Save" variant="primary" disabled={!researchDirty} loading={busy === 'research'} onPress={saveResearch} style={styles.grow} />
            <Button
              label="Check enrolment"
              disabled={!researchConfigured || researchDirty}
              loading={busy === 'enrol'}
              onPress={verifyEnrolment}
              style={styles.grow}
            />
          </View>
        </Card>
        <ListGroup>
          <SwitchRow
            icon="cloud-upload-outline"
            title="Upload automatically"
            subtitle="Send each completed, de-identified session after the debrief"
            value={settings.autoUpload}
            disabled={!researchConfigured || !!consent?.withdrawnAt}
            onValueChange={(v) => void update({ autoUpload: v })}
          />
          <ListRow
            icon="cloud-upload-outline"
            title="Upload sessions now"
            subtitle={
              researchConfigured
                ? `${notUploaded.length} completed session${notUploaded.length === 1 ? '' : 's'} not yet uploaded`
                : 'Add the server URL and token first'
            }
            disabled={!researchConfigured || busy != null || !!consent?.withdrawnAt}
            onPress={uploadNow}
          />
        </ListGroup>

        <SectionHeader title="Data" />
        <ListGroup>
          <ListRow
            icon="share-outline"
            title="Export all sessions (JSON)"
            subtitle="De-identified bundle for the research team"
            disabled={busy != null}
            onPress={exportAll}
          />
          <ListRow
            icon="grid-outline"
            title="Export summaries (CSV)"
            subtitle="One row per session for SPSS, R or Excel"
            disabled={busy != null}
            onPress={exportCsv}
          />
          <ListRow icon="download-outline" title="Import sessions" subtitle="From a SurgeonPulse JSON export" disabled={busy != null} onPress={importFile} />
          <ListRow icon="sparkles-outline" title="Load demo data" subtitle="Simulated sessions for training and demos" disabled={busy != null} onPress={loadDemo} />
          <ListRow icon="trash-outline" title="Delete all data" destructive disabled={busy != null} onPress={() => void deleteAll()} />
        </ListGroup>

        <SectionHeader title="Privacy & consent" />
        <Card icon="shield-checkmark-outline" title={consent?.withdrawnAt ? 'Consent withdrawn' : 'Consent given'}>
          <AppText variant="label" tone="muted">
            {consent
              ? `Form ${consent.version}, ${formatDate(consent.givenAt)}${consent.withdrawnAt ? ` · withdrawn ${formatDate(consent.withdrawnAt)}` : ''}.`
              : `No consent recorded (current form ${consentVersion}).`}
          </AppText>
          <AppText variant="label" tone="muted">
            Data stays on this device unless you export or upload it. Exports remove notes and device identifiers by
            default. Never enter patient information anywhere in the app.
          </AppText>
          {consent && !consent.withdrawnAt ? (
            <Button label="Withdraw consent" variant="ghost" onPress={() => void withdraw()} />
          ) : null}
        </Card>

        <ListGroup>
          <ListRow icon="information-circle-outline" title="About SurgeonPulse" subtitle="Disclaimer, data handling, licences" onPress={() => router.push('/about')} />
        </ListGroup>
      </Screen>
      <Toast visible={!!toast} message={toast?.message ?? ''} toastKey={toast?.key} onDismiss={hide} />
    </View>
  );
}

/** Participant code + optional profile fields. Re-mounted (via `key`) when the stored profile changes. */
function ProfileSection({ onSaved }: { onSaved: () => void }) {
  const profile = useSessions((s) => s.profile);
  const [code, setCode] = useState(profile?.code ?? '');
  const [details, setDetails] = useState<ProfileDetails | null>(null);
  const [detailsValid, setDetailsValid] = useState(true);
  const { busy, run } = useBusy();
  const normalisedCode = normaliseCode(code);
  const codeValid = isValidParticipantCode(normalisedCode);
  const dirty = details != null || normalisedCode !== (profile?.code ?? '');

  const save = () =>
    void run('profile', async () => {
      try {
        await useSessions.getState().saveProfile({ ...profile, ...details, code: normalisedCode });
        setDetails(null);
        onSaved();
      } catch (e) {
        notify('Could not save profile', errorMessage(e));
      }
    });

  return (
    <Card>
      <TextField
        label="Participant code"
        value={code}
        onChangeText={setCode}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={32}
        hint="The pseudonymous code from your research team. Never your name."
        error={code.trim() !== '' && !codeValid ? 'Use 2–32 letters, numbers, - or _.' : null}
      />
      <ProfileFields
        initial={profile ?? {}}
        showMaxHr
        onChange={(d, valid) => {
          setDetails(d);
          setDetailsValid(valid);
        }}
      />
      <Button
        label="Save profile"
        variant="primary"
        disabled={!dirty || !codeValid || !detailsValid}
        loading={busy === 'profile'}
        onPress={save}
      />
    </Card>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    fill: { flex: 1 },
    flex: { flex: 1 },
    /** Share spare room but start from the label's own width (a 0 basis wraps long labels). */
    grow: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto' },
    buttonRow: { flexDirection: 'row', gap: t.space.sm, flexWrap: 'wrap' },
  });
