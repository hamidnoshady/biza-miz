"use client";

import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { api, SecondaryButton } from "@/app/dashboard/ui";
import type { PayTermChange } from "@/lib/payroll-types";
import { TERM_LABELS } from "./payroll-term-labels";

/**
 * One member's pay-term history, opened on demand — issue #835 §6.
 *
 * Every change to a member's wage, allowances or fixed deduction is recorded
 * (which term, previous amount, new amount, who, when, why) in an append-only
 * table; this is the screen's window onto it. It is fetched only when somebody
 * asks, so a long list of members does not read every member's history up
 * front, and it comes from a `payroll.view` route: the page that renders it is
 * already behind that capability.
 */
export function TermHistory({ staffId, version }: { staffId: string; version: number }) {
  const money = useMoney();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "failed" | "ready">("idle");
  const [changes, setChanges] = useState<PayTermChange[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);

  const load = useCallback(
    async (after: string | null) => {
      setState("loading");
      const query = new URLSearchParams({ limit: "10" });
      if (after) query.set("cursor", after);
      const { ok, data } = await api<{ changes: PayTermChange[]; nextCursor: string | null }>(
        `/api/ledger/payroll/staff/${staffId}/history?${query}`,
      );
      if (!ok) return setState("failed");
      setChanges((prev) => (after ? [...prev, ...data.changes] : data.changes));
      setCursor(data.nextCursor);
      setState("ready");
    },
    [staffId],
  );

  // Open → read; a saved term (`version` bumps) → read again so the new row shows.
  useEffect(() => {
    if (open) void load(null);
  }, [open, version, load]);

  function amount(value: string | null): string {
    return value === null ? "بدون حقوق" : money.formatText(value);
  }

  function when(iso: string): string {
    try {
      return toPersianDigits(formatJalali(iso, { withTime: true }));
    } catch {
      return "—";
    }
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "بستن سابقهٔ تغییرات" : "سابقهٔ تغییرات حقوق و مزایا"}
      </button>
      {open ? (
        <div className="mt-2 rounded-lg border border-border/80 bg-card p-3" aria-live="polite">
          {state === "loading" && changes.length === 0 ? (
            <LoadingSkeleton rows={2} compact label="در حال بارگذاری سابقهٔ تغییرات" />
          ) : state === "failed" ? (
            <div className="flex items-center gap-3 text-xs text-destructive">
              <span role="alert">بارگذاری سابقه ناموفق بود.</span>
              <SecondaryButton onClick={() => void load(null)}>تلاش دوباره</SecondaryButton>
            </div>
          ) : changes.length === 0 ? (
            <p className="text-xs text-muted-foreground">تغییری ثبت نشده است.</p>
          ) : (
            <>
              <ul className="space-y-2">
                {changes.map((change) => (
                  <li key={change.id} className="text-xs leading-6">
                    <span className="text-muted-foreground">{TERM_LABELS[change.term]}: </span>
                    <span className="font-semibold tabular-nums text-foreground">
                      {amount(change.previousAmount)} ← {amount(change.newAmount)}
                    </span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {when(change.changedAt)}
                      {change.changedByName ? ` · ${change.changedByName}` : ""}
                      {change.reason ? ` · ${change.reason}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              {cursor ? (
                <div className="mt-2 max-w-40">
                  <SecondaryButton onClick={() => void load(cursor)} disabled={state === "loading"}>
                    موارد قدیمی‌تر
                  </SecondaryButton>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
