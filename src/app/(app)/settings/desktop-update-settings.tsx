"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2Icon, CircleAlertIcon, DownloadIcon, HardDriveIcon, PauseIcon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import type { DesktopUpdateState } from "@/lib/desktop-bridge";
import { ErrorBox, InfoBox, PrimaryButton, SecondaryButton, api, errorMessage, inputClass } from "@/app/dashboard/ui";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";

type Channel = "stable" | "beta" | "internal";
interface LocalUpdateStatus {
  checkedAt: string;
  installed?: { version: string; buildCommit: string; buildId: string; channel: Channel };
  centralRuntime?: { releaseVersion: string | null; commitSha: string | null; buildId: string | null } | null;
  targetRelease: DesktopUpdateState["target"];
  compliance: string;
  error: string | null;
  currentVersion: string;
}
interface Policy { automaticChecks: boolean; backgroundDownload: boolean; automaticInstall: false; channel: Channel }

const CHANNEL_LABEL: Record<Channel, string> = { stable: "پایدار", beta: "آزمایشی", internal: "داخلی" };
const STATE_LABEL: Record<DesktopUpdateState["state"], string> = {
  checking: "در حال بررسی", no_update: "به‌روز", update_available: "به‌روزرسانی موجود",
  downloading: "در حال دانلود", paused: "دانلود متوقف", verifying: "در حال اعتبارسنجی",
  ready_to_install: "آمادهٔ نصب", backup_in_progress: "در حال پشتیبان‌گیری",
  installing: "در حال نصب", restarting: "در حال راه‌اندازی دوباره",
  verifying_health: "در حال بررسی سلامت", success: "به‌روزرسانی موفق",
  failed: "ناموفق", recovery_required: "نیازمند بازیابی",
};
const ERROR_TEXT: Record<string, string> = {
  installer_origin_not_allowed: "نشانی نصب‌کننده در فهرست مبدأهای مورد اعتماد نیست.",
  installer_sha256_mismatch: "فایل دانلودشده با هش انتشار یکسان نیست و حذف شد.",
  installer_size_mismatch: "اندازهٔ فایل نصب‌کننده با انتشار یکسان نیست.",
  download_size_mismatch: "دانلود ناقص یا خراب بود؛ دوباره تلاش کنید.",
  authenticode_invalid: "امضای ناشر ویندوز معتبر نیست؛ نصب مسدود شد.",
  expected_publisher_missing: "هویت ناشر مورد انتظار در انتشار ثبت نشده است.",
  backup_verification_failed: "ساخت یا خواندن پشتیبان پیش از نصب ناموفق بود؛ نصب انجام نشد.",
  active_shift_blocks_update: "یک شیفت باز است. شیفت را ببندید و سپس نصب را دوباره آغاز کنید.",
  active_order_blocks_update: "سفارش باز یا نگه‌داشته‌شده وجود دارد. ابتدا آن را نهایی کنید.",
  installed_version_unsupported: "این نسخه برای ارتقای مستقیم پشتیبانی نمی‌شود؛ با پشتیبانی تماس بگیرید.",
  post_update_version_mismatch: "پس از راه‌اندازی، نسخهٔ مورد انتظار اجرا نشد. از راهنمای بازیابی استفاده کنید.",
  offline_version_not_newer: "بستهٔ آفلاین جدیدتر از نسخهٔ نصب‌شده نیست.",
  manifest_invalid: "فایل معرفی انتشار معتبر نیست.",
  update_failed: "به‌روزرسانی انجام نشد؛ دوباره تلاش کنید.",
};

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  try { return toPersianDigits(new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))); }
  catch { return "—"; }
}
function fmtBytes(value: number): string { return `${toPersianDigits((value / 1024 / 1024).toFixed(1))} مگابایت`; }

function Readiness({ ready, label }: { ready: boolean; label: string }) {
  const Icon = ready ? CheckCircle2Icon : CircleAlertIcon;
  return <li className="flex items-center gap-2 text-sm"><Icon className={`size-4 ${ready ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}`} aria-hidden="true" /><span>{label}</span></li>;
}

