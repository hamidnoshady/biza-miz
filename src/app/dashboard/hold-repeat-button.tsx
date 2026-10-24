"use client";

/**
 * The ۲-second hold-to-repeat button — the add-on quantity gesture in the
 * modifier picker.
 *
 * Deliberately a *separate* primitive from HoldToConfirmButton (the ۴-second
 * payment hold): different durations, different semantics (repeat vs
 * one-shot), different failure modes. What they share — the clock, the
 * exactly-once discipline, the pointer/keyboard plumbing — lives in
 * src/lib/hold-timer.ts, and both read it through **one monotonic source**
 * (`timer.clock()`), which is the timing fix this component was rebuilt
 * around.
 *
 * Semantics here, as the till asks for them:
 *
 *  * a single short tap adds **nothing** — the gesture that changes an order
 *    is always a deliberate hold,
 *  * holding fires `onRepeat` once per `intervalMs`: ۲s → ۱، ۴s → ۲، ۶s → ۳،
 *    and on at the same cadence until release or the ceiling,
 *  * the fill restarts from empty after each increment, so the button is
 *    always showing the ramp toward the *next* unit,
 *  * two quick taps (within `doubleTapMs`) run `onDoubleTap` — the decrement.
 *
 * The tap and the hold are mutually exclusive by construction: the release
 * path checks whether the timer ever fired, not how long the press felt, so
 * there is no timing heuristic that could do both. A tap that completes a
 * double tap cancels the pending single-tap timeout, so a double tap can
 * never be read as two separate taps.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { HoldTimer, prefersReducedMotion } from "@/lib/hold-timer";
import { HAPTIC, vibrate } from "@/lib/haptics";

export function HoldRepeatButton({
  intervalMs = 2000,
  onPress,
  onRepeat,
  onDoubleTap,
  doubleTapMs = 320,
  doubleTapEnabled = true,
  disabled = false,
  className = "",
  children,
  ariaLabel,
  ariaPressed,
}: {
  intervalMs?: number;
  /**
   * A single short tap that was *not* part of a double tap. Optional: the
   * add-on picker leaves it out, because a tap must not change a quantity.
   */
  onPress?: () => void;
  /** Runs once per full interval while held — one more unit each time. */
  onRepeat: () => void;
  /** Two quick taps — the decrement. */
  onDoubleTap?: () => void;
  /** How close two taps must be to count as a double tap. */
  doubleTapMs?: number;
  /** When false, two taps never decrement; explicit decrement buttons remain available. */
  doubleTapEnabled?: boolean;
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
  ariaLabel?: string;
  ariaPressed?: boolean;
}) {
  const timerRef = useRef<HoldTimer | null>(null);
  const frameRef = useRef<number | null>(null);
  const pointerRef = useRef<number | null>(null);
  /** A tap waiting to see whether a second one turns it into a double tap. */
  const tapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [progress, setProgress] = useState(0);
  const [held, setHeld] = useState(false);
  const pressRef = useRef(onPress);
  const repeatRef = useRef(onRepeat);
  const doubleTapRef = useRef(onDoubleTap);
  const configRef = useRef({ intervalMs, doubleTapMs, doubleTapEnabled });
  pressRef.current = onPress;
  repeatRef.current = onRepeat;
  doubleTapRef.current = onDoubleTap;

  function createTimer(durationMs: number): HoldTimer {
    return new HoldTimer({
      durationMs,
      mode: "repeat",
      // The add-on contract: a press adds nothing until a whole interval has passed.
      fireOnStart: false,
      onComplete: () => {
        vibrate(HAPTIC.increment);
        repeatRef.current();
      },
    });
  }
  if (!timerRef.current) timerRef.current = createTimer(intervalMs);
  const timer = timerRef.current;

  const stopLoop = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const clearTapTimeout = useCallback(() => {
    if (tapTimeoutRef.current !== null) {
      clearTimeout(tapTimeoutRef.current);
      tapTimeoutRef.current = null;
    }
  }, []);

  // Replace the timing brain when saved preferences change. An in-flight hold
  // and an ambiguous pending tap are both canceled rather than completed with
  // stale timing.
  useEffect(() => {
    const previous = configRef.current;
    if (previous.intervalMs === intervalMs && previous.doubleTapMs === doubleTapMs && previous.doubleTapEnabled === doubleTapEnabled) return;
    configRef.current = { intervalMs, doubleTapMs, doubleTapEnabled };
    timerRef.current?.cancel();
    stopLoop();
    clearTapTimeout();
    pointerRef.current = null;
    setHeld(false);
    setProgress(0);
    timerRef.current = createTimer(intervalMs);
  }, [clearTapTimeout, doubleTapEnabled, doubleTapMs, intervalMs, stopLoop]);

  /** One frame, one clock reading — advance and paint from the same instant. */
  const loop = useCallback(() => {
    const current = timerRef.current;
    if (!current || !current.isHeld) return;
    const now = current.clock();
    current.advance(now);
    if (!current.isHeld) return;
    setProgress(current.progress(now));
    frameRef.current = requestAnimationFrame(loop);
  }, []);

  const beginHold = useCallback(() => {
    if (disabled) return;
    const current = timerRef.current;
    if (!current || current.isHeld) return;
    setHeld(true);
    setProgress(0);
    current.start();
    stopLoop();
    frameRef.current = requestAnimationFrame(loop);
  }, [disabled, loop, stopLoop]);

  const endHold = useCallback(
    (cancelled = false) => {
      const current = timerRef.current;
      pointerRef.current = null;
      if (!current?.isHeld) return;
      // *This* press, not the button's history: a lifetime counter would make
      // every press after the first successful hold look like a hold, and the
      // double tap could never be recognised again.
      const added = current.holdOccurrenceCount > 0;
      current.cancel();
      stopLoop();
      setHeld(false);
      setProgress(0);
      // A cancelled pointer (the browser took the gesture for a scroll) is not
      // a tap: only a real release can be one, and only if nothing was added.
      if (cancelled || added) {
        clearTapTimeout();
        return;
      }
      // When double-tap is disabled, do not defer or reinterpret taps. Explicit
      // decrement controls remain independent of this gesture setting.
      if (!doubleTapEnabled) {
        clearTapTimeout();
        pressRef.current?.();
        return;
      }
      // A release that added nothing is a tap. Hold it back for one window so
      // a second tap can be interpreted as decrement.
      if (tapTimeoutRef.current !== null) {
        clearTapTimeout();
        doubleTapRef.current?.();
        return;
      }
      if (!doubleTapRef.current) {
        // Nothing to disambiguate against — run the tap immediately.
        pressRef.current?.();
        return;
      }
      tapTimeoutRef.current = setTimeout(() => {
        tapTimeoutRef.current = null;
        pressRef.current?.();
      }, doubleTapMs);
    },
    [clearTapTimeout, doubleTapEnabled, doubleTapMs, stopLoop],
  );

  // Unmount safety: no rAF frame, no pending tap timeout and no half-held
  // timer outlives the button.
  useEffect(
    () => () => {
      stopLoop();
      clearTapTimeout();
      timerRef.current?.cancel();
    },
    [clearTapTimeout, stopLoop],
  );

  // Disabled mid-hold (the group's ceiling was reached by this very hold):
  // stop rather than keep filling toward an increment that cannot land.
  useEffect(() => {
    if (disabled && timerRef.current?.isHeld) endHold(true);
  }, [disabled, endHold]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (event.repeat || disabled || held) return;
    beginHold();
  }

  function handleKeyUp(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    endHold();
  }

  function handleBlur() {
    endHold(true);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (pointerRef.current !== null) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    pointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    beginHold();
  }

  function handlePointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    if (pointerRef.current !== null && event.pointerId !== pointerRef.current) return;
    endHold(false);
  }

  function handlePointerAbort(event: React.PointerEvent<HTMLButtonElement>) {
    if (pointerRef.current !== null && event.pointerId !== pointerRef.current) return;
    if (event.type === "pointerleave" && !held) return;
    endHold(true);
  }

  const reduced = prefersReducedMotion();
  const percent = Math.round(progress * 100);

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerAbort}
      onPointerLeave={handlePointerAbort}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={handleBlur}
      onContextMenu={(event) => event.preventDefault()}
      className={`relative select-none overflow-hidden transition duration-150 active:scale-[0.97] disabled:opacity-45 motion-reduce:transition-none ${className}`}
      style={{ touchAction: "none" }}
    >
      {/*
        The ramp toward the next increment — a full-height wash across the
        button in the design-system amber accent, not the old 4px hairline
        nobody could see on a busy counter. It sits *behind* the label
        (`-z-0` under a relative label) at a low enough alpha that the text
        stays legible on both halves of the sweep, and it resets to zero after
        every increment so the button is always showing the next unit's ramp.
      */}
      <span
        aria-hidden="true"
        data-testid="hold-repeat-fill"
        data-progress={percent}
        className="pointer-events-none absolute inset-y-0 start-0 bg-amber-500/45 dark:bg-amber-300/40"
        style={{
          width: `${progress * 100}%`,
          opacity: held && progress > 0 ? 1 : 0,
          transition: reduced ? "none" : undefined,
        }}
      />
      <span className="relative z-10 flex min-w-0 flex-1 items-center justify-between gap-1">
        {children}
      </span>
    </button>
  );
}
