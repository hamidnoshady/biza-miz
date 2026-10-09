"use client";

/**
 * «چاپگرها» — the Printers page: a plain list of this branch's printers plus
 * one Add button. Connection mechanics (the Windows/network choice, the
 * connector install, discovery, test prints) live inside the add/edit dialog
 * and never clutter this page. The same panel is reused verbatim by the
 * first-run setup wizard's hardware step.
 */
import { useEffect, useState } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { ErrorBox, InfoBox, errorMessage } from "@/app/dashboard/ui";
import { connectorHealth } from "@/lib/printing/client";
import { AddPrinterDialog } from "./add-printer-flow";
import { PrinterCard } from "./printer-card";
import { usePrinterList } from "./use-printing";

export function PrintersPanel({ onChanged }: { onChanged?: () => Promise<void> | void } = {}) {
  const printerList = usePrinterList();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const changed = async () => {
    await printerList.reload();
    await onChanged?.();
  };

  return (
    <div className="space-y-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <ConnectorHint />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-foreground">چاپگرهای این شعبه</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">چاپگرهای رسید و آشپزخانهٔ این شعبه را مدیریت کنید.</p>
        </div>
        <Button type="button" onClick={() => setAdding(true)}>
          <PlusIcon aria-hidden="true" />
          افزودن چاپگر
        </Button>
      </div>

      {printerList.loading ? (
        <LoadingSkeleton rows={3} label="در حال خواندن چاپگرها" />
      ) : printerList.printers.length === 0 ? (
        <EmptyState>هنوز چاپگری ثبت نشده است. تا وقتی چاپگری اضافه نشود، کارت‌ها و رسیدها چاپ نمی‌شوند.</EmptyState>
      ) : (
        <div className="space-y-3">
          {printerList.printers.map((printer) => (
            <PrinterCard
              key={printer.id}
              printer={printer}
              onChanged={async () => {
                await changed();
                setNotice("تنظیمات چاپگر ذخیره شد.");
              }}
              onNotice={setNotice}
              onError={setError}
            />
          ))}
        </div>
      )}

      <AddPrinterDialog
        open={adding}
        onOpenChange={setAdding}
        onSaved={async () => {
          setAdding(false);
          await changed();
          setNotice("چاپگر جدید ثبت شد.");
        }}
      />
    </div>
  );
}

/**
 * A slim install hint when the connector is missing — the one piece of
 * connection plumbing this page shows on its own, because every hardware
 * printer (Windows and network alike) needs it. The full install card lives
 * inside the Add flow, where the operator actually needs it.
 */
function ConnectorHint() {
  const [missing, setMissing] = useState(false);
  const [outdated, setOutdated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void connectorHealth().then((result) => {
      if (cancelled) return;
      setMissing(!result.ok);
      setOutdated(result.error === "connector_outdated");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!missing) return null;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-100/60 px-3 py-3 text-sm leading-6 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
      {outdated
        ? "نسخهٔ سرویس چاپ اشوبه روی این کامپیوتر قدیمی است. هنگام افزودن چاپگر آن را یک‌بار به‌روز کنید."
        : "چاپ از مرورگر به سرویس چاپ اشوبه روی همین کامپیوتر نیاز دارد. هنگام افزودن چاپگر آن را یک‌بار نصب کنید."}
    </div>
  );
}
