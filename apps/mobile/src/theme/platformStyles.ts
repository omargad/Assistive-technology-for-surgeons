/**
 * Web-only style fragments. React Native's types only allow some CSS
 * properties on Text, but react-native-web applies them to any view; on
 * iOS/Android these resolve to empty objects.
 */
import { Platform, type ViewStyle } from 'react-native';

/**
 * Stop the browser from starting a text selection while the mouse drags or
 * long-presses a gesture surface (sliders, charts, hold-to-confirm buttons). A
 * stray selection turns later mouse drags into native drag-and-drop.
 */
export const noTextSelect: ViewStyle =
  Platform.OS === 'web' ? ({ userSelect: 'none' } as unknown as ViewStyle) : {};
