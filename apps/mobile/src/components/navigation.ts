/**
 * Navigation helpers that keep the stack tidy around the recording flow, so
 * "back" never lands on a stale setup or baseline screen.
 */
import { router } from 'expo-router';

/** Clear setup/baseline from the stack and show the live screen above the tabs. */
export function openLiveScreen(): void {
  if (router.canDismiss()) router.dismissAll();
  router.push('/record/live');
}

/** Return to the tabs (Record home), dismissing any flow screens. */
export function goHome(): void {
  if (router.canDismiss()) router.dismissTo('/');
  else router.replace('/');
}
