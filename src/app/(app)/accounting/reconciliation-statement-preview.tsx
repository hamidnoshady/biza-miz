"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { api, ErrorBox, errorMessage, SecondaryButton } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { MAX_STATEMENT_IMPORT_BYTES, type StatementMatchPreviewLine } from "@/lib/reconciliation-statement-import";
import { accountingSectionHref } from "./accounting-routes";
import { fmtJalali } from "./ledger-ui";

const MATCH_LABELS: Record<StatementMatchPreviewLine["status"], string> = {
  matched: "یک سند پیشنهادی",
  ambiguous: "چند تطبیق ممکن",
  unmatched: "بدون سند قابل تطبیق",
};

function previewError(body: { error?: string; rowNumber?: number }): string {
  switch (body.error) {
    case "invalid_statement_header":
      return "سرستون‌های فایل باید date,amount_rial باشند.";
    case "invalid_statement_row_count":
      return "فایل باید بین ۱ تا ۵۰۰ ردیف گردش داشته باشد.";
    case "invalid_statement_row":
      return `تاریخ یا مبلغ ردیف ${toPersianDigits(body.rowNumber ?? "—")} معتبر نیست.`;
    case "payload_too_large":
      return "اندازهٔ فایل بیشتر از حد مجاز است.";
    default:
      return errorMessage(body.error);
  }
}

export function ReconciliationStatementPreview({
  reconciliationId,
  onApplied,
  disabled,
}: {
  reconciliationId: string;
  onApplied: () => void;
  disabled?: boolean;
}) {
  const money = useMoney();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [lines, setLines] = useState<StatementMatchPreviewLine[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const matches = (lines ?? []).flatMap((line) =>
    line.journalLineId && !excluded.has(line.journalLineId) ? [line.journalLineId] : [],
  );

  async function preview() {
    if (!file) return;
    setError("");
    setLines(null);
    setExcluded(new Set());
    if (file.size >= MAX_STATEMENT_IMPORT_BYTES) {
      setError(previewError({ error: "payload_too_large" }));
      return;
    }
    setBusy(true);
    try {
      const csv = await file.text();
      const { ok, data } = await api<{ lines: StatementMatchPreviewLine[]; error?: string; rowNumber?: number }>(
        `/api/ledger/reconciliations/${reconciliationId}/statement-preview`,
        { method: "POST", body: JSON.stringify({ csv }) },
      );
      if (ok) setLines(data.lines);
      else setError(previewError(data));
    } catch {
      setError("خواندن فایل صورتحساب ناموفق بود.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!matches.length) return;
    setBusy(true);
    setError("");
    try {
      const { ok, data } = await api<{ error?: string }>(`/api/ledger/reconciliations/${reconciliationId}/lines`, {
        method: "PATCH",
        body: JSON.stringify({ journalLineIds: matches, cleared: true }),
      });
      if (ok) {
        setLines(null);
        setFile(null);
        if (fileInput.current) fileInput.current.value = "";
        onApplied();
      } else {
        setError(errorMessage(data.error));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="rounded-xl border border-border p-3">
      <summary className="cursor-pointer text-sm font-semibold">پیشنهاد تطبیق از فایل CSV</summary>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        فایل UTF-8 با سرستون‌های <bdi dir="ltr">date,amount_rial</bdi> بارگذاری کنید.
        تاریخ باید میلادی به صورت <bdi dir="ltr">YYYY-MM-DD</bdi> و مبلغ صحیح ریالی باشد.
        دریافت را مثبت و پرداخت را منفی بنویسید. فقط تطبیق‌های یکتا پس از تأیید شما ثبت می‌شوند.
      </p>
      <div className="my-3 flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          aria-label="فایل صورتحساب CSV"
          disabled={busy || disabled}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setLines(null);
            setError("");
          }}
          className="max-w-full text-sm"
        />
        <SecondaryButton disabled={!file || busy || disabled} onClick={preview}>پیش‌نمایش تطبیق</SecondaryButton>
      </div>
      <ErrorBox>{error}</ErrorBox>
      {lines ? (
        <div className="space-y-3">
          <div className="max-h-64 overflow-auto">
            <DataTable caption="پیشنهادهای تطبیق فایل">
              <DataTableHead>
                <tr><Th>انتخاب</Th><Th>ردیف</Th><Th>تاریخ</Th><Th numeric>مبلغ ({money.unitLabel})</Th><Th>وضعیت</Th></tr>
              </DataTableHead>
              <DataTableBody>
                {lines.map((line) => (
                  <DataTableRow key={line.rowNumber}>
                    <Td>{line.journalLineId ? (
                      <input
                        type="checkbox"
                        checked={!excluded.has(line.journalLineId)}
                        disabled={busy || disabled}
                        aria-label={`تطبیق ردیف ${toPersianDigits(line.rowNumber)}`}
                        onChange={(event) => {
                          const id = line.journalLineId!;
                          const include = event.target.checked;
                          setExcluded((previous) => {
                            const next = new Set(previous);
                            if (include) next.delete(id);
                            else next.add(id);
                            return next;
                          });
                        }}
                      />
                    ) : "—"}</Td>
                    <Td>{toPersianDigits(line.rowNumber)}</Td>
                    <Td>{fmtJalali(line.date)}</Td>
                    <Td numeric>{money.formatText(line.amountRial)}</Td>
                    <Td>{line.entryId ? (
                      <Link
                        href={`${accountingSectionHref("entries")}?entryId=${encodeURIComponent(line.entryId)}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {MATCH_LABELS[line.status]}
                      </Link>
                    ) : MATCH_LABELS[line.status]}</Td>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          </div>
          <SecondaryButton disabled={!matches.length || busy || disabled} onClick={confirm}>
            تأیید {toPersianDigits(matches.length)} تطبیق انتخاب‌شده
          </SecondaryButton>
        </div>
      ) : null}
    </details>
  );
}
