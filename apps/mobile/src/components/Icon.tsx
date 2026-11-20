import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';

import { useTheme } from '@/theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  testID?: string;
}

/** Decorative Ionicons glyph (hidden from assistive technology; label the parent instead). */
export function Icon({ name, size = 20, color, testID }: IconProps) {
  const theme = useTheme();
  return (
    <Ionicons
      name={name}
      size={size}
      color={color ?? theme.colors.text}
      accessible={false}
      aria-hidden
      testID={testID}
    />
  );
}
