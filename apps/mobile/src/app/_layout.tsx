/**
 * Root layout: providers (safe area, theme, navigation theme), store
 * bootstrap (settings + sessions), the onboarding gate (protected routes) and
 * the interrupted-session recovery prompt.
 */
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Stack, ThemeProvider as NavigationThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppText } from '@/components/AppText';
import { RecoveryPrompt } from '@/components/RecoveryPrompt';
import { useSessions } from '@/state/sessions';
import { useSettings } from '@/state/settings';
import { ThemeProvider, useTheme } from '@/theme';
import { navigationTheme } from '@/theme/navigation';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AppShell />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function AppShell() {
  const theme = useTheme();
  const loaded = useSettings((s) => s.loaded);
  const onboarded = useSettings((s) => s.settings.onboardingComplete);

  useEffect(() => {
    void useSettings.getState().load();
    void useSessions.getState().refresh();
  }, []);

  if (!loaded) {
    return (
      <View style={[styles.splash, { backgroundColor: theme.colors.bg }]} accessibilityLabel="Loading SurgeonPulse">
        <ActivityIndicator color={theme.colors.primary} size="large" />
        <AppText variant="label" tone="muted">
          SurgeonPulse
        </AppText>
      </View>
    );
  }

  return (
    <NavigationThemeProvider value={navigationTheme(theme)}>
      <StatusBar style={theme.isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.surface },
          headerTintColor: theme.colors.primary,
          headerTitleStyle: { color: theme.colors.text },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: theme.colors.bg },
          headerBackButtonDisplayMode: 'minimal',
        }}
      >
        <Stack.Protected guard={!onboarded}>
          <Stack.Screen name="onboarding" options={{ headerShown: false }} />
        </Stack.Protected>
        <Stack.Protected guard={onboarded}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Home' }} />
          <Stack.Screen name="record/setup" options={{ title: 'New case' }} />
          <Stack.Screen name="record/baseline" options={{ title: 'Resting baseline' }} />
          <Stack.Screen
            name="record/live"
            options={{ headerShown: false, gestureEnabled: false, animation: 'fade', title: 'Recording' }}
          />
          <Stack.Screen
            name="record/debrief"
            options={{ title: 'Post-op debrief', gestureEnabled: false, headerBackVisible: false, headerLeft: () => null }}
          />
          <Stack.Screen name="session/[id]" options={{ title: 'Session' }} />
          <Stack.Screen name="session/events/[id]" options={{ title: 'Edit events' }} />
          <Stack.Screen name="sensors" options={{ presentation: 'modal', title: 'Heart-rate sensor' }} />
          <Stack.Screen name="about" options={{ title: 'About SurgeonPulse' }} />
        </Stack.Protected>
      </Stack>
      <RecoveryPrompt enabled={onboarded} />
    </NavigationThemeProvider>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
});
