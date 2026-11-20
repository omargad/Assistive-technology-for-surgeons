import { useWindowDimensions } from 'react-native';

export interface OrientationInfo {
  width: number;
  height: number;
  isLandscape: boolean;
  /** Short side ≥ 600 pt (tablets, desktop browsers). */
  isWide: boolean;
}

/** Window orientation & size class (updates on rotation / browser resize). */
export function useOrientation(): OrientationInfo {
  const { width, height } = useWindowDimensions();
  return { width, height, isLandscape: width > height, isWide: Math.min(width, height) >= 600 };
}
