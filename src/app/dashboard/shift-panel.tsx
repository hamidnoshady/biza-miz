"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
/**
 * Phase 20 Wave 5 — self-service clock-in/clock-out for PIN-role staff (the
 * same audience as the lock screen and biometric-settings panel), in the
 * sidebar footer next to them rather than under /dashboard/settings for the
 * same reason biometric-settings.tsx lives there: this is each employee
 * managing their own shift, not something a manager configures for them.
 * The admin review side (shift history, force-close) is the separate
 * "شیفت‌ها" settings tab (shift-history-settings.tsx).
 *
 * ## Issue #933 — what this panel must not do
 *
 *   * Treat a failed read as "no shift". An unavailable `/api/shifts/active`
 *     used to render «شروع شیفت» as if nothing were open; pressing it then hit
 *     `shift_already_open`. The status now has an explicit unavailable state
 *     with a retry, and the action is not offered from it.
 *   * Prefill the count with the expected figure. The expected amount is shown
 *     read-only; the input stays empty unless the person counted the drawer.
 *   * Go stale. It refreshes when the branch changes and keeps the shift's
 *     elapsed duration current while mounted.
 *   * Trap keyboard users. The modal closes on Escape, is `role="dialog"`
 *     `aria-modal`, focuses its first control, keeps Tab inside, and disables
 *     the submit button while a request is in flight.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ClockIcon } from "lucide-react";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { formatMoney } from "@/lib/money";
import { useMoney } from "@/components/money/money-context";
import { newIdempotencyKey } from "@/lib/idempotency";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, errorMessage, inputClass } from "./ui";
import { Skeleton } from "@/components/ui/skeleton";
import { overlayPanelClass } from "./page-chrome";
import { BRANCH_CHANGED_EVENT } from "./branch-switcher";
import {
  SIDEBAR_FOOTER_BUTTON_ACTIVE_CLASS,
  SIDEBAR_FOOTER_BUTTON_CLASS,
} from "./sidebar-nav-styles";

interface Shift {
  id: string;
  openingFloat: number | null;
  closingFloat: number | null;
  startedAt: string;
  endedAt: string | null;
}

interface CashSummary {
  orderCount: number;
  cashTotal: number;
}

interface ActiveShiftResponse {
  shift: Shift | null;
  cashSummary?: CashSummary;
  expectedCash?: number | null;
  error?: string;
}

/** «۲ ساعت و ۵ دقیقه» — how long the shift has been running. */
function formatElapsed(startedAt: string, now: number): string {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || now < start) return "";
  const minutes = Math.floor((now - start) / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${toPersianDigits(rest)} دقیقه`;
  if (rest === 0) return `${toPersianDigits(hours)} ساعت`;
  return `${toPersianDigits(hours)} ساعت و ${toPersianDigits(rest)} دقیقه`;
}

export function ShiftButton() {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState<Shift | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  /**
   * Only the newest read may write state. A branch switch fires a reload while
   * the previous request is still in flight, and without this the slower answer
   * could win and show the old branch's shift.
   */
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const { ok, data } = await api<ActiveShiftResponse>("/api/shifts/active");
      if (seq !== requestSeq.current) return;
      if (!ok) {
        setShift(null);
        setLoadError(errorMessage(data.error));
        return;
      }
      setShift(data.shift);
      setLoadError("");
    } catch {
      if (seq !== requestSeq.current) return;
      setLoadError("وضعیت شیفت در دسترس نیست.");
    } finally {
      if (seq === requestSeq.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    window.addEventListener(BRANCH_CHANGED_EVENT, load);
    return () => window.removeEventListener(BRANCH_CHANGED_EVENT, load);
  }, [load]);

  // An open shift's elapsed time is stale the moment it renders; a slow tick is
  // enough for a duration shown in minutes.
  useEffect(() => {
    if (!shift) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [shift]);

  if (!loaded) {
    return (
      <div role="status" aria-live="polite" aria-busy="true" aria-label="در حال بارگذاری وضعیت شیفت">
        <Skeleton aria-hidden="true" className="mb-2 h-8 w-full rounded-lg" />
      </div>
    );
  }

  // Nothing is offered while the status is unknown: offering «شروع شیفت» here is
  // how a member with an open shift got `shift_already_open` instead of being
  // told their shift is already running.
  if (loadError) {
    return (
      <button
        type="button"
        onClick={() => {
          setLoaded(false);
          void load();
        }}
        className={SIDEBAR_FOOTER_BUTTON_CLASS}
        title="وضعیت شیفت خوانده نشد؛ برای تلاش دوباره بزنید"
      >
        <ClockIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-start">وضعیت شیفت نامشخص — تلاش دوباره</span>
      </button>
    );
  }

  const elapsed = shift ? formatElapsed(shift.startedAt, now) : "";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={shift ? SIDEBAR_FOOTER_BUTTON_ACTIVE_CLASS : SIDEBAR_FOOTER_BUTTON_CLASS}
      >
        <ClockIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-start">
          {shift ? `پایان شیفت${elapsed ? ` · ${elapsed}` : ""}` : "شروع شیفت"}
        </span>
      </button>
      {open && (
        <ShiftModal
          shift={shift}
          onClose={() => setOpen(false)}
          onChanged={async () => {
            await load();
          }}
        />
      )}
    </>
  );
}

function ShiftModal({
  shift,
  onClose,
  onChanged,
}: {
  shift: Shift | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const money = useMoney();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ variance: number | null; unresolved: boolean } | null>(null);
  /** The running expectation, read from the server; shown, never copied into the input. */
  const [expectedCash, setExpectedCash] = useState<number | null>(null);
  const [summary, setSummary] = useState<CashSummary | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  /**
   * One key per close attempt, reused if the same button is pressed again after
   * a timeout. Without it a retried close finds no open shift and reports
   * failure for work that already committed (#933 item 1).
   */
  const closeKey = useRef<string | null>(null);
  const openKey = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleId = "shift-modal-title";

  // Escape closes; Tab stays inside. A sidebar modal covers the whole screen,
  // so letting focus wander to the page behind it is a keyboard trap in
  // reverse — the user can no longer see where they are.
  useEffect(() => {
    inputRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  // The running expectation is only available while a shift is open.
  useEffect(() => {
    if (!shift) return;
    let cancelled = false;
    void (async () => {
      const { ok, data } = await api<ActiveShiftResponse>("/api/shifts/active");
      if (cancelled || !ok) return;
      setExpectedCash(data.expectedCash ?? null);
      setSummary(data.cashSummary ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [shift]);

  async function start() {
    setBusy(true);
    setError("");
    let openingFloat: number | undefined;
    if (amount.trim()) {
      try {
        openingFloat = money.parse(amount);
      } catch {
        setBusy(false);
        setError(errorMessage("invalid_amount"));
        return;
      }
    }
    openKey.current ??= newIdempotencyKey("shift-open");
    const { ok, data } = await api<{ error?: string }>("/api/shifts/start", {
      method: "POST",
      headers: { "Idempotency-Key": openKey.current },
      body: JSON.stringify({ openingFloat }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    openKey.current = null;
    await onChanged();
    onClose();
  }

  async function end() {
    setBusy(true);
    setError("");
    let closingFloat: number | undefined;
    if (amount.trim()) {
      try {
        closingFloat = money.parse(amount);
      } catch {
        setBusy(false);
        setError(errorMessage("invalid_amount"));
        return;
      }
    }
    closeKey.current ??= newIdempotencyKey("shift-close");
    const { ok, data } = await api<{
      error?: string;
      reconciliation?: { variance: number | null; status?: string } | null;
    }>("/api/shifts/end", {
      method: "POST",
      headers: { "Idempotency-Key": closeKey.current },
      body: JSON.stringify(closingFloat === undefined ? { withoutCount: true } : { countedCash: closingFloat }),
    });
    setBusy(false);
    if (!ok) {
      // A keyed retry that the server refused is a new intent next time.
      if (data.error !== "shift_already_closed") closeKey.current = null;
      setError(errorMessage(data.error));
      return;
    }
    closeKey.current = null;
    await onChanged();
    const variance = data.reconciliation?.variance ?? null;
    if (data.reconciliation) {
      setResult({ variance, unresolved: variance === null });
    } else {
      onClose();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`${overlayPanelClass} w-full max-w-sm p-6`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id={titleId} className="font-semibold">
            {shift ? "پایان شیفت" : "شروع شیفت"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            بستن
          </button>
        </div>

        {result ? (
          <InfoBox>
            شیفت پایان یافت.{" "}
            {result.unresolved
              ? "صندوق بدون شمارش بسته شد؛ اختلاف صندوق ثبت نشده است."
              : result.variance === 0
                ? "اختلاف صندوق: بدون اختلاف"
                : `اختلاف صندوق: ${result.variance !== null && result.variance > 0 ? "+" : ""}${money.format(result.variance ?? 0)}`}
          </InfoBox>
        ) : (
          <>
            {shift && (
              <p className="mb-3 text-xs text-muted-foreground">
                شروع شیفت: {toPersianDigits(formatJalali(shift.startedAt, { withMonthName: true, withTime: true }))}
                {shift.openingFloat !== null
                  ? ` · موجودی اول: ${money.format(shift.openingFloat)}`
                  : ""}
              </p>
            )}
            {shift && summary ? (
              <dl className="mb-3 grid grid-cols-2 gap-x-3 gap-y-1 rounded-xl border border-input px-3 py-2 text-xs">
                <div>
                  <dt className="text-muted-foreground">فروش نقدی تا این لحظه</dt>
                  <dd className="font-semibold tabular-nums">{money.format(summary.cashTotal)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">مبلغ مورد انتظار صندوق</dt>
                  <dd className="font-semibold tabular-nums">
                    {expectedCash === null ? "— (موجودی اول ثبت نشده)" : money.format(expectedCash)}
                  </dd>
                </div>
              </dl>
            ) : null}
            <ErrorBox>{error}</ErrorBox>
            <Field
              label={shift ? "موجودی شمرده‌شدهٔ صندوق (اختیاری)" : "موجودی اول صندوق (اختیاری)"}
              hint={
                shift
                  ? "این عدد را فقط اگر صندوق را شمرده‌اید وارد کنید. خالی گذاشتن یعنی شیفت بدون شمارش بسته شود و اختلاف صندوق «نامشخص» بماند."
                  : "برای شیفت‌های بدون صندوق (گارسون/آشپزخانه) می‌توانید خالی بگذارید."
              }
            >
              <PersianNumberInput
                ref={inputRef}
                className={inputClass}
                dir="ltr"
                inputMode="numeric"
                value={amount}
                onChange={(e) => {
                  // A changed amount is a new intent; a retry of the same one
                  // keeps its key.
                  if (!busy) closeKey.current = null;
                  setAmount(e.target.value);
                }}
                placeholder="۰"
                disabled={busy}
                allowNegative={false}
              />
            </Field>
            <PrimaryButton type="button" disabled={busy} onClick={shift ? end : start}>
              {busy ? "در حال ثبت…" : shift ? "پایان شیفت" : "شروع شیفت"}
            </PrimaryButton>
          </>
        )}
      </div>
    </div>
  );
}
