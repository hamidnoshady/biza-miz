"use client";

/**
 * What the #865 payroll-engine screens share: the API's shapes (type-only
 * imports — nothing server-side reaches the bundle), run-status wording, Shamsi
 * period/date display, and one fetch hook with a cancel-on-unmount guard.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali, JALALI_MONTHS, todayJalali } from "@/lib/jalali";
import { api } from "@/app/dashboard/ui";
import type { EngineRun, EngineRunStatus, Payslip } from "@/lib/payroll-engine-runs";
import type { PayrollComponent, PayrollProfile, PayrollRuleSetVersion } from "@/lib/payroll-engine-setup";
import { payrollError } from "./payroll-error";

export type { EngineRun, EngineRunStatus, Payslip, PayrollComponent, PayrollProfile, PayrollRuleSetVersion };

export const RUN_STATUS: Record<EngineRunStatus, { label: string; tone: "active" | "positive" | "neutral" | "danger" }> = {
  draft: { label: "پیش‌نویس", tone: "neutral" },
  calculated: { label: "محاسبه‌شده", tone: "active" },
  reviewed: { label: "بازبینی‌شده", tone: "active" },
  approved: { label: "تأییدشده", tone: "active" },
  posted: { label: "ثبت‌شده در دفتر", tone: "positive" },
  paid: { label: "پرداخت‌شده", tone: "positive" },
  closed: { label: "بسته‌شده", tone: "neutral" },
  cancelled: { label: "لغوشده", tone: "danger" },
};

/** «1404-05» → «مرداد ۱۴۰۴». */
export function periodText(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return toPersianDigits(key);
  const month = JALALI_MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${toPersianDigits(m[1])}` : toPersianDigits(key);
}

/** A server date as Shamsi; a dash when absent or unparseable (never a throw in render). */
export function shamsi(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatJalali(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  } catch {
    return "—";
  }
}

/** The current Jalali month as a period key. */
export function currentPeriodKey(): string {
  const t = todayJalali();
  return `${t.jy}-${String(t.jm).padStart(2, "0")}`;
}

/** The last `count` period keys, newest first — the choices a period picker offers. */
export function recentPeriodKeys(count = 18): string[] {
  const t = todayJalali();
  const out: string[] = [];
  let y = t.jy;
  let m = t.jm;
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

/** Hours / days as Persian digits, with a sign when negative (a correction). */
export function quantityText(n: number): string {
  return toPersianDigits(n < 0 ? `−${Math.abs(n)}` : String(n));
}

/**
 * GETs `url` on mount and whenever `reloadKey` changes. Ignores a response that
 * arrives after unmount or after a newer request, so a slow reply never
 * overwrites a fresh one.
 */
export function useEngineData<T>(url: string | null, reloadKey: unknown = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(url !== null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (url === null) return;
    const mine = ++seq.current;
    setLoading(true);
    const res = await api<T & { error?: string }>(url);
    if (mine !== seq.current || res.aborted) return;
    if (res.ok) {
      setData(res.data);
      setError("");
    } else setError(payrollError(res.data.error));
    setLoading(false);
  }, [url]);
  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [load, reloadKey]);
  return { data, error, loading, reload: load };
}
