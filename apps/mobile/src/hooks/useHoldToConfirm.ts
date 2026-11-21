import { useCallback, useEffect, useRef, useState } from 'react';

import { useLatest } from './useLatest';

export interface HoldToConfirm {
  /** 0–1 while the press is held. */
  progress: number;
  /** Spread onto a Pressable together with `delayLongPress`. */
  handlers: {
    onPressIn: (event?: PressLike) => void;
    onPressOut: () => void;
    onLongPress: () => void;
    delayLongPress: number;
  };
  /** Complete immediately (e.g. from an accessibility action). */
  confirm: () => void;
}

/** The part of a press event used here (react-native-web passes the DOM key event for keyboard presses). */
export interface PressLike {
  nativeEvent?: unknown;
}

/** True when a press was started from the keyboard (web: Enter/Space on a focused element). */
export function isKeyPress(event?: PressLike): boolean {
  const native = event?.nativeEvent as { key?: unknown } | undefined;
  return typeof native?.key === 'string' && native.key.length > 0;
}

/**
 * Press-and-hold confirmation for destructive live-screen actions ("End case").
 * Completion is driven by Pressable's `onLongPress` (`delayLongPress = durationMs`);
 * the progress value only animates the visual ring while the finger is down.
 * react-native-web never fires `onLongPress` for keys, so a hold started from the
 * keyboard (Space/Enter held down) completes when the ring fills instead.
 */
export function useHoldToConfirm(durationMs: number, onConfirm: () => void): HoldToConfirm {
  const [progress, setProgress] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef(0);
  const done = useRef(false);
  const viaKey = useRef(false);
  const confirmRef = useLatest(onConfirm);

  const stopTimer = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => stopTimer, [stopTimer]);

  const confirm = useCallback(() => {
    stopTimer();
    done.current = true;
    setProgress(1);
    confirmRef.current();
  }, [stopTimer, confirmRef]);

  const onPressIn = useCallback(
    (event?: PressLike) => {
      stopTimer();
      done.current = false;
      viaKey.current = isKeyPress(event);
      startedAt.current = Date.now();
      setProgress(0);
      timer.current = setInterval(() => {
        const p = Math.min(1, (Date.now() - startedAt.current) / durationMs);
        setProgress(p);
        if (p >= 1 && viaKey.current && !done.current) confirm();
      }, 40);
    },
    [durationMs, stopTimer, confirm],
  );

  const onPressOut = useCallback(() => {
    stopTimer();
    if (!done.current) setProgress(0);
  }, [stopTimer]);

  return { progress, handlers: { onPressIn, onPressOut, onLongPress: confirm, delayLongPress: durationMs }, confirm };
}
