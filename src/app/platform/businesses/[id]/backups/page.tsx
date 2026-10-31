"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useBusiness } from "../context";
import { api, Button, ErrorBox, InfoBox } from "../../../ui";
import { SectionCard, LoadingSkeleton, EmptyState } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableHead, DataTableBody, DataTableRow, Th, Td } from "@/app/dashboard/data-table";
import { toPersianDigits } from "@/lib/digits";
import type { BusinessBackupSummary } from "@/lib/business-backup-summary";

const STATUS = { running: "در حال اجرا", success: "تولید موفق", failed: "ناموفق" };
const PROFILE = { cloud: "ابری", hybrid: "ترکیبی", local: "محلی" };

interface ManagedInventory {
  profile: "cloud" | "hybrid" | "local";
  inventory: {
    total: number;
    items: {
      ref: string;
      capturedAt: string;
      origin: "scheduled" | "manual" | "uploaded";
      format: "physical_dump" | "logical_snapshot";
      destinations: { destination: "local" | "cloud" }[];
      state: "ready" | "uploading" | "verifying" | "failed" | "expired" | "unavailable_offline";
      integrity: "verified" | "unverified" | "failed";
      completeness: "complete" | "partial";
      encryption: "managed" | "legacy_passphrase";
      storedBytes: number;
    }[];
    summary: { cloudBytes: number; includedBytes: number; overageBytes: number };
  };
  custody: {
    scheme: "managed_envelope_v1" | "legacy_passphrase_v1" | "unconfigured";
    activeVersion: number | null;
    versions: { version: number; status: "active" | "retired" | "revoked" }[];
    legacyArtifacts: boolean;
  };
  labels: {
    state: Record<string, string>;
    format: Record<string, string>;
    origin: Record<string, string>;
    completeness: Record<string, string>;
  };
  metadataOnly: true;
}

const CUSTODY = {
  managed_envelope_v1: "رمزنگاری مدیریت‌شده (کلید سکو)",
  legacy_passphrase_v1: "رمزنگاری قدیمی با گذرواژهٔ مالک",
  unconfigured: "کلید رمزنگاری سکو تنظیم نشده است",
};

/**
 * Issue #903 §3 — the diagnosis the operator acts on. Codes, not prose, so the
 * console owns the wording; `actions` is empty for a healthy business.
 */
interface Diagnosis {
  destination: { mode: "managed" | "legacy" | "unavailable"; reason: string | null };
  custody: { keyVersion: number | null; kekAvailable: boolean } | null;
  policy: {
    intervalHours: number;
    retentionDays: number;
    source: "managed" | "default";
    /** True when a Superadmin override applies to this business instead of the fleet row. */
    override?: boolean;
    /** Whether a destructive restore needs a Superadmin approval here. */
    requireRestoreApproval?: boolean;
  };
  storage: { includedBytes: number };
  queue: { pending: number };
  device: { connectivity: "online" | "offline" | "unknown"; lastSeenAt: string | null };
  artifacts: Record<string, number> & { total: number };
  actions: string[];
}

const DESTINATION = { managed: "سرویس مدیریت‌شدهٔ سکو", legacy: "سطل قدیمی نصب", unavailable: "در دسترس نیست" };
const CONNECTIVITY = { online: "آنلاین", offline: "آفلاین", unknown: "نامشخص" };
const ACTION_LABELS: Record<string, string> = {
  destination_not_configured: "مقصد ابری برای این کسب‌وکار تنظیم نشده است.",
  destination_unreadable: "مقصد ذخیره‌سازی خوانده نشد؛ اعتبارنامه یا دسترسی را بررسی کنید.",
  custody_unavailable: "کلید رمزنگاری سکو در دسترس نیست؛ نسخهٔ جدید قابل ساخت نیست.",
  artifacts_failed: "برخی نسخه‌ها در وضعیت خطا هستند؛ «بررسی» را اجرا کنید.",
  artifacts_never_verified: "هیچ نسخه‌ای تأیید نشده است؛ بنابراین هیچ نسخه‌ای قابل بازگردانی نیست.",
  uploads_pending: "بارگذاری‌هایی در صف باقی مانده‌اند؛ «تلاش مجدد» را اجرا کنید.",
  uploads_dead: "آخرین تلاش بارگذاری خطا داشته است.",
  device_offline: "دستگاه از آخرین همگام‌سازی فاصله دارد؛ دسترسی به فایل‌های محلی تأیید نشده است.",
  no_artifact_yet: "هنوز هیچ نسخه‌ای ثبت نشده است.",
  cloud_unverified:
    "نسخهٔ ابری هنوز دوباره خوانده و تأیید نشده است؛ تا آن زمان قابل بازگردانی نیست. بررسی خودکار در ساعت بعد اجرا می‌شود.",
  drill_failed:
    "آزمایش بازیابی زمان‌بندی‌شده ناموفق بود: نسخهٔ ثبت‌شده باز نشد یا بازیابی آن مجاز نیست. پیش از نیاز واقعی بررسی کنید.",
};

