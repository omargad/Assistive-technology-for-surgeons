/**
 * Onboarding: welcome → study information & consent → participant code →
 * optional profile. Short and friendly; consent is an explicit checkbox plus
 * "I agree". Completing it flips `settings.onboardingComplete`, which opens
 * the protected app routes.
 */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';

import { isValidParticipantCode } from '@surgeonpulse/core';

import { AppText } from '@/components/AppText';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { notify } from '@/components/ConfirmDialog';
import { Checkbox } from '@/components/Controls';
import { Icon, type IconName } from '@/components/Icon';
import { ProfileFields, type ProfileDetails } from '@/components/ProfileFields';
import { Screen } from '@/components/Screen';
import { TextField } from '@/components/TextField';
import { normaliseCode } from '@/components/forms';
import { errorMessage, useBusy } from '@/hooks/useBusy';
import { consentVersion } from '@/services/platform';
import { useSessions } from '@/state/sessions';
import { useSettings } from '@/state/settings';
import { useStyles, useTheme, type Theme } from '@/theme';

const STEPS = ['Welcome', 'Study information', 'Participant code', 'About you'] as const;

export default function OnboardingScreen() {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const [step, setStep] = useState(0);
  const [consented, setConsented] = useState(false);
  const [consentAt, setConsentAt] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const [details, setDetails] = useState<ProfileDetails>({});
  const [detailsValid, setDetailsValid] = useState(true);
  const { busy, run } = useBusy();

  const normalised = normaliseCode(code);
  const codeValid = isValidParticipantCode(normalised);

  const finish = (withDetails: boolean) =>
    run('finish', async () => {
      try {
        await useSessions.getState().saveProfile({
          code: normalised,
          ...(withDetails ? details : {}),
          consent: { version: consentVersion, givenAt: consentAt ?? Date.now() },
        });
        await useSettings.getState().update({ onboardingComplete: true });
        router.replace('/');
      } catch (e) {
        notify('Could not save your profile', errorMessage(e));
      }
    });

  const footer = (() => {
    switch (step) {
      case 0:
        return <Button label="Get started" variant="primary" size="lg" iconRight="arrow-forward" onPress={() => setStep(1)} />;
      case 1:
        return (
          <Button
            label="I agree"
            variant="primary"
            size="lg"
            disabled={!consented}
            accessibilityHint={consented ? undefined : 'Tick the consent box first'}
            onPress={() => {
              setConsentAt(Date.now());
              setStep(2);
            }}
            testID="onboarding-agree"
          />
        );
      case 2:
        return (
          <Button
            label="Continue"
            variant="primary"
            size="lg"
            disabled={!codeValid}
            onPress={() => setStep(3)}
            testID="onboarding-code-continue"
          />
        );
      default:
        return (
          <View style={styles.footerRow}>
            <Button label="Skip for now" variant="secondary" style={styles.flex} onPress={() => void finish(false)} disabled={!!busy} />
            <Button
              label="Finish"
              variant="primary"
              style={styles.flex}
              loading={busy === 'finish'}
              disabled={!detailsValid}
              onPress={() => void finish(true)}
              testID="onboarding-finish"
            />
          </View>
        );
    }
  })();

  return (
    <Screen edges={['top', 'bottom', 'left', 'right']} footer={footer} testID="onboarding">
      <View style={styles.progressRow}>
        {step > 0 ? (
          <Button label="Back" size="sm" variant="ghost" icon="chevron-back" onPress={() => setStep(step - 1)} />
        ) : (
          <View />
        )}
        <AppText variant="label" tone="muted" accessibilityLabel={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}>
          Step {step + 1} of {STEPS.length}
        </AppText>
      </View>
      <View style={styles.dots} aria-hidden>
        {STEPS.map((s, i) => (
          <View key={s} style={[styles.dot, { backgroundColor: i <= step ? theme.colors.primary : theme.colors.border }]} />
        ))}
      </View>

      {step === 0 ? (
        <View style={styles.section}>
          <View style={styles.hero}>
            <View style={styles.logo}>
              <Icon name="pulse" size={40} color={theme.colors.onPrimary} />
            </View>
            <AppText variant="display" align="center">
              SurgeonPulse
            </AppText>
            <AppText variant="body" tone="muted" align="center" style={styles.lead}>
              Capture your heart rate during cases, mark what happens, and reflect on how operating feels — for you and
              for research.
            </AppText>
          </View>
          <Feature icon="heart-outline" title="Record" text="Connect a chest strap (or use the simulator) and record hands-free during the case." />
          <Feature icon="flag-outline" title="Mark the case" text="You or the team tap big buttons for phases and events. Times can be corrected later." />
          <Feature icon="clipboard-outline" title="Debrief" text="A 1–2 minute SURG-TLX workload questionnaire after each case." />
          <Feature icon="analytics-outline" title="Reflect" text="See your heart rate by phase and trends over time. Nothing is judged." />
          <Banner
            tone="info"
            title="Research tool — not a medical device"
            message="SurgeonPulse does not diagnose anything and does not monitor patient safety."
            live={false}
          />
        </View>
      ) : null}

      {step === 1 ? (
        <View style={styles.section}>
          <AppText variant="title">Study information</AppText>
          <Card icon="document-text-outline" title="What is recorded">
            <Bullet text="Your heart rate and beat-to-beat intervals from your own sensor." />
            <Bullet text="Operative phases and events you or your team mark, with times." />
            <Bullet text="Your post-operative workload questionnaire answers." />
            <Bullet text="The type of procedure (from a catalogue) — never patient details." />
          </Card>
          <Card icon="shield-checkmark-outline" title="How it is protected">
            <Bullet text="You are identified only by a study code given by the research team." />
            <Bullet text="Data stays on this device until you export it or upload it to the study server." />
            <Bullet text="Exports are de-identified by default (free-text notes and device ids removed)." />
            <Bullet text="Taking part is voluntary. You can stop at any time and delete your data." />
          </Card>
          <Checkbox
            checked={consented}
            onChange={setConsented}
            accessibilityLabel="I have read the participant information and consent to take part"
            label="I have read the participant information and consent to take part in this study."
            testID="onboarding-consent"
          />
          <AppText variant="caption" tone="faint">
            Consent form version {consentVersion}
          </AppText>
        </View>
      ) : null}

      {step === 2 ? (
        <View style={styles.section}>
          <AppText variant="title">Your participant code</AppText>
          <AppText variant="body" tone="muted">
            Sessions are labelled with this code instead of your name.
          </AppText>
          <TextField
            label="Participant code"
            value={code}
            onChangeText={(v) => {
              setCode(v);
              setCodeTouched(true);
            }}
            onBlur={() => setCodeTouched(true)}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            maxLength={32}
            placeholder="SP-014"
            hint="Use the code from your research team, e.g. SP-014. Do not use your name."
            error={codeTouched && code.trim() !== '' && !codeValid ? 'Use 2–32 letters, numbers, - or _ (not an email address or your name).' : null}
            testID="onboarding-code"
          />
        </View>
      ) : null}

      {step === 3 ? (
        <View style={styles.section}>
          <AppText variant="title">About you (optional)</AppText>
          <AppText variant="body" tone="muted">
            These help interpret your data, for example age-predicted heart-rate zones. You can change them later in
            Settings.
          </AppText>
          <ProfileFields
            initial={details}
            onChange={(d, valid) => {
              setDetails(d);
              setDetailsValid(valid);
            }}
          />
        </View>
      ) : null}
    </Screen>
  );
}

