"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
/**
 * Optional wizard step, shown only on a local-only install: where the nightly
 * backup is written.
 *
 * On the desktop app the folder picker is a real OS dialog, exposed by the
 * Electron preload bridge, AND (Section 3 of the desktop audit) the chosen
 * folder is actually checked before it is saved: free disk space on its
 * volume, and a real write/read/delete round trip — not just "a path string
 * was typed". Anywhere else (a browser hitting a local server) folder choice
 * degrades to typing the path, which is the only thing a browser can do, and
 * neither check is available.
 */
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { api, errorMessage, SetupDataSkeleton, StepShell } from "../ui";
import { useRouter } from "next/navigation";
import { nextPath, prevPath } from "../steps";
import type { DesktopFolderCheckResult } from "@/lib/desktop-bridge";
import "@/lib/desktop-bridge";

interface BackupConfigResponse {
  config?: {
    enabled: boolean;
    intervalHours: number;
    anchorTime: string;
    localRetention: number;
    directory: string;
  };
  localOnly?: boolean;
}

/** The one place this step explains a folder-check failure in the owner's language. */
const CHECK_ERROR_MESSAGES: Record<string, string> = {
  path_not_found: "مسیر انتخابی معتبر نیست.",
  statfs_unavailable: "بررسی فضای دیسک برای این پوشه ممکن نشد.",
  cannot_create_folder: "ساخت این پوشه ممکن نشد — دسترسی لازم را بررسی کنید.",
  cannot_write: "نوشتن در این پوشه ممکن نشد — دسترسی یا آنتی‌ویروس را بررسی کنید.",
  cannot_read: "خواندن از این پوشه پس از نوشتن ممکن نشد.",
  readback_mismatch: "محتوای نوشته‌شده هنگام خواندن با اصل مطابقت نداشت.",
};

