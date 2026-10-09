"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toPersianDigits } from "@/lib/digits";

/**
 * The one resend-cooldown timer for OTP surfaces (issue #854 P2.25).
 *
 * Every screen that sends a 6-digit code faces the server's per-send limiter
 * (one send per 60 seconds, plus hourly/daily caps). Showing a live countdown
 * of that window — instead of letting the member click «ارسال مجدد» and learn
 * about it from an error — is the requirement, and seeding it from the
 * challenge's *actual* request time is the honesty clause: a reload mid-window
 * must show the remaining seconds, not a fresh 60.
 *
 * Callers pass the ISO request time the server reported (`otpRequestAt` /
 * `smsChallengeRequestedAt`) whenever they have it, and `start()` right after
 * a send they just performed. `retryAfterMs` covers the cap answers (429):
 * the limiter itself says when the next send is allowed, which is longer than
 * the base cooldown once the hourly/daily caps engage — so it wins.
 */
export function useResendCooldown(cooldownSeconds = 60) {
  const [waitSeconds, setWaitSeconds] = useState(0);
  const requestedAtRef = useRef<number | null>(null);
  const untilRef = useRef<number | null>(null);

  const recompute = useCallback(() => {
    const until = untilRef.current;
    if (until === null) return;
    const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    setWaitSeconds(remaining);
    if (remaining <= 0) {
      requestedAtRef.current = null;
      untilRef.current = null;
    }
  }, []);

  useEffect(() => {
    const tick = setInterval(() => {
      if (untilRef.current !== null) recompute();
    }, 500);
    return () => clearInterval(tick);
  }, [recompute]);

  /** Seed from the server's actual request time (survives reloads). */
  const seedFromRequestedAt = useCallback(
    (requestedAtIso: string | null | undefined) => {
      if (!requestedAtIso) return;
      const requestedAt = Date.parse(requestedAtIso);
      if (Number.isNaN(requestedAt)) return;
      requestedAtRef.current = requestedAt;
      untilRef.current = requestedAt + cooldownSeconds * 1000;
      recompute();
    },
    [cooldownSeconds, recompute],
  );

  /** A send just happened right now (the caller performed it). */
  const start = useCallback(() => {
    requestedAtRef.current = Date.now();
    untilRef.current = requestedAtRef.current + cooldownSeconds * 1000;
    setWaitSeconds(cooldownSeconds);
  }, [cooldownSeconds]);

  /**
   * The limiter's own answer (a 429's `retryAfterMs`) — it may name a longer
   * window than the base cooldown, and the server's word outranks the guess.
   */
  const applyRetryAfterMs = useCallback((retryAfterMs: number | undefined | null) => {
    const ms = typeof retryAfterMs === "number" ? retryAfterMs : 0;
    if (ms <= 0) return;
    untilRef.current = Date.now() + ms;
    requestedAtRef.current = Date.now();
    setWaitSeconds(Math.max(1, Math.ceil(ms / 1000)));
  }, []);

  /** The window expired or the ceremony was cancelled/confirmed. */
  const clear = useCallback(() => {
    requestedAtRef.current = null;
    untilRef.current = null;
    setWaitSeconds(0);
  }, []);

  return { waitSeconds, coolingDown: waitSeconds > 0, seedFromRequestedAt, start, applyRetryAfterMs, clear };
}

/**
 * A 1-second heartbeat so an expiry countdown keeps moving even after the
 * resend cooldown (which has its own ticker) has lapsed. `active` lets the
 * caller run it only while an OTP panel is actually on screen.
 */
export function useNowTick(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(tick);
  }, [active, intervalMs]);
  return now;
}

/**
 * Issue #854 (P2.25) — an OTP challenge lives for a bounded window; screens
 * waiting on a code must say how long is left, and must say plainly once the
 * window has passed, instead of silently rejecting a correct-looking entry.
 * Pass the ticking `now` from `useNowTick` so the countdown stays live.
 */
export function smsChallengeExpiryMessage(expiresAtIso: string, now: number = Date.now()): string {
  const remainingMs = Date.parse(expiresAtIso) - now;
  if (Number.isNaN(remainingMs)) return "";
  if (remainingMs <= 0) {
    return "اعتبار کد پیامکی تمام شده است؛ با «ارسال مجدد کد» کد تازه بگیرید.";
  }
  const remainingS = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(remainingS / 60);
  const seconds = remainingS % 60;
  const clock =
    minutes > 0
      ? `${toPersianDigits(String(minutes))}:${toPersianDigits(String(seconds).padStart(2, "0"))}`
      : toPersianDigits(String(remainingS));
  return `اعتبار این کد تا ${clock} دیگر باقی است.`;
}
