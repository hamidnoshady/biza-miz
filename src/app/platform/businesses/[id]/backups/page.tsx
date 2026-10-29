"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useBusiness } from "../context";
import { api, ErrorBox, InfoBox } from "../../../ui";
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

export default function BusinessBackupsPage() {
  const { id, version } = useBusiness();
  const [summary, setSummary] = useState<BusinessBackupSummary | null>(null);
  const [managed, setManaged] = useState<ManagedInventory | null>(null);
  const [managedError, setManagedError] = useState(false);
  const [error, setError] = useState(false);

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
  }, [id, version]);

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
  }, [id, version]);

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
