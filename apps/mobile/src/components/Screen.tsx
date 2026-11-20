/**
 * Screen container: background, safe-area padding for the requested edges,
 * optional scrolling, a sticky footer for the primary action, and a centred
 * max-width column so tablets and the web build look intentional.
 */
import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useStyles, useTheme, type Theme } from '@/theme';

export type ScreenEdge = 'top' | 'bottom' | 'left' | 'right';

export interface ScreenProps {
  children: ReactNode;
  /** Wrap content in a ScrollView (default true). */
  scroll?: boolean;
  /** Apply the standard horizontal/vertical padding (default true). */
  padded?: boolean;
  /** Safe-area edges to pad. Headers and tab bars already handle their own edges. */
  edges?: readonly ScreenEdge[];
  /** Sticky bottom area (primary action). */
  footer?: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Max content width; `null` disables centring. Default from theme (720). */
  maxWidth?: number | null;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Screen({
  children,
  scroll = true,
  padded = true,
  edges = ['left', 'right'],
  footer,
  refreshing,
  onRefresh,
  maxWidth,
  contentStyle,
  testID,
}: ScreenProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const has = (e: ScreenEdge) => edges.includes(e);
  const width = maxWidth === undefined ? theme.layout.maxContentWidth : maxWidth;

  const edgePadding: ViewStyle = {
    paddingTop: has('top') ? insets.top : 0,
    paddingLeft: has('left') ? insets.left : 0,
    paddingRight: has('right') ? insets.right : 0,
  };
  const bottomInset = has('bottom') ? insets.bottom : 0;

  const column = (
    <View
      style={[
        styles.column,
        width != null ? { maxWidth: width } : null,
        padded ? styles.padded : null,
        !scroll ? styles.fill : null,
        !footer && scroll ? { paddingBottom: (padded ? theme.space.xxl : 0) + bottomInset } : null,
        contentStyle,
      ]}
    >
      {children}
    </View>
  );

  const body = scroll ? (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshControl={
        onRefresh ? (
          <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />
        ) : undefined
      }
    >
      {column}
    </ScrollView>
  ) : (
    column
  );

  return (
    <KeyboardAvoidingView
      style={[styles.root, edgePadding]}
      // Android (SDK 58) is always edge-to-edge, so the window no longer resizes for the keyboard;
      // KeyboardAvoidingView pads by the measured overlap (0 if the OS already resized). Web: the browser handles it.
      behavior={Platform.OS === 'web' ? undefined : 'padding'}
      testID={testID}
    >
      {body}
      {footer ? (
        <View style={[styles.footer, { paddingBottom: theme.space.md + bottomInset }]}>
          <View style={[styles.footerInner, width != null ? { maxWidth: width } : null]}>{footer}</View>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.colors.bg },
    fill: { flex: 1 },
    scrollContent: { flexGrow: 1 },
    column: { width: '100%', alignSelf: 'center' },
    padded: { paddingHorizontal: t.space.lg, paddingTop: t.space.lg, gap: t.space.lg },
    footer: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.colors.border,
      backgroundColor: t.colors.surface,
      paddingTop: t.space.md,
      paddingHorizontal: t.space.lg,
    },
    footerInner: { width: '100%', alignSelf: 'center', gap: t.space.sm },
  });
