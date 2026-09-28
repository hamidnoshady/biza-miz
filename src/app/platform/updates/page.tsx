"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCwIcon, SearchIcon, ServerCogIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import {
  api,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  InfoBox,
  PlatformPageSkeleton,
  StatCard,
  inputClass,
  selectClass,
  useCan,
} from "../ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Compliance =
  | "up_to_date" | "update_available" | "ahead_of_target" | "version_mismatch"
  | "unknown" | "stale" | "offline" | "error" | "unsupported" | "incompatible";
type Channel = "stable" | "beta" | "internal";

interface Release {
  id: string;
  version: string;
  buildCommit: string;
  buildId: string;
  channel: Channel;
  status: "draft" | "published" | "paused" | "withdrawn";
  rolloutState: "internal" | "pilot" | "percentage" | "full" | "paused";
  rolloutPercentage: number;
  releasedAt: string;
  minimumSupportedVersion: string | null;
  mandatory: boolean;
  manifestSignature: string;
  installer: { url: string; sha256: string; size: number; signatureRequired: boolean; expectedPublisher: string | null };
  database: { migrationVersion: number | null; minimumSchemaVersion: number | null; maximumSchemaVersion: number | null; backupRequired: boolean };
  releaseNotes: string[];
  recovery: { knownGoodVersion: string | null; notes: string | null };
}

interface Device {
  siteDeviceId: string;
  publicId: string;
  businessId: string;
  businessName: string;
  locationName: string;
  deviceName: string;
  deviceStatus: string;
  revoked: boolean;
  installedVersion: string | null;
  buildCommit: string | null;
  buildId: string | null;
  schemaVersion: number | null;
  electronVersion: string | null;
  platform: string | null;
  channel: Channel;
  targetRelease: Release | null;
  compliance: Compliance;
  connectivity: "online" | "delayed" | "stale" | "offline";
  lastSeenAt: string | null;
  lastReportAt: string | null;
  clientCheckedAt: string | null;
  lastSuccessfulPushAt: string | null;
  lastSuccessfulPullAt: string | null;
  updateState: string | null;
  updateTargetVersion: string | null;
  error: { code: string; message: string | null } | null;
  updateEvents: Array<{
    state: string;
    installedVersion: string | null;
    targetVersion: string | null;
    errorCode: string | null;
    clientOccurredAt: string | null;
    reportedAt: string;
  }>;
}

interface FleetResponse {
  devices: Device[];
  releases: Release[];
  summary: { installations: number; upToDate: number; updateAvailable: number; offline: number; problems: number };
  error?: string;
}

const STATUS: Record<Compliance, { label: string; className: string }> = {
  up_to_date: { label: "به‌روز", className: "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  update_available: { label: "به‌روزرسانی موجود", className: "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  ahead_of_target: { label: "جلوتر از هدف", className: "border-sky-500/30 bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  version_mismatch: { label: "نسخه نامعتبر", className: "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300" },
  unknown: { label: "نامشخص", className: "border-border bg-muted text-muted-foreground" },
  stale: { label: "گزارش قدیمی", className: "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  offline: { label: "آفلاین", className: "border-border bg-muted text-muted-foreground" },
  error: { label: "خطا", className: "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300" },
  unsupported: { label: "پشتیبانی‌نشده", className: "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300" },
  incompatible: { label: "ناسازگار", className: "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300" },
};
const CHANNEL_LABEL: Record<Channel, string> = { stable: "پایدار", beta: "آزمایشی", internal: "داخلی" };
const CONNECTIVITY_LABEL = { online: "آنلاین", delayed: "با تأخیر", stale: "قدیمی", offline: "آفلاین" };
const UPDATE_STATE_LABEL: Record<string, string> = {
  checking: "بررسی", no_update: "بدون به‌روزرسانی", update_available: "انتشار موجود",
  downloading: "در حال دانلود", paused: "دانلود متوقف", verifying: "در حال اعتبارسنجی",
  ready_to_install: "آماده نصب", backup_in_progress: "پشتیبان‌گیری", installing: "در حال نصب",
  restarting: "راه‌اندازی دوباره", success: "موفق", failed: "ناموفق", recovery_required: "نیازمند بازیابی",
};

function fmtDate(value: string | null): string {
  if (!value) return "—";
  try {
    return toPersianDigits(new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)));
  } catch { return "—"; }
}

function bytes(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${toPersianDigits((value / 1024 / 1024).toFixed(1))} مگابایت`;
}

function StatusBadge({ status }: { status: Compliance }) {
  const meta = STATUS[status];
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${meta.className}`}>{meta.label}</span>;
}

