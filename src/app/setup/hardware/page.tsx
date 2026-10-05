"use client";

/**
 * Setup wizard — the hardware step. The printer connection UI is not rebuilt
 * here: the SAME PrintersPanel the Settings → Printers tab renders is embedded
 * whole, so there is exactly one way to pair a printer, learned once. The
 * wizard only adds the step chrome around it; the step is marked done the
 * first time a printer is actually saved.
 *
 * How a printer is reached depends on the install, and the copy says so: the
 * desktop app prints through its own Electron main process
 * (`electron/native-printing.js`, wired as `window.businessSuiteDesktop.
 * printing`) with no second component to install, while a browser/cloud till
 * installs the Windows connector in one click from the same panel. Issue #808
 * §10: the old copy described the connector on every install, which is simply
 * wrong on the desktop.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ErrorBox, errorMessage, InfoBox, StepShell } from "../ui";
import { PrintersPanel } from "@/app/(app)/settings/printing/printers-panel";
// Registers the typed `window.businessSuiteDesktop` bridge this page probes.
import "@/lib/desktop-bridge";

export default function HardwareStep() {
  const [marked, setMarked] = useState(false);
  const [error, setError] = useState("");
  const [onDesktop, setOnDesktop] = useState(false);

  useEffect(() => {
    setOnDesktop(Boolean(window.businessSuiteDesktop?.printing));
  }, []);

  /**
   * Issue #808 §6: the step used to be treated as done the moment the panel
   * reported a save, before the progress write had succeeded — so a failed
   * write left the wizard silently behind, and no later save retried it. Now
   * only a successful write retires the step; a failure is shown and the next
   * printer save tries again.
   */
  const onPrinterSaved = useCallback(async () => {
    if (marked) return;
    setError("");
    const { ok, data, status } = await api<{ error?: string }>("/api/setup/hardware", {
      method: "POST",
      body: JSON.stringify({ done: true }),
    });
    if (!ok) {
      setError(errorMessage(data?.error, undefined, status));
      return;
    }
    setMarked(true);
  }, [marked]);

  return (
    <StepShell
      step="hardware"
      description="چاپگر رسید و آشپزخانه را وصل و آزمایش کنید. همین صفحهٔ افزودن چاپگر، جست‌وجوی شبکه و چاپ آزمایشی واقعی دارد."
      showSkip
      showNext
    >
      <ErrorBox>{error}</ErrorBox>
      <InfoBox>
        {onDesktop
          ? "روی این دستگاه (نسخهٔ دسکتاپ) چاپ مستقیم انجام می‌شود و نیازی به نصب رابط جداگانه نیست: در «افزودن چاپگر» گزینهٔ «چاپگر ویندوز» را انتخاب کنید و چاپگر نصب‌شده روی ویندوز را از فهرست برگزینید. اگر فعلاً چاپگر ندارید، همین مرحله را رد کنید — چاپ با پنجرهٔ مرورگر هم ممکن است."
          : "برای چاپ روی چاپگر USB یا چاپگر نصب‌شده در Windows، در «افزودن چاپگر» گزینهٔ «چاپگر ویندوز» را انتخاب کنید؛ نصب رابط چاپ یک‌بار کلی و کاملاً خودکار است. اگر فعلاً چاپگر ندارید، همین مرحله را رد کنید — چاپ با پنجرهٔ مرورگر هم ممکن است."}
      </InfoBox>
      <PrintersPanel onChanged={onPrinterSaved} />
    </StepShell>
  );
}
