/**
 * Settings: profile, recording preferences, sensor, research enrolment &
 * upload, data (export / import / demo / delete), privacy & consent, about.
 */
import { useMemo, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
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
import { consentVersion, defaultResearchServerUrl } from '@/services/platform';
import { repository } from '@/services/storage';
import { checkEnrolment, uploadSessions, withdrawFromStudy } from '@/services/upload/research';
import { activeSessionId } from '@/state/activeSession';
import { CASE_IN_PROGRESS_ERROR, useSessions } from '@/state/sessions';
import { useSettings } from '@/state/settings';
import { formatDate, useStyles, type Theme } from '@/theme';

const BASELINE_OPTIONS = [1, 2, 3, 4, 5].map((m) => ({ value: m * 60, label: `${m} min`, accessibilityLabel: `${m} minute${m === 1 ? '' : 's'}` }));

/** Load full sessions; one that cannot be read is counted and left out instead of failing the whole batch. */
async function loadFullSessions(ids: readonly string[]): Promise<{ sessions: SurgicalSession[]; unreadable: number }> {
  const loaded = await Promise.allSettled(ids.map((id) => repository.getSession(id)));
  const sessions: SurgicalSession[] = [];
  let unreadable = 0;
  for (const r of loaded) {
    if (r.status === 'rejected') unreadable += 1;
    else if (r.value != null) sessions.push(r.value);
  }
  return { sessions, unreadable };
}

function unreadableNote(n: number): string {
  return n > 0 ? `\n\n${n} session${n === 1 ? '' : 's'} could not be read from storage and ${n === 1 ? 'was' : 'were'} left out.` : '';
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
      const { sessions, unreadable } = await loadFullSessions(notUploaded.map((i) => i.meta.id));
      if (sessions.length === 0) {
        if (unreadable > 0) notify('Nothing could be uploaded', unreadableNote(unreadable).trim());
        else show('Everything is already uploaded');
        return;
      }
      const res = await uploadSessions(sessions, { url: settings.researchServerUrl, token: settings.researchToken, profile });
      await useSessions.getState().refresh();
      const rejected = res.rejected.length;
      notify(
        rejected ? 'Upload finished with problems' : 'Upload complete',
        `${res.accepted.length} session${res.accepted.length === 1 ? '' : 's'} accepted` +
          (rejected ? `, ${rejected} rejected:\n${res.rejected.map((r) => `• ${r.reason}`).join('\n')}` : '.') +
          unreadableNote(unreadable),
      );
    });

  const exportAll = () =>
    guarded('export', 'Export failed', async () => {
      const { sessions, unreadable } = await loadFullSessions(items.map((i) => i.meta.id));
      if (sessions.length === 0) {
        notify('Nothing to export', unreadable > 0 ? unreadableNote(unreadable).trim() : 'There are no sessions on this device yet.');
        return;
      }
      if (unreadable > 0) notify('Some sessions were left out', unreadableNote(unreadable).trim());
      const res = await shareBundle(sessions, { deidentify: true, profile });
      if (res.skipped > 0) {
        notify(
          'Some sessions were left out',
          `${res.skipped} imported session${res.skipped === 1 ? ' has' : 's have'} a participant code that is not a study code, so ${res.skipped === 1 ? 'it' : 'they'} cannot be exported de-identified.`,
        );
      }
    });

  const exportCsv = () =>
    guarded('csv', 'Export failed', async () => {
      if (!completed.some((i) => i.summary != null)) {
        notify('Nothing to export', 'Complete a session first.');
        return;
      }
      const { skipped } = await shareSummariesCsv(completed);
      const left = [
        skipped.demo + skipped.simulated > 0 ? `${skipped.demo + skipped.simulated} demo or simulator session${skipped.demo + skipped.simulated === 1 ? '' : 's'}` : null,
        skipped.invalidCode > 0 ? `${skipped.invalidCode} with a participant code that is not a study code` : null,
      ].filter((x): x is string => x !== null);
      if (left.length > 0) notify('Some sessions were left out', `Not in the CSV: ${left.join('; ')}.`);
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

  /** Forget the study server address and enrolment token on this device. */
  const forgetServer = async () => {
    await update({ researchServerUrl: defaultResearchServerUrl(), researchToken: '', autoUpload: false });
    setServerUrl(defaultResearchServerUrl());
    setToken('');
  };

  const confirmForgetServer = async () => {
    const ok = await confirmAsync({
      title: 'Forget the study server?',
      message: 'The server address and enrolment token will be removed from this device. You will need the token from your research team to upload again.',
      confirmLabel: 'Forget',
      destructive: true,
    });
    if (ok) guarded('forget', 'Could not update settings', async () => {
      await forgetServer();
      show('Study server forgotten');
    });
  };

  const deleteAll = async () => {
    if (activeSessionId() != null) {
      notify('A case is in progress', CASE_IN_PROGRESS_ERROR);
      return;
    }
    const ok = await confirmAsync({
      title: 'Delete all data?',
      message:
        'Every session, your participant profile and consent record, and the study server settings (including the enrolment token) will be permanently deleted from this device, and setup starts again. Data already uploaded to the study server is not affected.',
      confirmLabel: 'Delete everything',
      destructive: true,
    });
    if (ok) guarded('delete', 'Could not delete', async () => {
      await useSessions.getState().deleteAll();
      await repository.deleteProfile();
      await forgetServer();
      await useSessions.getState().refresh();
      // Back to onboarding: there is no profile or consent any more.
      await update({ onboardingComplete: false });
    });
  };

  const withdraw = async () => {
    const ok = await confirmAsync({
      title: 'Withdraw consent?',
      message:
        'Nothing more will be uploaded, automatic upload is turned off and your withdrawal date is recorded. Sessions stay on this device until you delete them.',
      confirmLabel: 'Withdraw',
      destructive: true,
    });
    if (!ok || !profile) return;
    // Only offered when this device can reach the study server; otherwise the research team removes the data.
    const deleteOnServer =
      researchConfigured &&
      (await confirmAsync({
        title: 'Also delete your data on the study server?',
        message:
          'The study server will permanently delete every session it holds for you and stop accepting your enrolment token. This cannot be undone. Choose Cancel to keep the uploaded data (the research team can still remove it on request).',
        confirmLabel: 'Delete server data',
        destructive: true,
      }));
    guarded('withdraw', 'Could not update consent', async () => {
      await useSessions.getState().saveProfile({
        ...profile,
        consent: { version: profile.consent?.version ?? consentVersion, givenAt: profile.consent?.givenAt ?? Date.now(), withdrawnAt: Date.now() },
      });
      await update({ autoUpload: false });
      if (!deleteOnServer) {
        show('Consent withdrawn');
        return;
      }
      try {
        const res = await withdrawFromStudy({ url: settings.researchServerUrl, token: settings.researchToken });
        await forgetServer(); // the server has revoked the token
        notify(
          'Consent withdrawn',
          `The study server deleted ${res.deletedSessions} session${res.deletedSessions === 1 ? '' : 's'} and no longer accepts this device.`,
        );
      } catch (e) {
        notify(
          'Withdrawn on this device only',
          `Your withdrawal is recorded here and nothing more will be uploaded, but the study server could not be updated: ${errorMessage(e)}\n\nContact the research team to remove data already uploaded.`,
        );
      }
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
            subtitle={
              Platform.OS === 'android'
                ? 'While recording. Keep this on: Android pauses recording while the screen is off or the app is in the background'
                : 'While recording, so the live screen stays visible on its stand'
            }
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
          <SwitchRow
            icon="pulse-outline"
            title="Show heart rate on the live screen"
            subtitle={
              settings.showLiveHr
                ? 'The theatre team can see it. Turn off to record without showing it — phases and events still work'
                : 'Hidden: your heart rate is recorded but not shown during the case'
            }
            value={settings.showLiveHr}
            onValueChange={(v) => void update({ showLiveHr: v })}
            testID="settings-show-live-hr"
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
            hint="Issued by the research team. Kept in this device's secure storage (in the browser's storage on the web — use “Delete all data” before leaving a shared computer)."
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
          {settings.researchToken !== '' ? (
            <Button label="Forget server and token" variant="ghost" loading={busy === 'forget'} onPress={() => void confirmForgetServer()} />
          ) : null}
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
        <Card
          icon="shield-checkmark-outline"
          title={!consent ? 'No consent recorded' : consent.withdrawnAt ? 'Consent withdrawn' : 'Consent given'}
          testID="settings-consent"
        >
          <AppText variant="label" tone="muted">
            {consent
              ? `Form ${consent.version}, ${formatDate(consent.givenAt)}${consent.withdrawnAt ? ` · withdrawn ${formatDate(consent.withdrawnAt)}` : ''}.`
              : `No consent recorded (current form ${consentVersion}).`}
          </AppText>
          <AppText variant="label" tone="muted">
            Data stays on this device unless you export or upload it. On iPhone and iPad, sessions are included in
            your device backup (iCloud or computer) like other app data; Android cloud backups exclude them. Exports remove
            notes, typed procedure names and device identifiers, but keep dates and times. Never enter patient
            information anywhere in the app.
          </AppText>
          {consent && !consent.withdrawnAt ? (
            <Button label="Withdraw consent" variant="ghost" onPress={() => void withdraw()} />
          ) : null}
          {!consent ? (
            // e.g. the app was closed before the profile was saved: go through the consent steps again.
            <Button
              label="Review study information and consent"
              variant="primary"
              onPress={() => void update({ onboardingComplete: false })}
              testID="settings-give-consent"
            />
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
