/** About: disclaimer, what data is handled and how, methods, licences. */
import { StyleSheet, View } from 'react-native';

import { PLATFORM_LABELS } from '@surgeonpulse/core';

import { AppText } from '@/components/AppText';
import { Banner } from '@/components/Banner';
import { Card } from '@/components/Card';
import { Icon, type IconName } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { appInfo, consentVersion } from '@/services/platform';
import { useStyles, useTheme, type Theme } from '@/theme';

const LIBRARIES = [
  'Expo, Expo Router and React Native (MIT)',
  'react-native-svg (MIT)',
  'react-native-ble-plx (Apache-2.0)',
  '@kingstinct/react-native-healthkit (MIT)',
  'react-native-health-connect (MIT)',
  'zustand (MIT)',
  'zod (MIT)',
  'Ionicons via @expo/vector-icons (MIT)',
];

export default function AboutScreen() {
  const styles = useStyles(makeStyles);
  const info = appInfo();
  return (
    <Screen edges={['left', 'right', 'bottom']} testID="about">
      <View style={styles.header}>
        <AppText variant="title">SurgeonPulse</AppText>
        <AppText variant="label" tone="muted">
          Version {info.version} · {PLATFORM_LABELS[info.platform]} · consent form {consentVersion}
        </AppText>
        <AppText variant="body" tone="muted">
          Assistive technology for surgeons: intra-operative heart-rate capture, workload debriefs and reflective feedback,
          developed as a university research project with surgeons and researchers.
        </AppText>
      </View>

      <Banner
        tone="warning"
        title="Research tool — not a medical device"
        message="SurgeonPulse does not diagnose, treat or prevent any condition, does not monitor patients, and does not raise safety alerts. Heart-rate values are for reflection and research only. If you feel unwell, seek medical advice."
        live={false}
      />

      <Card title="Your data" icon="shield-checkmark-outline">
        <Point icon="person-outline" text="You are identified only by a pseudonymous participant code. Never enter your name or any patient information." />
        <Point icon="phone-portrait-outline" text="Sessions are stored on this device (in the browser's local storage on the web) until you export, upload or delete them." />
        <Point icon="eye-off-outline" text="Exports and uploads are de-identified by default: free-text notes and sensor identifiers are removed and custom procedure names are replaced by the catalogue name where possible." />
        <Point icon="cloud-upload-outline" text="Uploads go only to the study server configured by your research team, using your enrolment token. Nothing is sent anywhere else, and there is no analytics or tracking." />
        <Point icon="trash-outline" text="You can delete individual sessions or all data at any time in Settings, and withdraw consent." />
      </Card>

      <Card title="What is measured" icon="pulse-outline">
        <Point icon="heart-outline" text="Heart rate and beat-to-beat (RR) intervals from a Bluetooth chest strap, or heart rate imported from Apple Health / Health Connect." />
        <Point icon="analytics-outline" text="Heart-rate variability (RMSSD, SDNN, pNN50) after artefact correction, following the Task Force of the ESC/NASPE (1996) definitions; the Baevsky stress index." />
        <Point icon="clipboard-outline" text="Workload with the SURG-TLX (Wilson et al., 2011), adapted from the NASA-TLX (Hart & Staveland, 1988)." />
        <Point icon="color-palette-outline" text="Phase colours use the Okabe–Ito palette, which stays distinguishable with common colour-vision differences; every colour is paired with a label." />
      </Card>

      <Card title="Open-source software" icon="code-slash-outline">
        {LIBRARIES.map((l) => (
          <AppText key={l} variant="label" tone="muted">
            • {l}
          </AppText>
        ))}
      </Card>

      <AppText variant="caption" tone="faint" align="center">
        Questions about the study or your data? Contact the research team listed on your participant information sheet.
      </AppText>
    </Screen>
  );
}

function Point({ icon, text }: { icon: IconName; text: string }) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.point}>
      <Icon name={icon} size={18} color={theme.colors.primary} />
      <AppText variant="label" style={styles.flex}>
        {text}
      </AppText>
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    header: { gap: t.space.xs },
    point: { flexDirection: 'row', gap: t.space.sm, alignItems: 'flex-start' },
    flex: { flex: 1 },
  });
