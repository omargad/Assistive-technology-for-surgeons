/**
 * Launch-time prompt for sessions left in status 'recording' (the app was
 * killed or crashed mid-case). The surgeon can resume recording into the same
 * session, close it and go to the debrief, or decide later.
 */
import { useEffect, useState } from 'react';
import { router } from 'expo-router';

import type { SessionMeta } from '@/services/storage/types';
import { repository } from '@/services/storage';
import { useRecording } from '@/state/recording';
import { formatDateTime } from '@/theme';

import { Dialog } from './Dialog';
import { notify } from './ConfirmDialog';

export interface RecoveryPromptProps {
  /** Only check once onboarding is complete and stores are loaded. */
  enabled: boolean;
}

export function RecoveryPrompt({ enabled }: RecoveryPromptProps) {
  const [pending, setPending] = useState<SessionMeta | null>(null);
  const [others, setOthers] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    (async () => {
      // Only meaningful at launch, while no case is in progress in this process.
      if (useRecording.getState().stage !== 'idle') return;
      try {
        const found = await repository.findInterrupted();
        if (cancelled || found.length === 0) return;
        const newest = [...found].sort((a, b) => b.startedAt - a.startedAt);
        setPending(newest[0] ?? null);
        setOthers(newest.length - 1);
      } catch {
        // Storage not available — nothing to recover.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  if (!pending) return null;

  const act = async (fn: (id: string) => Promise<void>, href: '/record/setup' | '/record/debrief') => {
    setBusy(true);
    try {
      await fn(pending.id);
      setPending(null);
      router.push(href);
    } catch (e) {
      notify('Could not open the session', e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const message =
    `“${pending.procedure.name}”, started ${formatDateTime(pending.startedAt)}, was still recording when the app closed. ` +
    'The data captured up to that point is saved.' +
    (others > 0 ? ` (${others} more unfinished session${others === 1 ? '' : 's'} can be reviewed in History.)` : '');

  return (
    <Dialog
      visible
      title="Unfinished case found"
      message={message}
      testID="recovery-prompt"
      actions={[
        {
          label: 'Resume recording',
          variant: 'primary',
          disabled: busy,
          onPress: () => void act((id) => useRecording.getState().recoverInterrupted(id), '/record/setup'),
          testID: 'recovery-resume',
        },
        {
          label: 'End case & debrief',
          disabled: busy,
          onPress: () => void act((id) => useRecording.getState().finishInterrupted(id), '/record/debrief'),
          testID: 'recovery-finish',
        },
        { label: 'Decide later', variant: 'ghost', disabled: busy, onPress: () => setPending(null) },
      ]}
    />
  );
}