function Feature({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.feature} accessible accessibilityLabel={`${title}. ${text}`}>
      <View style={styles.featureIcon}>
        <Icon name={icon} size={22} color={theme.colors.primary} />
      </View>
      <View style={styles.flex}>
        <AppText variant="bodyStrong">{title}</AppText>
        <AppText variant="label" tone="muted">
          {text}
        </AppText>
      </View>
    </View>
  );
}

function Bullet({ text }: { text: string }) {
  const styles = useStyles(makeStyles);
  const theme = useTheme();
  return (
    <View style={styles.bullet}>
      <Icon name="checkmark" size={16} color={theme.colors.success} />
      <AppText variant="label" style={styles.flex}>
        {text}
      </AppText>
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    flex: { flex: 1 },
    progressRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 36 },
    dots: { flexDirection: 'row', gap: t.space.xs },
    dot: { flex: 1, height: 4, borderRadius: 2 },
    section: { gap: t.space.lg },
    hero: { alignItems: 'center', gap: t.space.md, paddingVertical: t.space.lg },
    logo: {
      width: 80,
      height: 80,
      borderRadius: 24,
      backgroundColor: t.colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    lead: { maxWidth: 480 },
    feature: { flexDirection: 'row', gap: t.space.md, alignItems: 'flex-start' },
    featureIcon: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: t.colors.primarySoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    bullet: { flexDirection: 'row', gap: t.space.sm, alignItems: 'flex-start' },
    footerRow: { flexDirection: 'row', gap: t.space.sm },
  });
