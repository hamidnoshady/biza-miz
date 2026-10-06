"use client";

/**
 * «تاریخچه» — every import and every export this business has run.
 *
 * A bulk read or write of the business's data is a privacy event, so the
 * history is not a convenience: it is the record of who moved what, when, how
 * many rows, and what came of them. Two things hang off it that make it worth
 * reading rather than merely keeping:
 *
 *  - a failed import's rejected rows download as a CSV of the operator's OWN
 *    cells plus a reason column, so they fix it in place and re-upload;
 *  - a previous export downloads again from here, without re-running it
 *    against data that has moved since.
 *
 * It polls while anything is in flight, which is what makes the queued import
 * non-blocking: the operator confirms, leaves, and watches progress here.
 */

import { useCallback, useEffect, useState } from "react";
import { HistoryIcon, RefreshCwIcon } from "lucide-react";
import { EmptyState, LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import { ErrorBox, SecondaryButton, api } from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
import { EXPORT_FORMAT_LABELS, IMPORT_FORMAT_LABELS } from "@/lib/data-transfer/types";
import {
  Count,
  ExportStatusBadge,
  ImportStatusBadge,
  JalaliCell,
  dataError,
  formatBytes,
  type ExportJobView,
  type ImportJobView,
} from "./data-transfer-ui";

/** How often to re-read while a job is queued or running. */
const POLL_MS = 5_000;

export function HistorySection({
  canImport,
  revision,
}: {
  canImport: boolean;
  revision: number;
}) {
  const [imports, setImports] = useState<ImportJobView[] | null>(null);
  const [exports, setExports] = useState<ExportJobView[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [importResult, exportResult] = await Promise.all([
      canImport
        ? api<{ jobs: ImportJobView[]; error?: string }>("/api/data/imports")
        : Promise.resolve({ ok: true, data: { jobs: [] as ImportJobView[] } }),
      api<{ jobs: ExportJobView[]; error?: string }>("/api/data/exports"),
    ]);
    if (importResult.ok) setImports(importResult.data.jobs);
    else setImports([]);
    if (exportResult.ok) setExports(exportResult.data.jobs);
    else setExports([]);
  }, [canImport]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  // Poll only while something is actually moving. A history of finished jobs
  // is static, and a timer that keeps firing against it is a request every
  // five seconds for nothing.
  const inFlight =
    (imports ?? []).some((job) => job.status === "queued" || job.status === "running") ||
    (exports ?? []).some((job) => job.status === "queued" || job.status === "running");

  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, load]);

  async function retry(jobId: string) {
    setBusy(jobId);
    const { ok, data } = await api<{ error?: string }>(`/api/data/imports/${jobId}`, {
      method: "POST",
      body: JSON.stringify({ action: "retry" }),
    });
    setBusy(null);
    if (!ok) {
      setError(dataError(data.error));
      return;
    }
    setError("");
    void load();
  }

  return (
    <div className="space-y-6">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      {canImport ? (
        <SectionCard
          title="تاریخچهٔ ورود اطلاعات"
          description="هر فایلی که وارد شده، با تعداد رکوردهای ساخته‌شده، به‌روزرسانی‌شده و ردشده."
          actions={
            <SecondaryButton onClick={() => void load()}>
              <RefreshCwIcon className="size-4" aria-hidden="true" />
              به‌روزرسانی
            </SecondaryButton>
          }
        >
          {imports === null ? (
            <LoadingSkeleton rows={4} />
          ) : imports.length === 0 ? (
            <EmptyState icon={HistoryIcon} title="هنوز فایلی وارد نشده است">
              پس از اولین ورود اطلاعات، سابقهٔ آن اینجا می‌ماند.
            </EmptyState>
          ) : (
            <DataTable caption="تاریخچهٔ ورود اطلاعات">
              <DataTableHead>
                <tr>
                  <Th>تاریخ</Th>
                  <Th>نوع داده</Th>
                  <Th>فایل</Th>
                  <Th>وضعیت</Th>
                  <Th>نتیجه</Th>
                  <Th>کاربر</Th>
                  <Th> </Th>
                </tr>
              </DataTableHead>
              <DataTableBody>
                {imports.map((job) => (
                  <DataTableRow key={job.id}>
                    <Td>
                      <JalaliCell value={job.createdAt} />
                    </Td>
                    <Td>{job.entityLabel}</Td>
                    <Td>
                      <span className="break-all">{job.fileName}</span>
                      {job.providerMetadata ? (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          هلو · {job.providerMetadata.sourceFormat === "connected_sql" ? "اتصال" : "فایل XLSX"} · {job.providerMetadata.profileKey} v{job.providerMetadata.profileVersion}
                          {job.providerMetadata.connectionName ? ` · ${job.providerMetadata.connectionName}` : ""}
                        </span>
                      ) : (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {IMPORT_FORMAT_LABELS[job.fileFormat as keyof typeof IMPORT_FORMAT_LABELS] ?? (job.fileFormat === "provider" ? "اتصال متصل" : job.fileFormat.toUpperCase())} · <Count value={job.totalRows} /> سطر
                        </span>
                      )}
                    </Td>
                    <Td>
                      <ImportStatusBadge status={job.status} />
                      {job.error ? (
                        <span className="mt-0.5 block text-xs text-destructive">
                          {job.providerMetadata?.outcome === "partial_failure"
                            ? "مهاجرت بخشی از داده‌ها را ثبت کرد؛ اجرای هلو را بررسی یا rollback کنید."
                            : job.error}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      {job.providerMetadata ? (
                        <span className="text-xs leading-5">
                          {toPersianDigits(job.createdRows)} ساخته‌شده، {toPersianDigits(job.updatedRows)} نگاشت‌شده، {toPersianDigits(job.skippedRows)} تکراری/ردشده
                          {job.providerMetadata.discrepancyCount != null ? ` · مغایرت: ${toPersianDigits(job.providerMetadata.discrepancyCount)}` : ""}
                          {job.providerMetadata.rollbackState === "rolled_back" ? " · برگشت‌خورده" : ""}
                        </span>
                      ) : job.status === "completed" ? (
                        <span className="text-xs leading-5">
                          {toPersianDigits(job.createdRows)} ساخته‌شده،{" "}
                          {toPersianDigits(job.updatedRows)} به‌روز،{" "}
                          {toPersianDigits(job.skippedRows)} ردشده،{" "}
                          {toPersianDigits(job.failedRows)} ناموفق
                        </span>
                      ) : (
                        <span className="text-xs leading-5 text-muted-foreground">
                          {toPersianDigits(job.validRows)} معتبر،{" "}
                          {toPersianDigits(job.errorRows)} نامعتبر
                        </span>
                      )}
                    </Td>
                    <Td>{job.createdByName || "—"}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-2">
                        {!job.providerMetadata && job.errorRows + job.failedRows > 0 ? (
                          <SecondaryButton
                            onClick={() => {
                              window.location.href = `/api/data/imports/${job.id}/errors`;
                            }}
                          >
                            گزارش خطا
                          </SecondaryButton>
                        ) : null}
                        {!job.providerMetadata && job.failedRows > 0 && job.status === "completed" ? (
                          <SecondaryButton
                            onClick={() => retry(job.id)}
                            disabled={busy === job.id}
                          >
                            تلاش دوباره
                          </SecondaryButton>
                        ) : null}
                      </div>
                    </Td>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          )}
        </SectionCard>
      ) : null}

      <SectionCard
        title="تاریخچهٔ خروجی‌ها"
        description="خروجی‌های ساخته‌شده تا سی روز قابل دانلود دوباره‌اند؛ پس از آن فقط سابقهٔ آن‌ها می‌ماند."
      >
        {exports === null ? (
          <LoadingSkeleton rows={4} />
        ) : exports.length === 0 ? (
          <EmptyState icon={HistoryIcon} title="هنوز خروجی‌ای ساخته نشده است">
            هر خروجی که بسازید — دستی یا زمان‌بندی‌شده — اینجا ثبت می‌شود.
          </EmptyState>
        ) : (
          <DataTable caption="تاریخچهٔ خروجی‌های ساخته‌شده">
            <DataTableHead>
              <tr>
                <Th>تاریخ</Th>
                <Th>نوع داده</Th>
                <Th>قالب</Th>
                <Th>سطرها</Th>
                <Th>حجم</Th>
                <Th>وضعیت</Th>
                <Th>کاربر</Th>
                <Th> </Th>
              </tr>
            </DataTableHead>
            <DataTableBody>
              {exports.map((job) => (
                <DataTableRow key={job.id}>
                  <Td>
                    <JalaliCell value={job.createdAt} />
                  </Td>
                  <Td>
                    {job.entityLabel}
                    {job.providerMetadata ? (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        هلو · {job.providerMetadata.profileKey} v{job.providerMetadata.profileVersion}
                        {job.providerMetadata.connectionName ? ` · ${job.providerMetadata.connectionName}` : ""}
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    {job.providerMetadata
                      ? job.providerMetadata.sourceFormat === "connected_outbox" ? "ارسال متصل" : "Excel پروفایل هلو"
                      : job.format === "provider" ? "ارسال متصل" : EXPORT_FORMAT_LABELS[job.format]}
                  </Td>
                  <Td>
                    <Count value={job.rowCount} />
                  </Td>
                  <Td>{job.sizeBytes > 0 ? formatBytes(job.sizeBytes) : "—"}</Td>
                  <Td>
                    <ExportStatusBadge status={job.status} />
                    {job.scheduleId ? (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        زمان‌بندی‌شده
                      </span>
                    ) : null}
                  </Td>
                  <Td>{job.createdByName || "—"}</Td>
                  <Td>
                    {job.downloadable ? (
                      <SecondaryButton
                        onClick={() => {
                          window.location.href = `/api/data/exports/${job.id}`;
                        }}
                      >
                        دانلود دوباره
                      </SecondaryButton>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {job.providerMetadata?.sourceFormat === "connected_outbox" ? "بدون فایل؛ وضعیت ارسال ثبت است" : "فایل نگه‌داری نمی‌شود"}
                      </span>
                    )}
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>
    </div>
  );
}
