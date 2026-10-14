"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ErrorBox, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { formatJalali } from "@/lib/jalali";
import { SecurityConfirmDialog } from "@/components/auth/security-confirm-dialog";

interface Status {
  state: string;
  lastSuccessAt: string | null;
  sequence: number;
  pending: number;
  failed: number;
  lastError: string | null;
}

const labels: Record<string, string> = {
  healthy: "سالم",
  pending: "در انتظار",
  syncing: "در حال همگام‌سازی",
  degraded: "نیازمند بررسی",
  conflict: "تعارض",
  snapshot_required: "نیازمند ترمیم",
  offline: "آفلاین",
};

export function IamSyncCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /**
   * Issue #854 (P2.26) — «ترمیم از نسخهٔ ابری» replaces the local permission
   * set with the cloud's copy, and «تبدیل به مدیریت محلی» detaches the site
   * from the cloud entirely. Both used to be a bare `confirm()`; they now go
   * through the shared product confirmation, and only its confirm path sends
   * the mutation.
   */
  const [confirmKind, setConfirmKind] = useState<"repair" | "detach" | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ status: Status; error?: string }>("/api/team/iam-status");
    if (r.ok) setStatus(r.data.status);
    else setError(r.data.error ?? "دریافت وضعیت ناموفق بود.");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function action(kind: string) {
    setBusy(true);
    setError("");
    const r = await api<{ error?: string }>("/api/team/iam-status", {
      method: "POST",
      body: JSON.stringify({ action: kind }),
    });
    if (!r.ok) setError("همگام‌سازی انجام نشد. اتصال ابری و جزئیات تشخیصی را بررسی کنید.");
    await load();
    setBusy(false);
  }

  async function executeConfirmed() {
    const kind = confirmKind;
    setConfirmKind(null);
    if (!kind) return;
    if (kind === "repair") {
      await action("repair");
      return;
    }
    setBusy(true);
    const r = await api<{ error?: string }>("/api/team/detach-site", { method: "POST" });
    if (r.ok) {
      location.reload();
    } else {
      setError("جداسازی کامل نشد؛ اتصال، پشتیبان‌گیری و رمز محلی مالک را بررسی کنید.");
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="iam-sync-title"
      className="rounded-2xl border border-border bg-card p-4 sm:p-5"
    >
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 id="iam-sync-title" className="font-semibold">همگام‌سازی هویت و دسترسی</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            امنیت پیش از سفارش‌ها و عملیات روزمره همگام می‌شود.
          </p>
        </div>
        <span role="status" className="rounded-full bg-muted px-3 py-1 text-sm">
          {labels[status?.state ?? ""] ?? "در حال دریافت"}
        </span>
      </div>
      <ErrorBox>{error}</ErrorBox>
      {status ? (
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">آخرین موفقیت</dt>
            <dd>{status.lastSuccessAt ? formatJalali(status.lastSuccessAt) : "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">توالی امنیت</dt>
            <dd dir="ltr">{status.sequence.toLocaleString("fa-IR")}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">فرمان‌های معلق</dt>
            <dd>{status.pending.toLocaleString("fa-IR")}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">رویدادهای ناموفق</dt>
            <dd>{status.failed.toLocaleString("fa-IR")}</dd>
          </div>
        </dl>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <PrimaryButton disabled={busy} onClick={() => void action("sync")}>
          همگام‌سازی اکنون
        </PrimaryButton>
        <SecondaryButton disabled={busy} onClick={() => void action("retry")}>
          تلاش دوباره
        </SecondaryButton>
        <SecondaryButton disabled={busy} onClick={() => setConfirmKind("repair")}>
          ترمیم از نسخهٔ ابری
        </SecondaryButton>
        <SecondaryButton
          disabled={busy}
          className="border-destructive/30 text-destructive"
          onClick={() => setConfirmKind("detach")}
        >
          تبدیل به مدیریت محلی
        </SecondaryButton>
      </div>
      {status?.lastError ? (
        <details className="mt-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer">جزئیات فنی</summary>
          <code dir="ltr" className="mt-2 block break-all rounded bg-muted p-2">
            {status.lastError}
          </code>
        </details>
      ) : null}

      <SecurityConfirmDialog
        open={confirmKind === "repair"}
        title="ترمیم از نسخهٔ ابری"
        description="نسخهٔ دسترسی ابری دوباره دریافت و جایگزین نسخهٔ محلی می‌شود."
        consequences={[
          "سطح دسترسی محلی اعضا با آخرین نسخهٔ تأییدشدهٔ ابری جایگزین می‌شود.",
          "محدودیت‌هایی که خود این سایت گذاشته حفظ می‌شوند.",
          "اطلاعات فروش و عملیاتی تغییری نمی‌کنند؛ موضوع فقط هویت و دسترسی است.",
        ]}
        confirmLabel="بله، ترمیم انجام شود"
        busy={busy}
        onOpenChange={(next) => {
          if (!next) setConfirmKind(null);
        }}
        onConfirm={() => void executeConfirmed()}
      />
      <SecurityConfirmDialog
        open={confirmKind === "detach"}
        title="تبدیل به مدیریت محلی"
        description="این سایت از فضای ابری جدا می‌شود و مدیریت کاربران محلی خواهد شد."
        consequences={[
          "پس از یک پشتیبان‌گیری و همگام‌سازی نهایی، اتصال ابری این سایت قطع می‌شود.",
          "از این پس نقش‌ها، اعضا و اعتبارنامه‌ها فقط روی همین سایت مدیریت می‌شوند و تغییرات به ابر نمی‌روند.",
          "این کار بازگشت‌پذیر نیست؛ اتصال دوباره به فضای ابری مسیر جداگانه‌ای دارد.",
        ]}
        confirmLabel="بله، جدا شود"
        busy={busy}
        onOpenChange={(next) => {
          if (!next) setConfirmKind(null);
        }}
        onConfirm={() => void executeConfirmed()}
      />
    </section>
  );
}