export default function BusinessBackupsPage() {
  const { id, version } = useBusiness();
  const [summary, setSummary] = useState<BusinessBackupSummary | null>(null);
  const [managed, setManaged] = useState<ManagedInventory | null>(null);
  const [managedError, setManagedError] = useState(false);
  const [error, setError] = useState(false);
  // Bumped after an operator action so the inventory and its diagnosis re-read
  // the same truth the button just changed.
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    setSummary(null);
    setError(false);
    void api<{ summary: BusinessBackupSummary }>(`/api/platform/businesses/${id}/backups`).then((res) => {
      if (!active) return;
      if (res.ok) setSummary(res.data.summary);
      else setError(true);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [id, version, refresh]);

  useEffect(() => {
    let active = true;
    setManaged(null);
    setManagedError(false);
    void api<ManagedInventory>(`/api/platform/businesses/${id}/backups/artifacts`).then((res) => {
      if (!active) return;
      if (res.ok) setManaged(res.data);
      else setManagedError(true);
    }).catch(() => { if (active) setManagedError(true); });
    return () => { active = false; };
  }, [id, version, refresh]);

  return (
    <div className="space-y-4">
      <SectionCard title="پشتیبان‌گیری کسب‌وکار">
        <InfoBox>این بخش فقط فرادادهٔ ثبت‌شدهٔ همین کسب‌وکار را نمایش می‌دهد؛ نسخه‌های بازیابی کل سکو در این فهرست نیستند. موفقیت تولید فایل به معنی تأیید قابلیت بازگردانی یا دسترسی فعلی به آن نیست.</InfoBox>
        {error ? <ErrorBox>دریافت اطلاعات ممکن نشد یا مجوز مشاهده ندارید.</ErrorBox> : !summary ? <LoadingSkeleton rows={3} /> : (
          <div className="space-y-4">
            <p className="text-sm">نوع استقرار: {PROFILE[summary.profile]}</p>
            {summary.deviceAvailability === "unknown" ? <InfoBox>وضعیت اتصال دستگاه و تازگی فراداده مشخص نیست. دسترسی به فایل‌های محلی تأیید نشده است؛ این گزارش تضمین آنلاین بودن دستگاه نیست.</InfoBox> : null}
            <Link className="text-sm underline" href={`/platform/businesses/${id}/billing`}>مشاهدهٔ اشتراک، اعتبار و صورت‌حساب در بخش مالی</Link>
            {summary.runs.length === 0 ? <EmptyState title="هنوز گزارشی ثبت نشده است">نبود گزارش به معنی نبود نسخهٔ محلی روی دستگاه نیست.</EmptyState> : (
              <DataTable caption="تاریخچهٔ پشتیبان‌گیری کسب‌وکار" tableClassName="min-w-[640px]">
                <DataTableHead><Th>زمان ثبت</Th><Th>مقصد ثبت‌شده</Th><Th>نوع داده</Th><Th>وضعیت</Th><Th numeric>حجم (بایت)</Th></DataTableHead>
                <DataTableBody>{summary.runs.map((run) => (
                  <DataTableRow key={run.id}>
                    <Td>{new Date(run.startedAt).toLocaleString("fa-IR")}</Td>
                    <Td>{run.destination === "local" ? "محلی" : "ابری"}</Td>
                    <Td>{run.scope === "logical" ? "داده‌های کسب‌وکار" : "پایگاه‌دادهٔ نصب"}</Td>
                    <Td>{STATUS[run.status]}{run.hasError ? " — نیازمند بررسی" : ""}</Td>
                    <Td numeric>{run.sizeBytes === null ? "—" : toPersianDigits(String(run.sizeBytes))}</Td>
                  </DataTableRow>
                ))}</DataTableBody>
              </DataTable>
            )}
          </div>
        )}
      </SectionCard>

      <OperationsCard id={id} onChanged={() => setRefresh((value) => value + 1)} />

      <SectionCard
        title="نسخه‌های مدیریت‌شده و رمزنگاری"
        description="فهرست نسخه‌های ثبت‌شدهٔ همین کسب‌وکار در سرویس پشتیبان‌گیری مدیریت‌شده، همراه با نسل کلید رمزنگاری. این جدول تنها فراداده است و کلید یا نشانی ذخیره‌سازی را نمایش نمی‌دهد."
      >
        {managedError ? <ErrorBox>دریافت فهرست نسخه‌های مدیریت‌شده ممکن نشد یا مجوز آن را ندارید.</ErrorBox> : !managed ? <LoadingSkeleton rows={3} /> : (
          <div className="space-y-4">
            <p className="text-sm">
              رمزنگاری: {CUSTODY[managed.custody.scheme]}
              {managed.custody.activeVersion !== null
                ? ` · نسل فعال کلید: ${toPersianDigits(String(managed.custody.activeVersion))}`
                : ""}
              {managed.custody.legacyArtifacts ? " · برخی نسخه‌های قدیمی با گذرواژهٔ مالک رمزنگاری شده‌اند" : ""}
            </p>
            <p className="text-sm text-muted-foreground">
              فضای ابری مصرف‌شده: {toPersianDigits(String(managed.inventory.summary.cloudBytes))} بایت · سهمیهٔ پلن:{" "}
              {toPersianDigits(String(managed.inventory.summary.includedBytes))} بایت · مازاد:{" "}
              {toPersianDigits(String(managed.inventory.summary.overageBytes))} بایت
            </p>
            {managed.inventory.items.length === 0 ? (
              <EmptyState title="نسخهٔ مدیریت‌شده‌ای ثبت نشده است">
                نسخه‌هایی که پیش از این بخش ساخته شده‌اند در فهرست فرادادهٔ بالا دیده می‌شوند، نه در این جدول.
              </EmptyState>
            ) : (
              <DataTable caption="نسخه‌های مدیریت‌شدهٔ کسب‌وکار" tableClassName="min-w-[720px]">
                <DataTableHead>
                  <Th>زمان تهیه</Th>
                  <Th>نوع</Th>
                  <Th>محل نگهداری</Th>
                  <Th>وضعیت</Th>
                  <Th>اعتبار</Th>
                  <Th>رمزنگاری</Th>
                  <Th numeric>حجم (بایت)</Th>
                  <Th>عملیات</Th>
                </DataTableHead>
                <DataTableBody>
                  {managed.inventory.items.map((item) => (
                    <DataTableRow key={item.ref}>
                      <Td>{new Date(item.capturedAt).toLocaleString("fa-IR")}</Td>
                      <Td>
                        {managed.labels.format[item.format]} · {managed.labels.completeness[item.completeness]}
                      </Td>
                      <Td>
                        {item.destinations.some((destination) => destination.destination === "cloud")
                          ? item.destinations.some((destination) => destination.destination === "local")
                            ? "محلی و ابری"
                            : "ابری"
                          : "محلی"}
                      </Td>
                      <Td>{managed.labels.state[item.state]}</Td>
                      <Td>{item.integrity === "verified" ? "تأییدشده" : item.integrity === "failed" ? "خطا" : "تأییدنشده"}</Td>
                      <Td>{item.encryption === "managed" ? "مدیریت‌شده" : "گذرواژهٔ مالک"}</Td>
                      <Td numeric>{toPersianDigits(String(item.storedBytes))}</Td>
                      <Td>
                        <ArtifactActions
                          id={id}
                          artifactRef={item.ref}
                          onChanged={() => setRefresh((value) => value + 1)}
                        />
                      </Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            )}
            <InfoBox>
              تولید موفق یک نسخه، تأیید بازیابی آن نیست. بازگردانی این کسب‌وکار در استقرار مرکزی فقط به‌صورت منطقی و
              محدود به همین کسب‌وکار انجام می‌شود؛ اجرای آن با تأیید صریح و ورود دوبارهٔ مالک کسب‌وکار است و پیش از هر
              تغییری از داده‌های فعلی نقطهٔ بازیابی ساخته می‌شود. این صفحه خودش هیچ بازگردانی‌ای آغاز نمی‌کند.
            </InfoBox>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

/**
 * Issue #903 §3 — "trigger/create" and "retry/catch-up", with the diagnosis that
 * explains why the operator is here. Both buttons call the routes that call the
 * shipped pipeline; neither invents a second one.
 */
function OperationsCard({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<"run" | "catch_up" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ diagnosis: Diagnosis }>(`/api/platform/businesses/${id}/backups/diagnose`);
    if (res.ok) {
      setDiagnosis(res.data.diagnosis);
      setError(false);
    } else setError(true);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: "run" | "catch_up") {
    setBusy(action);
    setNotice(null);
    const res = await api<{ uploaded?: number; remaining?: number }>(
      `/api/platform/businesses/${id}/backups/run`,
      { method: "POST", body: JSON.stringify({ action }) },
    );
    setBusy(null);
    if (!res.ok) {
      setNotice(
        action === "run"
          ? "اجرای پشتیبان‌گیری ناموفق بود؛ گزارش خطا در فهرست نسخه‌ها ثبت شده است."
          : "تلاش مجدد بارگذاری ناموفق بود؛ مقصد ذخیره‌سازی را بررسی کنید.",
      );
    } else if (action === "run") {
      setNotice("اجرا انجام شد؛ نتیجه در فهرست نسخه‌ها و تاریخچه دیده می‌شود.");
    } else {
      setNotice(
        `بارگذاری‌ها: ${toPersianDigits(String(res.data.uploaded ?? 0))} موفق، ${toPersianDigits(String(res.data.remaining ?? 0))} در صف.`,
      );
    }
    await load();
    onChanged();
  }

  return (
    <SectionCard
      title="عملیات سرویس"
      description="اجرای فوری و تلاش مجدد بارگذاری برای همین کسب‌وکار، از همان مسیر سرویس مدیریت‌شده. این عملیات فقط همین کسب‌وکار را تغییر می‌دهد و هیچ نسخه‌ای از سکو را لمس نمی‌کند."
    >
      {error ? <ErrorBox>دریافت تشخیص سرویس ممکن نشد یا مجوز آن را ندارید.</ErrorBox> : !diagnosis ? <LoadingSkeleton rows={2} /> : (
        <div className="space-y-4">
          <dl className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-2 sm:justify-start">
              <dt className="text-muted-foreground">مقصد ذخیره‌سازی:</dt>
              <dd>{DESTINATION[diagnosis.destination.mode]}</dd>
            </div>
            <div className="flex justify-between gap-2 sm:justify-start">
              <dt className="text-muted-foreground">زمان‌بندی سیاست سکو:</dt>
              <dd>هر {toPersianDigits(String(diagnosis.policy.intervalHours))} ساعت</dd>
            </div>
            <div className="flex justify-between gap-2 sm:justify-start">
              <dt className="text-muted-foreground">نگهداری:</dt>
              <dd>{toPersianDigits(String(diagnosis.policy.retentionDays))} روز</dd>
            </div>
            <div className="flex justify-between gap-2 sm:justify-start">
              <dt className="text-muted-foreground">منبع سیاست:</dt>
              <dd>
                {diagnosis.policy.override
                  ? "بازنویسی این کسب‌وکار"
                  : diagnosis.policy.source === "managed"
                    ? "سیاست سراسری سکو"
                    : "پیش‌فرض ایمن دستگاه"}
              </dd>
            </div>
            <div className="flex justify-between gap-2 sm:justify-start">
              <dt className="text-muted-foreground">تأیید بازگردانی:</dt>
              <dd>{diagnosis.policy.requireRestoreApproval ? "لازم است" : "لازم نیست"}</dd>
            </div>
            <div className="flex justify-between gap-2 sm:justify-start">
              <dt className="text-muted-foreground">کلید رمزنگاری:</dt>
              <dd>
                {diagnosis.custody === null
                  ? "نامشخص"
                  : diagnosis.custody.kekAvailable
                    ? diagnosis.custody.keyVersion === null
                      ? "آماده (بدون نسل فعال)"
                      : `نسل ${toPersianDigits(String(diagnosis.custody.keyVersion))}`
                    : "در دسترس نیست"}
              </dd>
            </div>
            <div className="flex justify-between gap-2 sm:justify-start">
              <dt className="text-muted-foreground">صف بارگذاری:</dt>
              <dd>{toPersianDigits(String(diagnosis.queue.pending))} مورد</dd>
            </div>
            <div className="flex justify-between gap-2 sm:justify-start">
              <dt className="text-muted-foreground">دستگاه:</dt>
              <dd>{CONNECTIVITY[diagnosis.device.connectivity]}</dd>
            </div>
          </dl>

          {diagnosis.actions.length > 0 ? (
            <ul className="space-y-1 text-sm text-amber-700 dark:text-amber-300">
              {diagnosis.actions.map((code) => (
                <li key={code}>{ACTION_LABELS[code] ?? code}</li>
              ))}
            </ul>
          ) : (
            <InfoBox>هیچ مورد نیازمند اقدام دیده نمی‌شود.</InfoBox>
          )}

          {notice ? <InfoBox>{notice}</InfoBox> : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => act("run")} disabled={busy !== null}>
              {busy === "run" ? "در حال اجرا…" : "اجرای پشتیبان‌گیری"}
            </Button>
            <Button variant="ghost" onClick={() => act("catch_up")} disabled={busy !== null}>
              {busy === "catch_up" ? "در حال تلاش…" : "تلاش مجدد بارگذاری‌ها"}
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

/**
 * Issue #903 §3 — per-artifact verify, download and retention delete. Deleting
 * needs a second click, and the server refuses to cross the protected recovery
 * floor regardless of what this button offers.
 */
function ArtifactActions({
  id,
  artifactRef,
  onChanged,
}: {
  id: string;
  artifactRef: string;
  onChanged: () => void;
}) {
  const base = `/api/platform/businesses/${id}/backups/artifacts/${encodeURIComponent(artifactRef)}`;
  const [busy, setBusy] = useState<"verify" | "delete" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function verify() {
    setBusy("verify");
    setMessage(null);
    const res = await api<{ tables?: number; error?: string }>(`${base}/verify`, { method: "POST" });
    setBusy(null);
    setMessage(
      res.ok
        ? `بررسی موفق بود؛ ${toPersianDigits(String(res.data.tables ?? 0))} مجموعهٔ داده تأیید شد.`
        : res.data.error === "artifact_missing"
          ? "فایل این نسخه روی مقصد نیست."
          : "بررسی ناموفق بود؛ این نسخه قابل بازگردانی نیست.",
    );
    onChanged();
  }

  async function remove() {
    setBusy("delete");
    setMessage(null);
    const res = await api<{ deletedBytes?: boolean; error?: string }>(base, { method: "DELETE" });
    setBusy(null);
    setConfirming(false);
    setMessage(
      res.ok
        ? "نسخه حذف شد؛ ردیف آن برای تاریخچه باقی می‌ماند."
        : res.data.error === "protected_copies"
          ? "حذف انجام نشد: این آخرین نسخهٔ بازیابی‌شدهٔ محافظت‌شدهٔ این کسب‌وکار است."
          : "حذف انجام نشد؛ ذخیره‌سازی پاسخ نداد.",
    );
    onChanged();
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        <Button variant="ghost" onClick={verify} disabled={busy !== null}>
          {busy === "verify" ? "…" : "بررسی"}
        </Button>
        <a
          className="inline-flex h-9 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold hover:bg-muted"
          href={base}
          download
        >
          دانلود
        </a>
        {confirming ? (
          <Button variant="danger" onClick={remove} disabled={busy !== null}>
            {busy === "delete" ? "…" : "تأیید حذف"}
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => setConfirming(true)} disabled={busy !== null}>
            حذف
          </Button>
        )}
      </div>
      {message ? <p className="max-w-[16rem] text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}
