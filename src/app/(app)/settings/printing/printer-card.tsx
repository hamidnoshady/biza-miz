"use client";

/**
 * One saved printer on the Printers page — name, purpose, connection type,
 * target, status and the two actions that matter (test print, edit). All
 * configuration lives inside the edit dialog until it is deliberately opened.
 */
import { useState } from "react";
import { PencilIcon, PlugZapIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/app/dashboard/page-chrome";
import { testPrint } from "@/lib/printing/client";
import { printerErrorMessage } from "@/lib/printing/errors";
import { describeConnection, legacyTransportLabel, normalizeStoredConnection } from "@/lib/printing/types";
import { DOC_TYPE_LABELS, PAPERS, type DocType } from "@/lib/print-template";
import { documentTypeForPurpose } from "@/lib/printing/routing";
import { PRINTER_PURPOSE_LABELS } from "@/lib/printing/types";
import type { PrinterRow } from "./use-printing";
import { AddPrinterDialog } from "./add-printer-flow";
import { PrinterStatusBadge, usePrinterStatus } from "./printer-status";

export function PrinterCard({
  printer,
  onChanged,
  onNotice,
  onError,
}: {
  printer: PrinterRow;
  onChanged: () => Promise<void> | void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const { status, target } = usePrinterStatus(printer);
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const connection = normalizeStoredConnection(printer.connection);
  const paper = printer.paper && PAPERS[printer.paper] ? PAPERS[printer.paper].label : printer.paper_width_mm === 58 ? "۵۸ میلی‌متر" : "۸۰ میلی‌متر";

  async function runTest() {
    setTesting(true);
    const result = await testPrint(printer.id, documentTypeForPurpose(printer.kind) as DocType);
    setTesting(false);
    if (!result.ok) {
      onError(printerErrorMessage(result.error));
      return;
    }
    onNotice("چاپ آزمایشی ارسال شد.");
  }

  return (
    <div className="rounded-xl border border-border/80 bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 sm:p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-foreground">{printer.name}</h3>
            {printer.is_default ? <StatusBadge tone="active">پیش‌فرض</StatusBadge> : null}
            {!printer.is_active ? <StatusBadge tone="neutral">غیرفعال</StatusBadge> : null}
            <PrinterStatusBadge status={status} />
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground" dir="auto">
            {PRINTER_PURPOSE_LABELS[printer.kind] ?? DOC_TYPE_LABELS[documentTypeForPurpose(printer.kind)]} • {connection.needsReconnect ? legacyTransportLabel(connection.legacyTransport) : target?.type === "windows" ? "ویندوز" : "شبکه"} •{" "}
            {describeConnection(printer.connection)} • {paper}
          </p>
          {connection.needsReconnect ? (
            <p className="mt-1 text-xs leading-5 text-amber-700 dark:text-amber-300">
              این چاپگر باید دوباره متصل شود؛ «ویرایش» را بزنید و اتصال آن را از نو برقرار کنید.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => (connection.needsReconnect ? setEditing(true) : void runTest())}
            disabled={testing || status === "checking"}
          >
            <PlugZapIcon aria-hidden="true" />
            {testing ? "در حال چاپ…" : connection.needsReconnect ? "اتصال دوباره" : "چاپ آزمایشی"}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            <PencilIcon aria-hidden="true" />
            ویرایش
          </Button>
        </div>
      </div>

      <AddPrinterDialog
        open={editing}
        onOpenChange={setEditing}
        editing={printer}
        onSaved={async () => {
          setEditing(false);
          await onChanged();
          onNotice("تنظیمات چاپگر ذخیره شد.");
        }}
      />
    </div>
  );
}