function ReleaseSummary({ release, onAction, busy }: { release: Release; onAction: (release: Release, action: "pilot" | "percentage" | "full" | "pause" | "withdraw") => void; busy: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs text-muted-foreground">کانال {CHANNEL_LABEL[release.channel]}</p>
          <p className="mt-1 font-bold" dir="ltr">{release.version}</p>
        </div>
        <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs">
          {release.status === "published" ? `انتشار ${toPersianDigits(String(release.rolloutPercentage))}٪` : release.status === "draft" ? "پیش‌نویس" : release.status === "paused" ? "متوقف" : "پس‌گرفته"}
        </span>
      </div>
      <div className="mt-3 space-y-1 text-xs text-muted-foreground">
        <p>ساخت: <code dir="ltr">{release.buildCommit.slice(0, 12)}</code></p>
        <p>انتشار: {fmtDate(release.releasedAt)}</p>
        <p>نصب‌کننده: {bytes(release.installer.size)}</p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {release.rolloutState !== "pilot" ? <Button variant="ghost" disabled={busy} onClick={() => onAction(release, "pilot")}>آزمایشی ۵٪</Button> : null}
        {release.rolloutState !== "percentage" || release.rolloutPercentage !== 25 ? <Button variant="ghost" disabled={busy} onClick={() => onAction(release, "percentage")}>انتشار ۲۵٪</Button> : null}
        {release.status !== "published" || release.rolloutState !== "full" ? <Button variant="ghost" disabled={busy} onClick={() => onAction(release, "full")}>انتشار کامل</Button> : null}
        {release.status === "published" ? <Button variant="ghost" disabled={busy} onClick={() => onAction(release, "pause")}>توقف</Button> : null}
        {release.status !== "withdrawn" ? <Button variant="danger" disabled={busy} onClick={() => onAction(release, "withdraw")}>پس‌گرفتن</Button> : null}
      </div>
    </div>
  );
}

