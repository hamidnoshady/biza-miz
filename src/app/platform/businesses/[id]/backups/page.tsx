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

export default function BusinessBackupsPage() {
  const { id, version } = useBusiness();
  const [summary, setSummary] = useState<BusinessBackupSummary | null>(null);
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
  return (
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
  );
}
