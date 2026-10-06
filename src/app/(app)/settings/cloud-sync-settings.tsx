"use client";

import Link from "next/link";
import { useState } from "react";
import { CloudIcon, DatabaseIcon, KeyRoundIcon, RefreshCwIcon, ServerIcon, ShieldCheckIcon } from "lucide-react";
import { cardClass, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import type { ConnectionStatus, PlatformConnectionState } from "@/lib/connection-state";
import type { DeploymentProfile } from "@/lib/deployment-mode";
import { Button } from "@/components/ui/button";
import { useOfflineQueue } from "@/app/dashboard/offline-queue";
import { credentialSyncLabel } from "@/lib/iam/credential-health";

interface StatusResponse extends PlatformConnectionState {
  profile: DeploymentProfile;
  siteProfile?: { appliedAt: string | null; lastError: string | null } | null;
}
const LABEL: Record<ConnectionStatus, string> = {
  connected: "متصل", unreachable: "در دسترس نیست", unknown: "نامشخص", connecting: "در حال اتصال",
  paused: "موقتاً متوقف", not_configured: "تنظیم نشده", attention_required: "نیازمند بررسی", not_applicable: "کاربرد ندارد",
};

const IDENTITY_LABEL: Record<string, string> = {
  healthy: "سالم", pending: "در انتظار", syncing: "در حال همگام‌سازی", degraded: "نیازمند بررسی",
  conflict: "تعارض", snapshot_required: "نیازمند همگام‌سازی کامل", offline: "آفلاین", not_configured: "تنظیم نشده",
};

const OVERALL_NOTE: Record<string, string> = {
  healthy: "هویت و ورود کارکنان کامل همگام شده است.",
  degraded: "همگام‌سازی هویت کامل نیست؛ برای تکمیل، «همگام‌سازی دوباره» را بزنید.",
  limited: "نسخهٔ ابری این کسب‌وکار سرویس رمز/پین کارکنان را ندارد؛ کارکنان ساخته‌شده در ابر روی این دستگاه قابل ورود نیستند.",
  syncing: "همگام‌سازی هویت در جریان است.",
  not_configured: "این دستگاه به ابر متصل نیست.",
};

export function CloudSyncSettings() {
  const { serverStatus } = useOfflineQueue();
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairMessage, setRepairMessage] = useState<string | null>(null);
  if (!serverStatus) return <SectionCardSkeleton rows={4} label="در حال بررسی وضعیت اتصال" />;
  const state = serverStatus as StatusResponse & {
    identitySync?: { state: string; lastAttemptAt: string | null; lastSuccessAt: string | null; lastError: string | null } | null;
    credentialSync?: {
      state: string;
      lastAttemptAt: string | null;
      lastSuccessAt: string | null;
      lastError: string | null;
      membershipsExpected: number;
      identitiesExpected: number;
      identitiesLinked: number;
      pinMembersExpected: number;
      pinMembersUsable: number;
      pinMembersMissing: number;
      missingIdentityBindings: number;
      /** Issue #850: staff PINs the cloud removed; the last pass revoked them here. */
      pinsRevoked?: number;
    } | null;
    overallIdentity?: string;
  };
  const local = state.profile === "local";
  const identity = state.identitySync ?? null;
  const credentials = state.credentialSync ?? null;
  const overall = state.overallIdentity ?? "not_configured";

  /**
   * Settings → اتصال is reachable only after a successful local sign-in, so
   * when it shows the partial-sync state the owner is already authenticated;
   * the repair endpoint reconciles memberships, events and login
   * credentials/PINs and answers 503 until all of them have converged.
   */
  async function repairIam() {
    setRepairBusy(true);
    setRepairMessage(null);
    try {
      const response = await fetch("/api/team/iam-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "repair" }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; reason?: string | null; credentialSync?: { pinMembersMissing?: number } } | null;
      if (body?.ok) setRepairMessage("همگام‌سازی هویت و رمز کارکنان کامل شد.");
      else {
        const missing = body?.credentialSync?.pinMembersMissing ?? 0;
        setRepairMessage(
          response.status === 403
            ? "برای تعمیر همگام‌سازی، دسترسی مدیریت تیم لازم است."
            : missing > 0
              ? `تعمیر انجام شد اما ${missing.toLocaleString("fa-IR")} حساب پین‌دار هنوز آماده نیست؛ دوباره تلاش کنید.`
              : "تعمیر کامل نشد؛ اتصال ابری را بررسی و دوباره تلاش کنید.",
        );
      }
    } catch {
      setRepairMessage("ارتباط با سرور ممکن نشد.");
    } finally {
      setRepairBusy(false);
      // The shell's single poller owns the connection state; nudge it so the
      // rows above reflect the repair immediately.
      window.dispatchEvent(new Event("online"));
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatusCard icon={ServerIcon} title="سیستم محلی" value={LABEL[state.localServer]} />
        <StatusCard icon={CloudIcon} title="حساب ابری" value={LABEL[state.cloud]} />
        <StatusCard icon={RefreshCwIcon} title="همگام‌سازی" value={LABEL[state.sync]} />
      </div>
      {!local && identity ? (
        <section className={`${cardClass} p-5`}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <ShieldCheckIcon className="size-5 text-muted-foreground" />
                <h3 className="font-bold text-foreground">هویت و ورود کارکنان</h3>
              </div>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                {OVERALL_NOTE[overall] ?? OVERALL_NOTE.degraded}
              </p>
            </div>
            <Button variant="outline" onClick={() => void repairIam()} disabled={repairBusy}>
              <RefreshCwIcon className="size-4" />
              {repairBusy ? "در حال همگام‌سازی…" : "همگام‌سازی دوباره"}
            </Button>
          </div>
          <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
            <IdentityRow
              icon={ServerIcon}
              label="عضویت و نقش‌ها"
              value={IDENTITY_LABEL[identity.state] ?? identity.state}
              detail={
                credentials
                  ? `${credentials.identitiesLinked.toLocaleString("fa-IR")} از ${credentials.identitiesExpected.toLocaleString("fa-IR")} هویت ورود پیوند خورده` +
                    (identity.lastSuccessAt ? ` — آخرین موفقیت: ${new Date(identity.lastSuccessAt).toLocaleString("fa-IR")}` : "")
                  : identity.lastSuccessAt
                    ? `آخرین موفقیت: ${new Date(identity.lastSuccessAt).toLocaleString("fa-IR")}`
                    : "هنوز همگام نشده"
              }
              healthy={identity.state === "healthy"}
            />
            <IdentityRow
              icon={KeyRoundIcon}
              label="رمز و پین ورود کارکنان"
              value={credentials ? credentialSyncLabel(credentials.state as never) : "در انتظار"}
              detail={
                credentials
                  ? `${credentials.pinMembersUsable.toLocaleString("fa-IR")} از ${credentials.pinMembersExpected.toLocaleString("fa-IR")} حساب پین‌دار آماده است` +
                    ((credentials.pinsRevoked ?? 0) > 0
                      ? ` — ${(credentials.pinsRevoked ?? 0).toLocaleString("fa-IR")} پین حذف‌شده در ابر روی این دستگاه هم باطل شد`
                      : "")
                  : "وضعیت رمز کارکنان دریافت نشده"
              }
              healthy={credentials?.state === "healthy" && credentials.pinMembersMissing === 0}
            />
            <IdentityRow
              icon={DatabaseIcon}
              label="داده‌های عملیاتی"
              value={LABEL[state.sync]}
              detail={state.lastConvergedAt ? `آخرین همگرایی: ${new Date(state.lastConvergedAt).toLocaleString("fa-IR")}` : "هنوز همگرا نشده"}
              healthy={state.sync === "connected"}
            />
          </dl>
          {credentials && credentials.pinMembersMissing > 0 ? (
            <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
              {`${credentials.pinMembersMissing.toLocaleString("fa-IR")} حساب پین‌دار (صندوق‌دار، گارسون، آشپزخانه) هنوز روی این دستگاه قابل ورود نیست.`}
              {credentials.lastError ? <span title={credentials.lastError}> — آخرین خطا ثبت شده است.</span> : null}
            </p>
          ) : null}
          {repairMessage ? <p className="mt-3 text-xs text-muted-foreground">{repairMessage}</p> : null}
        </section>
      ) : null}
      <section className={`${cardClass} p-5`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="font-bold text-foreground">{local ? "اتصال به ابر اشوبه" : "وضعیت داده‌ها"}</h3>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              {local
                ? "پایگاه داده و پشتیبان‌گیری محلی فعال‌اند. اتصال ابری فقط پس از بررسی سازگاری، تطبیق داده‌ها، راه‌اندازی اولیه و تأیید نهایی همگام‌سازی فعال می‌شود."
                : `آخرین همگرایی دوطرفه: ${state.lastConvergedAt ? new Date(state.lastConvergedAt).toLocaleString("fa-IR") : "هنوز انجام نشده"}`}
            </p>
            {!local ? (
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {`تنظیمات شعبه از ابر: ${state.siteProfile?.appliedAt ? new Date(state.siteProfile.appliedAt).toLocaleString("fa-IR") : "هنوز دریافت نشده"}`}
                {state.siteProfile?.lastError ? (
                  // The raw code is for support, not the reader.
                  <span title={state.siteProfile.lastError}> — دریافت تنظیمات شعبه از ابر ناموفق بود</span>
                ) : null}
              </p>
            ) : null}
          </div>
          {local ? (
            <Button asChild><Link href="/support"><CloudIcon className="size-4" /> درخواست تبدیل امن</Link></Button>
          ) : (
            <Button variant="outline" onClick={() => window.dispatchEvent(new Event("online"))}><RefreshCwIcon className="size-4" /> به‌روزرسانی</Button>
          )}
        </div>
        {!local ? (
          <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-5">
            <Metric label="خروجی در انتظار" value={state.outboundPending} />
            <Metric label="ورودی در انتظار" value={state.inboundPending} />
            <Metric label="در انتظار پیش‌نیاز" value={state.deferred} />
            <Metric label="تعارض" value={state.conflicts} />
            <Metric label="نیازمند بررسی" value={state.deadLetters} />
          </dl>
        ) : null}
      </section>
      <section className={`${cardClass} p-5`}>
        <div className="flex items-center gap-2"><DatabaseIcon className="size-5 text-muted-foreground" /><h3 className="font-bold">دامنه‌های داده</h3></div>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">صندوق، میزها، آشپزخانه و شیفت روی این دستگاه کار می‌کنند و با برگشت اینترنت به ابر فرستاده می‌شوند. حسابداری، گزارش‌ها، انبار، مشتریان و تنظیمات کسب‌وکار در نسخهٔ ابری‌اند؛ مسیر پشتیبان و چاپگر فقط روی این دستگاه می‌مانند.</p>
      </section>
    </div>
  );
}
function StatusCard({ icon: Icon, title, value }: { icon: typeof CloudIcon; title: string; value: string }) {
  return <div className={`${cardClass} p-4`}><Icon className="size-5 text-amber-700 dark:text-amber-300" /><p className="mt-3 text-xs text-muted-foreground">{title}</p><p className="mt-1 font-semibold">{value}</p></div>;
}
function IdentityRow({ icon: Icon, label, value, detail, healthy }: { icon: typeof CloudIcon; label: string; value: string; detail: string; healthy: boolean }) {
  return (
    <div className="rounded-lg bg-muted p-3">
      <dt className="flex items-center gap-1.5 text-muted-foreground"><Icon className="size-4" aria-hidden="true" />{label}</dt>
      <dd className="mt-1 font-semibold">
        <span className={healthy ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-300"}>{value}</span>
      </dd>
      <dd className="mt-1 text-xs text-muted-foreground">{detail}</dd>
    </div>
  );
}
function Metric({ label, value }: { label: string; value: number }) { return <div className="rounded-lg bg-muted p-3"><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 text-lg font-bold">{value.toLocaleString("fa-IR")}</dd></div>; }