function DeviceDetails({ device, open, onOpenChange }: { device: Device | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  if (!device) return null;
  const rows: Array<[string, string | number | null]> = [
    ["کسب‌وکار", device.businessName], ["شعبه", device.locationName], ["دستگاه", device.deviceName],
    ["شناسه عمومی", device.publicId], ["نسخه نصب‌شده", device.installedVersion], ["نسخه هدف", device.targetRelease?.version ?? null],
    ["Commit", device.buildCommit], ["Build ID", device.buildId], ["نسخه شِما", device.schemaVersion],
    ["Electron", device.electronVersion], ["سیستم", device.platform], ["کانال", CHANNEL_LABEL[device.channel]],
    ["آخرین مشاهده", fmtDate(device.lastSeenAt)], ["آخرین گزارش", fmtDate(device.lastReportAt)],
    ["آخرین Push موفق", fmtDate(device.lastSuccessfulPushAt)], ["آخرین Pull موفق", fmtDate(device.lastSuccessfulPullAt)],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>جزئیات نصب {device.deviceName}</DialogTitle>
          <DialogDescription>هویت دستگاه، زمان‌های دریافت‌شده در سرور و هدف انتشار مستقل از یکدیگر نمایش داده می‌شوند.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2"><StatusBadge status={device.compliance} /><span className="text-xs text-muted-foreground">ارتباط: {CONNECTIVITY_LABEL[device.connectivity]}</span></div>
        <dl className="grid gap-x-6 sm:grid-cols-2">
          {rows.map(([label, value]) => <div key={label} className="flex items-center justify-between gap-3 border-b border-border py-2 text-xs"><dt className="text-muted-foreground">{label}</dt><dd className="max-w-[65%] truncate font-medium" dir={/[A-Za-z0-9]/.test(String(value ?? "")) ? "ltr" : undefined}>{value ?? "—"}</dd></div>)}
        </dl>
        {device.updateEvents.length ? <div><h3 className="mb-2 text-sm font-semibold">تاریخچه چرخه به‌روزرسانی</h3><ol className="space-y-2 border-s border-border ps-4">{device.updateEvents.map((event, index) => <li key={`${event.reportedAt}-${index}`} className="relative text-xs"><span className="absolute -start-[1.2rem] top-1 size-2 rounded-full bg-primary" aria-hidden="true" /><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{UPDATE_STATE_LABEL[event.state] ?? event.state}</span><time className="text-muted-foreground">{fmtDate(event.reportedAt)}</time></div><p className="mt-1 text-muted-foreground" dir="ltr">{event.installedVersion ?? "—"} → {event.targetVersion ?? "—"}{event.errorCode ? ` · ${event.errorCode}` : ""}</p></li>)}</ol></div> : <p className="text-xs text-muted-foreground">هنوز رویداد چرخهٔ به‌روزرسانی گزارش نشده است.</p>}
        {device.targetRelease?.releaseNotes.length ? <div><h3 className="mb-2 text-sm font-semibold">یادداشت انتشار</h3><ul className="list-disc space-y-1 pe-5 text-xs text-muted-foreground">{device.targetRelease.releaseNotes.map((note) => <li key={note}>{note}</li>)}</ul></div> : null}
        {device.error ? <details className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs"><summary className="cursor-pointer font-medium text-destructive">جزئیات فنی خطا</summary><p className="mt-2" dir="ltr">{device.error.code}: {device.error.message ?? "—"}</p></details> : null}
      </DialogContent>
    </Dialog>
  );
}

export default function UpdatesPage() {
  const can = useCan();
  const canManage = can("updates.manage");
  const [data, setData] = useState<FleetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [channel, setChannel] = useState("");
  const [selected, setSelected] = useState<Device | null>(null);
  const [showReleaseForm, setShowReleaseForm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const response = await api<FleetResponse>("/api/platform/updates");
    if (response.ok) { setData(response.data); setError(""); }
    else setError("دریافت وضعیت نصب‌های دسکتاپ ممکن نشد.");
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const devices = useMemo(() => (data?.devices ?? []).filter((device) => {
    const q = search.trim().toLocaleLowerCase("fa");
    return (!q || `${device.businessName} ${device.locationName} ${device.deviceName} ${device.installedVersion ?? ""}`.toLocaleLowerCase("fa").includes(q))
      && (!status || device.compliance === status) && (!channel || device.channel === channel);
  }), [data, search, status, channel]);

  const currentReleases = useMemo(() => {
    const result: Partial<Record<Channel, Release>> = {};
    for (const release of data?.releases ?? []) {
      if (!result[release.channel] && release.status !== "withdrawn") result[release.channel] = release;
    }
    return result;
  }, [data]);

  async function releaseAction(release: Release, action: "pilot" | "percentage" | "full" | "pause" | "withdraw") {
    const label = action === "pilot" ? "انتشار آزمایشی ۵٪" : action === "percentage" ? "انتشار ۲۵٪" : action === "full" ? "انتشار کامل" : action === "pause" ? "توقف انتشار" : "پس‌گرفتن انتشار";
    if (!window.confirm(`${label} نسخه ${release.version} انجام شود؟`)) return;
    setBusy(true); setError("");
    const response = await api<{ release?: Release; error?: string }>(`/api/platform/updates/releases/${release.id}`, {
      method: "PATCH",
      body: JSON.stringify(action === "pilot"
        ? { status: "published", rolloutState: "pilot", rolloutPercentage: 5 }
        : action === "percentage"
          ? { status: "published", rolloutState: "percentage", rolloutPercentage: 25 }
          : action === "full"
            ? { status: "published", rolloutState: "full", rolloutPercentage: 100 }
            : action === "pause"
              ? { status: "paused", rolloutState: "paused", rolloutPercentage: 0 }
              : { status: "withdrawn", rolloutState: "paused", rolloutPercentage: 0 }),
    });
    if (!response.ok) setError("تغییر وضعیت انتشار انجام نشد.");
    else await load();
    setBusy(false);
  }

  async function createRelease(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    const response = await api<{ release?: Release; error?: string }>("/api/platform/updates", {
      method: "POST",
      body: JSON.stringify({
        ...body,
        status: "draft", rolloutState: "internal", rolloutPercentage: 0,
        installerSize: Number(body.installerSize),
        minimumSchemaVersion: body.minimumSchemaVersion ? Number(body.minimumSchemaVersion) : null,
        maximumSchemaVersion: body.maximumSchemaVersion ? Number(body.maximumSchemaVersion) : null,
        migrationVersion: body.migrationVersion ? Number(body.migrationVersion) : null,
        mandatory: false,
        releaseNotes: String(body.releaseNotes ?? "").split("\n").map((line) => line.trim()).filter(Boolean),
      }),
    });
    if (!response.ok) setError("ثبت انتشار انجام نشد؛ نسخه، هش، اندازه و نشانی HTTPS را بررسی کنید.");
    else { setShowReleaseForm(false); await load(); }
    setBusy(false);
  }

  if (loading && !data) return <PlatformPageSkeleton />;
  const summary = data?.summary ?? { installations: 0, upToDate: 0, updateAvailable: 0, offline: 0, problems: 0 };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-5">
        <div><h1 className="text-xl font-bold">انتشار و به‌روزرسانی دسکتاپ</h1><p className="mt-1 text-sm text-muted-foreground">نمای دستگاه‌به‌دستگاه بر پایهٔ گزارش احراز‌شده، SemVer و هدف کانال انتشار.</p></div>
        <div className="flex gap-2">{canManage ? <Button onClick={() => setShowReleaseForm((value) => !value)}>{showReleaseForm ? "بستن فرم" : "ثبت انتشار"}</Button> : null}<Button variant="ghost" onClick={() => void load()}><RefreshCwIcon className="size-4" />تازه‌سازی</Button></div>
      </div>
      <ErrorBox>{error}</ErrorBox>
      <InfoBox>نصب سبز فقط وقتی نمایش داده می‌شود که گزارش تازه، نسخهٔ SemVer قابل مقایسه و هدف انتشار شناخته‌شده باشد. SHA سرور مرکزی هیچ‌گاه نسخهٔ دسکتاپ محسوب نمی‌شود.</InfoBox>

      {showReleaseForm && canManage ? <Card title="ثبت پیش‌نویس انتشار امضاشده">
        <form onSubmit={createRelease} className="grid gap-x-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="نسخه SemVer"><input required name="version" className={inputClass} dir="ltr" placeholder="1.1.0" /></Field>
          <Field label="کانال"><select name="channel" className={selectClass}><option value="stable">پایدار</option><option value="beta">آزمایشی</option><option value="internal">داخلی</option></select></Field>
          <Field label="Commit"><input required name="buildCommit" className={inputClass} dir="ltr" /></Field>
          <Field label="Build ID"><input required name="buildId" className={inputClass} dir="ltr" /></Field>
          <Field label="نشانی HTTPS نصب‌کننده"><input required name="installerUrl" className={inputClass} dir="ltr" type="url" /></Field>
          <Field label="SHA-256"><input required name="installerSha256" className={inputClass} dir="ltr" minLength={64} maxLength={64} /></Field>
          <Field label="اندازه (بایت)"><input required name="installerSize" className={inputClass} dir="ltr" inputMode="numeric" /></Field>
          <Field label="حداقل نسخه پشتیبانی‌شده"><input name="minimumSupportedVersion" className={inputClass} dir="ltr" placeholder="1.0.3" /></Field>
          <Field label="ناشر مورد انتظار"><input required name="expectedPublisher" className={inputClass} /></Field>
          <div className="sm:col-span-2"><Field label="امضای RSA-SHA256 مانیفست"><textarea required name="manifestSignature" dir="ltr" rows={3} className={inputClass} /></Field></div>
          <Field label="نسخه مهاجرت"><input name="migrationVersion" className={inputClass} dir="ltr" inputMode="numeric" /></Field>
          <Field label="حداقل شِما"><input name="minimumSchemaVersion" className={inputClass} dir="ltr" inputMode="numeric" /></Field>
          <Field label="حداکثر شِما"><input name="maximumSchemaVersion" className={inputClass} dir="ltr" inputMode="numeric" /></Field>
          <div className="sm:col-span-2 lg:col-span-3"><Field label="یادداشت انتشار (هر مورد یک خط)"><textarea name="releaseNotes" className={`${inputClass} min-h-24 py-2`} /></Field></div>
          <div className="sm:col-span-2 lg:col-span-3"><Button type="submit" disabled={busy}>{busy ? "در حال ثبت…" : "ثبت پیش‌نویس"}</Button></div>
        </form>
      </Card> : null}

      <section aria-label="خلاصه ناوگان" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="نصب‌ها" value={toPersianDigits(String(summary.installations))} icon={<ServerCogIcon className="size-4" />} />
        <StatCard label="به‌روز" value={toPersianDigits(String(summary.upToDate))} tone="ok" />
        <StatCard label="به‌روزرسانی موجود" value={toPersianDigits(String(summary.updateAvailable))} tone="warn" />
        <StatCard label="آفلاین" value={toPersianDigits(String(summary.offline))} />
        <StatCard label="مشکل" value={toPersianDigits(String(summary.problems))} tone="bad" />
      </section>

      <Card title="انتشارهای هدف">
        {Object.keys(currentReleases).length === 0 ? <EmptyState title="هنوز انتشار فعالی ثبت نشده است" hint="تا آن زمان وضعیت نصب‌ها «نامشخص» می‌ماند و هرگز سبز نشان داده نمی‌شود." /> : <div className="grid gap-3 md:grid-cols-3">{(["stable", "beta", "internal"] as Channel[]).map((key) => currentReleases[key] ? <ReleaseSummary key={key} release={currentReleases[key]!} onAction={releaseAction} busy={busy} /> : <div key={key} className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">کانال {CHANNEL_LABEL[key]} هدف فعال ندارد.</div>)}</div>}
      </Card>

      <Card title="ناوگان نصب‌های محلی">
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <label className="relative"><span className="sr-only">جست‌وجو</span><SearchIcon className="pointer-events-none absolute start-3 top-3 size-4 text-muted-foreground" /><input value={search} onChange={(event) => setSearch(event.target.value)} className={`${inputClass} ps-9`} placeholder="کسب‌وکار، شعبه یا دستگاه" /></label>
          <select aria-label="فیلتر وضعیت" className={selectClass} value={status} onChange={(event) => setStatus(event.target.value)}><option value="">همه وضعیت‌ها</option>{Object.entries(STATUS).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}</select>
          <select aria-label="فیلتر کانال" className={selectClass} value={channel} onChange={(event) => setChannel(event.target.value)}><option value="">همه کانال‌ها</option>{Object.entries(CHANNEL_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        </div>
        {devices.length === 0 ? <EmptyState title="نصبی مطابق فیلترها پیدا نشد" hint={data?.devices.length ? "فیلترها را پاک کنید." : "پس از جفت‌سازی، دستگاه در این فهرست ظاهر می‌شود؛ گزارش نسخه با اولین ارتباط ثبت می‌شود."} /> : <>
          <div className="hidden overflow-x-auto md:block"><table className="w-full text-right text-sm"><thead><tr className="border-b border-border text-xs text-muted-foreground"><th className="px-3 py-3 font-medium">کسب‌وکار / شعبه</th><th className="px-3 py-3 font-medium">دستگاه</th><th className="px-3 py-3 font-medium">نصب‌شده</th><th className="px-3 py-3 font-medium">هدف</th><th className="px-3 py-3 font-medium">وضعیت</th><th className="px-3 py-3 font-medium">آخرین گزارش</th><th className="px-3 py-3 font-medium">عملیات</th></tr></thead><tbody>{devices.map((device) => <tr key={device.siteDeviceId} className="border-b border-border last:border-0 hover:bg-muted/50"><td className="px-3 py-3"><p className="font-medium">{device.businessName}</p><p className="text-xs text-muted-foreground">{device.locationName}</p></td><td className="px-3 py-3">{device.deviceName}</td><td className="px-3 py-3" dir="ltr">{device.installedVersion ?? "—"}</td><td className="px-3 py-3" dir="ltr">{device.targetRelease?.version ?? "—"}</td><td className="px-3 py-3"><StatusBadge status={device.compliance} /></td><td className="px-3 py-3 text-xs">{fmtDate(device.lastReportAt)}</td><td className="px-3 py-3"><Button variant="ghost" onClick={() => setSelected(device)}>جزئیات</Button></td></tr>)}</tbody></table></div>
          <div className="space-y-3 md:hidden">{devices.map((device) => <button key={device.siteDeviceId} type="button" onClick={() => setSelected(device)} className="w-full rounded-xl border border-border p-4 text-right transition-colors hover:bg-muted"><div className="flex items-start justify-between gap-2"><div><p className="font-medium">{device.businessName}</p><p className="mt-1 text-xs text-muted-foreground">{device.locationName} · {device.deviceName}</p></div><StatusBadge status={device.compliance} /></div><div className="mt-3 grid grid-cols-2 gap-2 text-xs"><p>نصب‌شده: <b dir="ltr">{device.installedVersion ?? "—"}</b></p><p>هدف: <b dir="ltr">{device.targetRelease?.version ?? "—"}</b></p><p className="col-span-2 text-muted-foreground">آخرین گزارش: {fmtDate(device.lastReportAt)}</p></div></button>)}</div>
        </>}
      </Card>
      <DeviceDetails device={selected} open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null); }} />
    </div>
  );
}