/** A pass/fail row for one of the three checks (space / write access / round trip). */
function CheckRow({
  label,
  state,
  detail,
}: {
  label: string;
  state: "pending" | "ok" | "warn" | "fail";
  detail?: string;
}) {
  const styles: Record<typeof state, string> = {
    pending: "bg-muted text-muted-foreground",
    ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
    warn: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
    fail: "bg-destructive/10 text-destructive",
  };
  const icon = state === "ok" ? "✓" : state === "warn" ? "!" : state === "fail" ? "×" : "…";
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
      <div>
        <p className="font-medium">{label}</p>
        {detail ? <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p> : null}
      </div>
      <span className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${styles[state]}`}>
        {icon}
      </span>
    </div>
  );
}

export default function BackupStepPage() {
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const [localOnly, setLocalOnly] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [anchorTime, setAnchorTime] = useState("03:30");
  const [localRetention, setLocalRetention] = useState(14);
  const [directory, setDirectory] = useState("");
  const [canPick, setCanPick] = useState(false);
  const [canCheck, setCanCheck] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<DesktopFolderCheckResult | null>(null);
  const [checkedDirectory, setCheckedDirectory] = useState("");

  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.businessSuiteDesktop : undefined;
    setCanPick(Boolean(bridge?.pickFolder));
    setCanCheck(Boolean(bridge?.storage?.checkFolder));
    fetch("/api/backup/config")
      .then((r) => r.json())
      .then((data: BackupConfigResponse) => {
        setLocalOnly(Boolean(data.localOnly));
        if (data.config) {
          setEnabled(data.config.enabled);
          setAnchorTime(data.config.anchorTime);
          setLocalRetention(data.config.localRetention);
          setDirectory(data.config.directory ?? "");
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  // A connected install has nothing to configure here — the dashboard's backup
  // page covers both halves — so this step just steps aside.
  useEffect(() => {
    if (loaded && !localOnly) router.replace(nextPath("backup"));
  }, [loaded, localOnly, router]);

  // Re-checking is required whenever the folder text changes: a stale
  // "پوشه سالم است" for a path the owner has since edited would be actively
  // misleading, not just outdated.
  useEffect(() => {
    if (directory !== checkedDirectory) setCheckResult(null);
  }, [directory, checkedDirectory]);

  async function pick() {
    const chosen = await window.businessSuiteDesktop?.pickFolder("پوشهٔ پشتیبان‌گیری");
    if (chosen) {
      setDirectory(chosen);
      await runCheck(chosen);
    }
  }

  async function runCheck(target?: string) {
    const path = (target ?? directory).trim();
    if (!path) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const result = await window.businessSuiteDesktop?.storage?.checkFolder(path);
      setCheckResult(result ?? null);
      setCheckedDirectory(path);
    } finally {
      setChecking(false);
    }
  }

  /**
   * Saves the destination, then records the step. Both writes matter (issue
   * #808 §6): the second one used to be fired and its failure swallowed, so a
   * dropped connection moved the owner on while `/setup` still considered this
   * step incomplete. A failed progress write now stops here with a retry, and
   * the busy flag is released in `finally` on every path.
   */
  async function save(skip: boolean) {
    setBusy(true);
    setError("");
    try {
      if (!skip) {
        const { ok, data } = await api<{ error?: string }>("/api/backup/config", {
          method: "PUT",
          body: JSON.stringify({
            enabled,
            intervalHours: 24,
            anchorTime,
            localRetention,
            directory,
            cloud: { enabled: false },
          }),
        });
        if (!ok) {
          setError(
            data.error === "cloud_backup_unavailable_local"
              ? "در نصب محلی، پشتیبان‌گیری ابری در دسترس نیست."
              : "ذخیرهٔ تنظیمات پشتیبان‌گیری ممکن نشد.",
          );
          return;
        }
      }
      const progress = await api<{ error?: string }>("/api/setup/progress", {
        method: "POST",
        body: JSON.stringify({ step: "backup" }),
      });
      if (!progress.ok) {
        setError(errorMessage(progress.data?.error, undefined, progress.status));
        return;
      }
      router.push(nextPath("backup"));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded || !localOnly) return <SetupDataSkeleton rows={4} />;

  const spaceState: "pending" | "ok" | "warn" | "fail" = !checkResult
    ? "pending"
    : !checkResult.space?.ok
      ? "fail"
      : checkResult.space.recommended
        ? "ok"
        : "warn";
  const accessState: "pending" | "ok" | "warn" | "fail" = !checkResult
    ? "pending"
    : checkResult.access?.ok
      ? "ok"
      : "fail";
  const checkFailed = Boolean(checkResult && !checkResult.ok);

  return (
    <StepShell
      step="backup"
      description={
        "این نصب محلی است، بنابراین نسخه‌های پشتیبان روی همین دستگاه ساخته می‌شوند. یک پوشه — " +
        "ترجیحاً روی یک درایو دیگر یا حافظهٔ خارجی — انتخاب کنید."
      }
    >

      {error ? (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="space-y-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          پشتیبان‌گیری خودکار شبانه فعال باشد
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">پوشهٔ مقصد</span>
          <div className="flex gap-2">
            <input
              className="w-full rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary"
              dir="ltr"
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              placeholder="D:\pos-backups"
            />
            {canPick ? (
              <button
                type="button"
                onClick={() => void pick()}
                className="shrink-0 rounded-lg border border-input px-4 text-sm hover:bg-muted"
              >
                انتخاب پوشه…
              </button>
            ) : null}
          </div>
          <span className="mt-1 block text-xs text-muted-foreground">
            خالی بگذارید تا از مسیر پیش‌فرض استفاده شود.
          </span>
        </label>

        {canCheck && directory.trim() ? (
          <div className="space-y-2 rounded-xl border border-border bg-muted/20 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium">بررسی این پوشه</p>
              <button
                type="button"
                onClick={() => void runCheck()}
                disabled={checking}
                className="rounded-lg border border-input px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
              >
                {checking ? "در حال بررسی…" : directory === checkedDirectory && checkResult ? "بررسی دوباره" : "بررسی پوشه"}
              </button>
            </div>
            {checkResult ? (
              <div className="space-y-2">
                <CheckRow
                  label="فضای آزاد دیسک"
                  state={spaceState}
                  detail={
                    checkResult.space?.ok
                      ? `${toPersianDigits(checkResult.space.freeLabel || "")} آزاد از ${toPersianDigits(checkResult.space.totalLabel || "")}${
                          checkResult.space.recommended ? "" : " — کمتر از مقدار پیشنهادی"
                        }`
                      : CHECK_ERROR_MESSAGES[checkResult.space?.error || ""] || "بررسی ممکن نشد."
                  }
                />
                <CheckRow
                  label="دسترسی نوشتن (آزمایش واقعی نوشتن و خواندن)"
                  state={accessState}
                  detail={
                    checkResult.access?.ok
                      ? "این پوشه قابل نوشتن و خواندن است."
                      : CHECK_ERROR_MESSAGES[checkResult.access?.error || ""] || "بررسی ناموفق بود."
                  }
                />
                {checkFailed ? (
                  <p className="text-xs text-destructive">
                    این پوشه برای ذخیرهٔ پشتیبان مناسب نیست؛ پوشهٔ دیگری انتخاب کنید.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                برای اطمینان از فضای کافی و دسترسی نوشتن، پوشه را بررسی کنید.
              </p>
            )}
          </div>
        ) : null}

        <label className="block">
          <span className="mb-1 block text-sm font-medium">ساعت اجرا</span>
          <input
            className="rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary"
            dir="ltr"
            type="time"
            value={anchorTime}
            onChange={(e) => setAnchorTime(e.target.value)}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">تعداد نسخه‌های نگهداری‌شده</span>
          <PersianNumberInput
            className="w-32 rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary"
            dir="ltr"
            value={localRetention}
            onChange={(e) => setLocalRetention(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            const previous = prevPath("backup");
            if (previous) router.push(previous);
          }}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← مرحلهٔ قبل
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void save(true)}
            disabled={busy}
            className="rounded-lg border border-input px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
          >
            فعلاً رد شو
          </button>
          <button
            type="button"
            onClick={() => void save(false)}
            disabled={busy}
            className="rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/85 disabled:opacity-50"
          >
            {busy ? "در حال ذخیره…" : "ذخیره و ادامه"}
          </button>
        </div>
      </div>
    </StepShell>
  );
}
