"use client";

import { useState } from "react";
import { FileDownIcon, PrinterIcon } from "lucide-react";

export function PrintToolbar({
  title,
  contractId,
  finalSigned = false,
  canGenerateFinalPdf = false,
}: {
  title: string;
  contractId: string;
  finalSigned?: boolean;
  canGenerateFinalPdf?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const downloadFinalPdf = async () => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/workspace/contracts/${encodeURIComponent(contractId)}/final-pdf`, {
        method: "POST",
        headers: { Accept: "application/pdf" },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        const text = body.error === "contract_not_completed"
          ? "پاکت امضا هنوز کامل نشده است."
          : body.error === "contract_final_pdf_storage_unavailable"
            ? "فضای ذخیره‌سازی کتابخانهٔ رسانه در دسترس نیست."
            : "ساخت یا دریافت PDF نهایی ناموفق بود؛ دوباره تلاش کنید.";
        throw new Error(text);
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `${title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").trim().slice(0, 100) || "contract"}-signed.pdf`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      setMessage("نسخهٔ ثابت و قابل راستی‌آزمایی در کتابخانهٔ رسانه بایگانی شد.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "دریافت PDF ناموفق بود.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
      <div>
        <p className="text-sm text-muted-foreground">
          {finalSigned ? "نسخهٔ امضاشده" : "پیش‌نمایش چاپ"} — «چاپ» را بزنید و در پنجرهٔ چاپ، «ذخیره به‌صورت PDF» را انتخاب کنید.
        </p>
        {message ? <p role="status" className="mt-1 text-xs text-muted-foreground">{message}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {finalSigned && canGenerateFinalPdf ? (
          <button
            type="button"
            disabled={busy}
            onClick={downloadFinalPdf}
            className="inline-flex h-10 items-center rounded-lg border border-border bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
          >
            <FileDownIcon className="me-1.5 size-4" aria-hidden />
            {busy ? "در حال آماده‌سازی…" : "دریافت PDF نهاییِ قابل‌راستی‌آزمایی"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <PrinterIcon className="me-1.5 size-4" aria-hidden />
          چاپ {title}
        </button>
      </div>
    </div>
  );
}
