/**
 * Heart-rate zone colouring. Zone *definitions* come from `@surgeonpulse/core`
 * (`zonesFromBaseline` / `zonesFromMaxHr`); this module only maps a zone's
 * position onto the theme's calm → very-high colour ramp.
 */
import { zonesFromBaseline, zonesFromMaxHr } from '@surgeonpulse/core';
import type { ZoneDefinition } from '@surgeonpulse/core';

import type { Theme } from './ThemeProvider';

/** Colour for zone `index` of `count` zones (spread evenly over the 5-step ramp). */
export function zoneColor(theme: Theme, index: number, count: number): string {
  const ramp = theme.colors.zoneRamp;
  if (count <= 1) return ramp[0];
  const pos = Math.round((Math.max(0, Math.min(index, count - 1)) * (ramp.length - 1)) / (count - 1));
  return ramp[pos] ?? ramp[0];
}

/**
 * Zones used to colour the live heart rate: relative to the resting baseline
 * when known, else % of max HR, else none.
 */
export function zonesFor(baselineHr: number | null | undefined, maxHr: number | null | undefined): ZoneDefinition[] {
  if (typeof baselineHr === 'number' && Number.isFinite(baselineHr)) return zonesFromBaseline(baselineHr);
  if (typeof maxHr === 'number' && Number.isFinite(maxHr) && maxHr > 0) return zonesFromMaxHr(maxHr);
  return [];
}

/** Index of the zone containing `bpm` (`minBpm ≤ bpm < maxBpm`), or −1. */
export function zoneIndexForBpm(zones: readonly ZoneDefinition[], bpm: number): number {
  return zones.findIndex((z) => bpm >= z.minBpm && bpm < z.maxBpm);
}

/** Text colour for a heart-rate value; neutral text colour when no zones apply. */
export function colorForBpm(theme: Theme, zones: readonly ZoneDefinition[], bpm: number | null | undefined): string {
  if (typeof bpm !== 'number' || zones.length === 0) return theme.colors.text;
  const i = zoneIndexForBpm(zones, bpm);
  return i < 0 ? theme.colors.text : zoneColor(theme, i, zones.length);
}
