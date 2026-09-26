"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { printerErrorMessage } from "@/lib/printing/errors";
import { subscribePrintProgress, type PrintProgress } from "@/lib/printing/client";

const STEPS = [
  { phase: "preparing", label: "آماده‌سازی سند" },
  { phase: "sending", label: "ارسال به چاپگر" },
] as const;

function stepState(current: PrintProgress["phase"], step: "preparing" | "sending"): "done" | "active" | "wait" {
  if (current === "failed") return step === "preparing" ? "done" : "wait";
  if (current === "handed_off") return "done";
  if (current === "preparing") return step === "preparing" ? "active" : "wait";
  if (current === "routing" || current === "sending") return step === "preparing" ? "done" : "active";
  return "wait";
}

/** The only print UI: progress until the spooler accepts the job, then it closes. */
export function PrintJobModal() {
  const [state, setState] = useState<PrintProgress | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => subscribePrintProgress((next) => {
    setState(next);
    setOpen(next != null);
  }), []);

  useEffect(() => {
    if (state?.phase !== "handed_off") return;
    const timer = window.setTimeout(() => setOpen(false), 900);
    return () => window.clearTimeout(timer);
  }, [state]);

  const phase = state?.phase ?? "preparing";
  const success = phase === "handed_off";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-sm text-center" dir="rtl">
        <DialogTitle className="text-base">{state?.title ?? "چاپ"}</DialogTitle>
        <DialogDescription className="sr-only">وضعیت پیشرفت ارسال سند به چاپگر</DialogDescription>
        <div role="status" aria-live="polite">
          {success ? (
            <div className="space-y-1 py-4">
              <p className="text-lg font-semibold text-foreground">به چاپگر ارسال شد</p>
              {state?.printerName ? <p className="text-sm text-muted-foreground" dir="auto">{state.printerName}</p> : null}
            </div>
          ) : (
            <ol className="space-y-2 py-3 text-start text-sm">
              {STEPS.map((step) => {
                const mark = stepState(phase, step.phase);
                return (
                  <li key={step.phase} className="flex items-center gap-2">
                    <span aria-hidden="true">{mark === "done" ? "✓" : mark === "active" ? "◉" : "○"}</span>
                    <span>{step.label}</span>
                    <span className="sr-only">
                      {mark === "done" ? "انجام شد" : mark === "active" ? "در حال انجام" : "در انتظار"}
                    </span>
                  </li>
                );
              })}
              {state?.printerName ? <li className="text-muted-foreground" dir="auto">چاپگر: {state.printerName}</li> : null}
              {phase === "failed" && state?.error ? (
                <li role="alert" className="text-red-700 dark:text-red-300">{printerErrorMessage(state.error)}</li>
              ) : null}
            </ol>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
