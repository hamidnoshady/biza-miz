"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/app/dashboard/ui";
import { formatUserCode } from "@/lib/desktop-enroll-shared";
import type { EnrollmentReadiness } from "@/lib/desktop-enrollment-readiness";

/**
 * Issue #1115 §A.3 — the owner's half of browser enrollment.
 *
 * The Windows app has already opened this page and is polling. Everything here
 * is reversible except the confirmation: refusing ends the reservation, and
 * approving is the only action that binds a device. The branch picker re-asks
 * the Cloud for readiness on every change, because the answer genuinely
 * differs per branch (an empty menu at one branch blocks that branch only).
 */
export function DesktopEnrollConfirm({
  requestId,
  businessName,
  deviceName,
  userCode,
  maxSnapshotVersion,
  locations,
  initialLocationId,
  initialReadiness,
}: {
  requestId: string;
  businessName: string;
  deviceName: string;
  userCode: string;
  maxSnapshotVersion: number | null;
  locations: Array<{ id: string; name: string }>;
  initialLocationId: string | null;
  initialReadiness: EnrollmentReadiness;
}) {
  const router = useRouter();
  const [locationId, setLocationId] = useState(initialLocationId ?? "");
  const [readiness, setReadiness] = useState<EnrollmentReadiness>(initialReadiness);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState("");

  async function chooseLocation(next: string) {
    setLocationId(next);
    setChecking(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (next) params.set("locationId", next);
      if (maxSnapshotVersion !== null) params.set("maxSnapshotVersion", String(maxSnapshotVersion));
      const res = await fetch(`/api/connections/desktop/readiness?${params.toString()}`);
      const data = (await res.json().catch(() => ({}))) as { readiness?: EnrollmentReadiness };
      if (res.ok && data.readiness) setReadiness(data.readiness);
      else setError("بررسی آماده‌بودن کسب‌وکار ناموفق بود. دوباره تلاش کنید.");
    } catch {
      setError("بررسی آماده‌بودن کسب‌وکار ناموفق بود. دوباره تلاش کنید.");
    } finally {
      setChecking(false);
    }
  }

  async function decide(action: "approve" | "deny") {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/desktop-enroll/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "deny" ? { requestId, action: "deny" } : { requestId, action: "approve", locationId },
        ),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        readiness?: EnrollmentReadiness;
      };
      if (res.ok) {
        setOutcome(action === "approve" ? "approved" : "denied");
        return;
      }
      if (data.error === "not_ready" && data.readiness) {
        setReadiness(data.readiness);
        setError("این کسب‌وکار هنوز برای اتصال دستگاه آماده نیست.");
        return;
      }
      if (data.error === "not_found") {
        setError("این درخواست منقضی شده یا دیگر معتبر نیست. در برنامهٔ ویندوز دوباره تلاش کنید.");
        return;
      }
      setError("انجام این کار ناموفق بود. دوباره تلاش کنید.");
    } catch {
      setError("ارتباط برقرار نشد. اتصال اینترنت را بررسی و دوباره تلاش کنید.");
    } finally {
      setBusy(false);
    }
  }

  if (outcome) {
    return (
      <div className="text-center">
        <span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
          {outcome === "approved" ? "✓" : "—"}
        </span>
        <h1 className="text-lg font-bold text-foreground">
          {outcome === "approved" ? "دستگاه تأیید شد" : "درخواست رد شد"}
        </h1>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">
          {outcome === "approved"
            ? "به برنامهٔ ویندوز برگردید. دریافت تنظیمات و آماده‌سازی دستگاه به‌صورت خودکار ادامه پیدا می‌کند."
            : "هیچ دستگاهی به این کسب‌وکار متصل نشد. اگر اشتباه شد، از برنامهٔ ویندوز یک درخواست تازه بسازید."}
        </p>
        <Button type="button" className="mt-6 w-full" onClick={() => router.replace("/dashboard")}>
          رفتن به داشبورد
        </Button>
      </div>
    );
  }

  const blocked = !readiness.ready;
  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-amber-700 dark:text-amber-300">
        اتصال دستگاه ویندوز
      </p>
      <h1 className="text-lg font-bold text-foreground">یک دستگاه می‌خواهد به «{businessName}» وصل شود</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        فقط اگر همین دستگاه را می‌شناسید و کد روی صفحهٔ آن با کد زیر یکی است، تأیید کنید.
      </p>

      <dl className="mt-5 space-y-2 rounded-xl border border-border bg-muted/40 p-4 text-sm">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">دستگاه</dt>
          <dd className="font-medium text-foreground" dir="ltr">
            {deviceName}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">کد تأیید</dt>
          <dd className="font-mono text-lg tracking-[0.2em] text-foreground" dir="ltr">
            {formatUserCode(userCode)}
          </dd>
        </div>
      </dl>

      {error ? (
        <div role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="mt-5">
        <Field label="شعبه‌ای که این دستگاه به آن وصل می‌شود">
          <select
            className={inputClass}
            value={locationId}
            disabled={checking || busy || locations.length === 0}
            onChange={(event) => void chooseLocation(event.target.value)}
          >
            <option value="">انتخاب شعبه…</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {checking ? (
        <p className="mt-3 text-xs text-muted-foreground">در حال بررسی آماده‌بودن کسب‌وکار…</p>
      ) : null}

      {blocked && !checking ? (
        <div className="mt-4 rounded-xl border border-amber-300/60 bg-amber-50/70 p-4 dark:border-amber-500/30 dark:bg-amber-500/10">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            کسب‌وکار خود را ابتدا در ابر کامل کنید.
          </p>
          <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-200/80">
            تا زمانی که این موارد کامل نشوند، دستگاه متصل نمی‌شود؛ پس از تکمیل، همین صفحه را دوباره باز کنید.
          </p>
          <ul className="mt-3 space-y-2 text-sm text-amber-950 dark:text-amber-100">
            {readiness.blockers.map((blocker) => (
              <li key={`${blocker.code}-${blocker.message}`} className="flex flex-wrap items-center gap-2">
                <span>{blocker.message}</span>
                {blocker.action.kind === "open_cloud_setup" ? (
                  <a
                    href={blocker.action.href}
                    className="text-xs font-semibold text-teal-700 underline underline-offset-4 dark:text-teal-300"
                  >
                    رفتن به تنظیمات ابری
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-6 flex flex-col gap-2 sm:flex-row-reverse">
        <Button
          type="button"
          className="flex-1"
          disabled={busy || checking || blocked || !locationId}
          onClick={() => void decide("approve")}
        >
          {busy ? "در حال انجام…" : "تأیید و اتصال دستگاه"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          disabled={busy}
          onClick={() => void decide("deny")}
        >
          رد درخواست
        </Button>
      </div>
      <p className="mt-3 text-center text-xs text-muted-foreground">
        این درخواست کوتاه‌عمر است؛ اگر صفحه را ببندید، از برنامهٔ ویندوز یک درخواست تازه بسازید.
      </p>
    </div>
  );
}