export function DesktopUpdateSettings() {
  const [local, setLocal] = useState<LocalUpdateStatus | null>(null);
  const [policy, setPolicy] = useState<Policy>({ automaticChecks: true, backgroundDownload: false, automaticInstall: false, channel: "stable" });
  const [engine, setEngine] = useState<DesktopUpdateState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bridge = typeof window === "undefined" ? undefined : window.businessSuiteDesktop?.update;

  const load = useCallback(async (runCheck = false) => {
    setLoading(true); setError("");
    const response = await api<{ status: LocalUpdateStatus | null; policy: Policy; error?: string }>("/api/desktop-update/status");
    if (!response.ok) { setError(errorMessage(response.data.error)); setLoading(false); return; }
    setLocal(response.data.status); setPolicy(response.data.policy);
    if (bridge) {
      const configured = await bridge.configure(response.data.policy);
      setEngine(configured);
      if (runCheck || response.data.policy.automaticChecks) {
        setEngine(await bridge.check(response.data.status?.targetRelease ?? null));
      }
    }
    setLoading(false);
  }, [bridge]);

  useEffect(() => { void load(false); }, [load]);
  useEffect(() => bridge?.onState(setEngine), [bridge]);

  async function savePolicy(next: Policy) {
    setBusy(true); setError("");
    const response = await api<{ policy?: Policy; error?: string }>("/api/desktop-update/status", { method: "PUT", body: JSON.stringify(next) });
    if (!response.ok) setError(errorMessage(response.data.error));
    else { setPolicy(response.data.policy ?? next); if (bridge) setEngine(await bridge.configure(response.data.policy ?? next)); }
    setBusy(false);
  }

  async function invoke(action: () => Promise<DesktopUpdateState>) {
    setBusy(true); setError("");
    try { setEngine(await action()); }
    catch { setError("اجرای این مرحله ممکن نشد. برنامه و اتصال را بررسی کرده و دوباره تلاش کنید."); }
    setBusy(false);
  }

  if (loading) return <LoadingSkeleton rows={4} label="در حال بررسی وضعیت به‌روزرسانی" />;
  if (!bridge) return <SectionCard title="به‌روزرسانی نرم‌افزار" description="این بخش فقط در برنامهٔ دسکتاپ ویندوز فعال است."><EmptyState>این صفحه در مرورگر باز شده است. برای مدیریت نصب محلی، آن را از داخل Business Suite دسکتاپ باز کنید.</EmptyState></SectionCard>;

  const state = engine?.state ?? "no_update";
  const target = engine?.target ?? local?.targetRelease ?? null;
  const installedVersion = engine?.installedVersion ?? local?.installed?.version ?? local?.currentVersion ?? "—";
  const downloaded = Boolean(engine?.installerPath) && ["ready_to_install", "backup_in_progress", "installing", "restarting", "success"].includes(state);
  const verified = downloaded;
  const backedUp = Boolean(engine?.backupPath);
  const errorCode = engine?.errorCode;

  return <div className="space-y-6">
    <ErrorBox>{error}</ErrorBox>
    {errorCode ? <ErrorBox>{ERROR_TEXT[errorCode] ?? ERROR_TEXT.update_failed}</ErrorBox> : null}

    <SectionCard title="به‌روزرسانی نرم‌افزار" description="نسخه، کانال و انتشار هدف؛ SHA و Build جدا از SemVer نگهداری می‌شوند.">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <StatusBadge tone={state === "success" || state === "no_update" ? "positive" : state === "failed" || state === "recovery_required" ? "danger" : "active"}>{STATE_LABEL[state]}</StatusBadge>
        <SecondaryButton onClick={() => void load(true)} disabled={busy}><RefreshCwIcon className="size-4" aria-hidden="true" />بررسی دوباره</SecondaryButton>
      </div>
      <dl className="grid gap-x-8 sm:grid-cols-2">
        <div className="flex justify-between border-b border-border py-2 text-sm"><dt className="text-muted-foreground">نسخهٔ نصب‌شده</dt><dd dir="ltr" className="font-medium">{installedVersion}</dd></div>
        <div className="flex justify-between border-b border-border py-2 text-sm"><dt className="text-muted-foreground">نسخهٔ هدف</dt><dd dir="ltr" className="font-medium">{target?.version ?? "—"}</dd></div>
        <div className="flex justify-between border-b border-border py-2 text-sm"><dt className="text-muted-foreground">ساخت نصب‌شده</dt><dd dir="ltr" className="font-medium">{local?.installed?.buildCommit ?? "—"}</dd></div>
        <div className="flex justify-between border-b border-border py-2 text-sm"><dt className="text-muted-foreground">کانال</dt><dd className="font-medium">{CHANNEL_LABEL[policy.channel]}</dd></div>
        <div className="flex justify-between border-b border-border py-2 text-sm"><dt className="text-muted-foreground">آخرین بررسی</dt><dd className="font-medium">{fmtDate(local?.checkedAt ?? engine?.checkedAt)}</dd></div>
        <div className="flex justify-between border-b border-border py-2 text-sm"><dt className="text-muted-foreground">اندازه</dt><dd className="font-medium">{target ? fmtBytes(target.installer.size) : "—"}</dd></div>
      </dl>

      {state === "downloading" || state === "paused" ? <div className="mt-5" role="status" aria-live="polite"><div className="mb-2 flex justify-between text-sm"><span>دانلود به‌روزرسانی</span><span>{toPersianDigits(String(engine?.progress?.percent ?? 0))}٪</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${engine?.progress?.percent ?? 0}%` }} /></div><p className="mt-2 text-xs text-muted-foreground">{fmtBytes(engine?.progress?.received ?? 0)} از {fmtBytes(engine?.progress?.total ?? target?.installer.size ?? 0)}</p></div> : null}

      {target?.releaseNotes.length ? <div className="mt-5"><h3 className="text-sm font-semibold">یادداشت انتشار</h3><ul className="mt-2 list-disc space-y-1 pe-5 text-sm text-muted-foreground">{target.releaseNotes.map((note) => <li key={note}>{note}</li>)}</ul></div> : null}

      <div className="mt-5 flex flex-wrap gap-2">
        {state === "update_available" || state === "paused" || state === "failed" ? <PrimaryButton onClick={() => void invoke(() => bridge.download())} disabled={busy || !target}><DownloadIcon className="size-4" aria-hidden="true" />{state === "paused" ? "ادامه دانلود" : "دانلود"}</PrimaryButton> : null}
        {state === "downloading" ? <SecondaryButton onClick={() => void invoke(() => bridge.pause())} disabled={busy}><PauseIcon className="size-4" aria-hidden="true" />توقف موقت</SecondaryButton> : null}
        {state === "ready_to_install" ? <><PrimaryButton onClick={() => { setEngine((current) => current ? { ...current, state: "backup_in_progress" } : current); void bridge.installNow(); }} disabled={busy}>پشتیبان، راه‌اندازی دوباره و نصب</PrimaryButton><SecondaryButton onClick={() => void invoke(() => bridge.installOnNextRestart())} disabled={busy}>نصب در راه‌اندازی بعدی</SecondaryButton></> : null}
        {engine?.installOnNextRestart ? <InfoBox>نصب برای بسته‌شدن بعدی برنامه زمان‌بندی شده است. پیش از خروج، پشتیبان تأیید می‌شود.</InfoBox> : null}
        <SecondaryButton onClick={() => void invoke(() => bridge.selectOfflinePackage())} disabled={busy}><HardDriveIcon className="size-4" aria-hidden="true" />بستهٔ آفلاین</SecondaryButton>
        {["downloading", "paused", "ready_to_install", "failed"].includes(state) ? <SecondaryButton onClick={() => void invoke(() => bridge.cancel())} disabled={busy}>لغو و پاک‌کردن فایل</SecondaryButton> : null}
      </div>
    </SectionCard>

    {target ? <SectionCard title="آمادگی پیش از نصب" description="جایگزینی فایل اجرایی فقط پس از سبز شدن همهٔ کنترل‌ها انجام می‌شود.">
      <ul className="space-y-3"><Readiness ready={downloaded} label="نصب‌کننده کامل دریافت شده" /><Readiness ready={verified} label="اندازه و SHA-256 تأیید شده" /><Readiness ready={verified} label="امضای Authenticode و ناشر ویندوز تأیید شده" /><Readiness ready={backedUp} label="پشتیبان محلی ساخته و با pg_restore خوانده شده" /><Readiness ready={target.database.backupRequired} label="سیاست انتشار، پشتیبان اجباری دارد" /></ul>
      {backedUp ? <div className="mt-4"><SecondaryButton onClick={() => void bridge.showBackup()}><ShieldCheckIcon className="size-4" aria-hidden="true" />نمایش پشتیبان</SecondaryButton></div> : null}
    </SectionCard> : null}

    <SectionCard title="سیاست به‌روزرسانی" description="بررسی خودکار روشن است؛ نصب بی‌حضور همیشه خاموش می‌ماند تا صندوق در حال کار قطع نشود.">
      <label className="mb-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={policy.automaticChecks} onChange={(event) => void savePolicy({ ...policy, automaticChecks: event.target.checked })} disabled={busy} />بررسی خودکار انتشارها</label>
      <label className="mb-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={policy.backgroundDownload} onChange={(event) => void savePolicy({ ...policy, backgroundDownload: event.target.checked })} disabled={busy} />دانلود در پس‌زمینه پس از یافتن انتشار</label>
      <label className="block max-w-xs text-sm"><span className="mb-1 block font-medium">کانال انتشار</span><select className={inputClass} value={policy.channel} onChange={(event) => void savePolicy({ ...policy, channel: event.target.value as Channel })} disabled={busy}><option value="stable">پایدار</option><option value="beta">آزمایشی</option><option value="internal">داخلی</option></select></label>
      <p className="mt-3 text-xs text-muted-foreground">نصب خودکار: خاموش. گزینه‌های امن «اکنون» یا «راه‌اندازی بعدی» فقط پس از اعتبارسنجی فایل در دسترس‌اند.</p>
    </SectionCard>

    {state === "recovery_required" ? <SectionCard title="بازیابی لازم است"><InfoBox>پشتیبان پیش از به‌روزرسانی حفظ شده است. برنامه پایگاه‌داده را خودکار پایین‌نسخه نمی‌کند. جزئیات فنی را برای پشتیبانی ارسال و بازیابی داده را فقط با تأیید سازگاری انجام دهید.</InfoBox>{target?.recovery.notes ? <p className="text-sm text-muted-foreground">{target.recovery.notes}</p> : null}</SectionCard> : null}
    {engine?.errorDetail ? <details className="rounded-2xl border border-border bg-card p-4 text-xs"><summary className="cursor-pointer font-medium">جزئیات فنی</summary><pre className="mt-3 overflow-auto whitespace-pre-wrap text-muted-foreground" dir="ltr">{engine.errorCode}{"\n"}{engine.errorDetail}</pre></details> : null}
  </div>;
}
