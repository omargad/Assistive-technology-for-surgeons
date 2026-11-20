import { useCallback, useEffect, useRef, useState } from 'react';

import { useLatest } from './useLatest';

export interface HoldToConfirm {
  /** 0–1 while the press is held. */
  progress: number;
  /** Spread onto a Pressable together with `delayLongPress`. */
  handlers: {
    onPressIn: () => void;
    onPressOut: () => void;
    onLongPress: () => void;
    delayLongPress: number;
  };
  /** Complete immediately (e.g. from an accessibility action). */
  confirm: () => void;
}

/**
 * Press-and-hold confirmation for destructive live-screen actions ("End case").
 * Completion is driven by Pressable's `onLongPress` (`delayLongPress = durationMs`);
 * the progress value only animates the visual ring while the finger is down.
 */
export function useHoldToConfirm(durationMs: number, onConfirm: () => void): HoldToConfirm {
  const [progress, setProgress] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef(0);
  const done = useRef(false);
  const confirmRef = useLatest(onConfirm);

  const stopTimer = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => stopTimer, [stopTimer]);

  const onPressIn = useCallback(() => {
    stopTimer();
    done.current = false;
    startedAt.current = Date.now();
    setProgress(0);
    timer.current = setInterval(() => {
      setProgress(Math.min(1, (Date.now() - startedAt.current) / durationMs));
    }, 40);
  }, [durationMs, stopTimer]);

  const onPressOut = useCallback(() => {
    stopTimer();
    if (!done.current) setProgress(0);
  }, [stopTimer]);

  const confirm = useCallback(() => {
    stopTimer();
    done.current = true;
    setProgress(1);
    confirmRef.current();
  }, [stopTimer, confirmRef]);

  return { progress, handlers: { onPressIn, onPressOut, onLongPress: confirm, delayLongPress: durationMs }, confirm };
}
