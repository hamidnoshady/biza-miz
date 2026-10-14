"use client";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "@/lib/pin-policy";

/**
 * The numeric entry pad shared by the login screen's PIN step (Phase 20
 * Wave 2's employee picker) and the dashboard lock screen — one keypad, two
 * callers, so a tweak to either doesn't drift out of sync with the other.
 *
 * Phase 42 — the PIN grew from exactly four digits to 4–12. A fixed length can
 * no longer auto-submit "when the last dot fills", because the pad cannot know
 * the member's length: the dots now grow as digits land (up to twelve —
 * compacting past eight so a long PIN still fits the card), a «تأیید» button
 * submits (enabled from four digits on), and reaching twelve submits by itself
 * — the one length the pad can still know for certain.
 *
 * Issue #885 — the bounds are imported, not restated. This file repeated the
 * 4 and 12 as local constants while `pin-policy.ts` already exported them for
 * exactly this reason: it imports nothing from Node, so a `"use client"`
 * component can share the server's rule. Two copies of a security-relevant
 * bound is how one of them gets changed without the other, and the pad is the
 * component that decides when a PIN is complete enough to submit.
 */
const MIN_DIGITS = PIN_MIN_LENGTH;
const MAX_DIGITS = PIN_MAX_LENGTH;

export function PinPad({
  onComplete,
  busy = false,
  error = null,
  resetKey,
  submitLabel = "تأیید",
}: {
  onComplete: (pin: string) => void;
  busy?: boolean;
  error?: string | null;
  /** Change this to force the entered digits to clear (e.g. switching employees). */
  resetKey?: unknown;
  /** The confirm button's label — the lock screen says the same thing. */
  submitLabel?: string;
}) {
  const [pin, setPin] = useState("");

  useEffect(() => {
    setPin("");

  }, [resetKey]);

  function submit(value: string) {
    if (busy) return;
    onComplete(value);
    setPin("");
  }

  function press(digit: string) {
    if (busy) return;
    const next = (pin + digit).slice(0, MAX_DIGITS);
    setPin(next);
    // Twelve is the ceiling, so the twelfth digit is by definition the last.
    if (next.length === MAX_DIGITS) {
      submit(next);
    }
  }

  const canSubmit = !busy && pin.length >= MIN_DIGITS;

  return (
    <div>
      <div
        className={`mb-4 flex min-h-3.5 items-center justify-center ${pin.length > 8 ? "gap-1.5" : "gap-3"}`}
        role="progressbar"
        aria-label="پین وارد شده"
        aria-valuenow={pin.length}
        aria-valuemin={0}
        aria-valuemax={MAX_DIGITS}
      >
        {Array.from({ length: Math.max(MIN_DIGITS, pin.length) }, (_, i) => (
          <span
            key={i}
            className={`${pin.length > 8 ? "size-2.5" : "size-3.5"} rounded-full transition-colors ${i < pin.length ? "bg-primary" : "bg-muted"}`}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <PadButton
            key={d}
            label={toPersianDigits(d)}
            ariaLabel={toPersianDigits(d)}
            onClick={() => press(d)}
          />
        ))}
        <PadButton
          label="پاک"
          ariaLabel="پاک کردن همه"
          onClick={() => setPin("")}
          muted
        />
        <PadButton
          label={toPersianDigits("0")}
          ariaLabel={toPersianDigits("0")}
          onClick={() => press("0")}
        />
        <PadButton
          label="⌫"
          ariaLabel="پاک کردن یک رقم"
          onClick={() => setPin((p) => p.slice(0, -1))}
          muted
        />
      </div>
      <button
        type="button"
        onClick={() => submit(pin)}
        disabled={!canSubmit}
        className="mt-3 w-full rounded-lg bg-primary py-3 text-base font-semibold text-primary-foreground transition hover:bg-primary/85 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
      >
        {busy ? "در حال بررسی…" : submitLabel}
      </button>
      {error && (
        <p role="alert" className="mt-3 text-center text-sm text-destructive">
          {error}
        </p>
      )}
      {busy && (
        <p
          role="status"
          className="mt-3 text-center text-sm text-muted-foreground"
        >
          در حال بررسی…
        </p>
      )}
    </div>
  );
}

function PadButton({
  label,
  ariaLabel,
  onClick,
  muted = false,
}: {
  label: string;
  ariaLabel?: string;
  onClick: () => void;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={`rounded-lg py-3 text-lg font-semibold transition outline-none focus-visible:ring focus-visible:ring-ring/50 active:scale-95 ${
        muted
          ? "bg-muted text-muted-foreground hover:bg-muted-foreground/20"
          : "bg-muted hover:bg-primary/10"
      }`}
    >
      {label}
    </button>
  );
}
