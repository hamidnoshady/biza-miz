"use client";

/**
 * The journal entry behind a source-register history row.
 *
 * One component, one contract: the register (fixed assets, cheques, anything
 * that posts) stores the id of the entry each step wrote, and this opens that
 * exact document through `/api/ledger/entries/[id]`. Nothing here infers an
 * entry from a memo string, and no register ships its own copy of this dialog
 * — a second copy is a second answer to "what does this posting look like".
 */
import { useEffect, useState } from "react";
import { LoadingSkeleton, overlayPanelClass } from "@/app/dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { api, ErrorBox } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { OverlayDialog } from "./ledger-ui";

/** The journal entry behind a history row — opened by its stored id, never guessed from a memo. */
export function JournalPeekDialog({ entryId, title, onClose }: { entryId: string; title: string; onClose: () => void }) {
  const money = useMoney();
  const [entry, setEntry] = useState<{
    id: string;
    entryDate: string;
    memo: string | null;
    locationName: string | null;
    createdByName: string | null;
    reversesEntryId: string | null;
    reversedAt: string | null;
    lines: { id: string; accountCode: string; accountName: string; debit: number; credit: number }[];
  } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setEntry(null);
    setError("");
    api<{ entry: typeof entry }>(`/api/ledger/entries/${entryId}`)
      .then(({ ok, data }) => {
        if (ok) setEntry(data.entry);
        else setError("بارگذاری سند ناموفق بود.");
      })
      .catch(() => setError("ارتباط با سرور برقرار نشد."));
  }, [entryId]);

  return (
    <OverlayDialog
      headingId="journal-peek-heading"
      onClose={onClose}
      className={`${overlayPanelClass} max-h-[85vh] w-full max-w-xl overflow-y-auto p-4 sm:p-6`}
    >
      <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سند حسابداری</p>
          <h3 id="journal-peek-heading" className="mt-1 text-lg font-bold text-foreground">
            {title}
          </h3>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          بستن
        </Button>
      </header>

      {error ? (
        <ErrorBox>{error}</ErrorBox>
      ) : !entry ? (
        <LoadingSkeleton rows={3} />
      ) : (
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-2 rounded-xl border border-border/80 bg-muted/60 p-3 text-xs">
            <div>
              <dt className="text-muted-foreground">تاریخ سند</dt>
              <dd className="mt-0.5 font-semibold text-foreground">{toPersianDigits(formatJalali(entry.entryDate))}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">شعبه ثبت</dt>
              <dd className="mt-0.5 font-semibold text-foreground">{entry.locationName ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">ثبت‌کننده</dt>
              <dd className="mt-0.5 font-semibold text-foreground">{entry.createdByName ?? "سیستم"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">وضعیت</dt>
              <dd className="mt-0.5 font-semibold text-foreground">
                {entry.reversedAt ? "برگشت خورده" : entry.reversesEntryId ? "سند برگشتی" : "قطعی"}
              </dd>
            </div>
            {entry.memo ? (
              <div className="col-span-2">
                <dt className="text-muted-foreground">شرح</dt>
                <dd className="mt-0.5 font-semibold text-foreground">{entry.memo}</dd>
              </div>
            ) : null}
          </dl>

          <DataTable caption="ردیف‌های سند">
            <DataTableHead>
              <Th>حساب</Th>
              <Th>بدهکار</Th>
              <Th>بستانکار</Th>
            </DataTableHead>
            <DataTableBody>
              {entry.lines.map((line) => (
                <DataTableRow key={line.id}>
                  <Td>
                    <span className="font-mono text-xs text-muted-foreground" dir="ltr">
                      {line.accountCode}
                    </span>{" "}
                    <span className="font-medium">{line.accountName}</span>
                  </Td>
                  <Td numeric nowrap>
                    {line.debit > 0 ? money.format(line.debit) : "—"}
                  </Td>
                  <Td numeric nowrap>
                    {line.credit > 0 ? money.format(line.credit) : "—"}
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        </div>
      )}
    </OverlayDialog>
  );
}
