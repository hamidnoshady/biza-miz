"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { BugIcon, CameraIcon, RefreshCwIcon, SendIcon, Trash2Icon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { captureScreenshot } from "./capture-screenshot";

export interface BugReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** True while a screenshot is being captured, so the dialog is hidden from the shot. */
  capturing: boolean;
  onCapturingChange: (capturing: boolean) => void;
}

function bugReportErrorMessage(code: string | undefined): string {
  switch (code) {
    case "cloud_support_offline":
      return "در حالت تمام‌آفلاین، ارسال گزارش مشکل فقط هنگام اتصال تأییدشده به سرور ابری امکان‌پذیر است. گزارش ارسال نشد و در صف آفلاین ذخیره نمی‌شود.";
    case "not_enrolled":
      return "این نصب تمام‌آفلاین هنوز در سرور ابری فعال‌سازی نشده است.";
    case "installation_locked":
      return "فعال‌سازی ابری این دستگاه قفل است.";
    case "rate_limited":
      return "تعداد گزارش‌های ارسالی بیش از حد مجاز است؛ کمی صبر کنید.";
    default:
      return "ثبت گزارش ناموفق بود؛ دوباره تلاش کنید.";
  }
}

export function BugReportDialog({
  open,
  onOpenChange,
  capturing,
  onCapturingChange,
}: BugReportDialogProps) {
  const [description, setDescription] = useState("");
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cloudOfflineReason, setCloudOfflineReason] = useState<string | null>(null);
  const [checkingCloud, setCheckingCloud] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const reset = () => {
    setDescription("");
    setScreenshot(null);
    setSubmitting(false);
    setCloudOfflineReason(null);
  };

  const checkOnlineAvailability = useCallback(async () => {
    setCheckingCloud(true);
    try {
      const offlineHint =
        typeof navigator !== "undefined" && navigator.onLine === false ? "1" : "0";
      const res = await fetch(
        `/api/local-activation/status?probe=1&offlineHint=${offlineHint}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        applicable?: boolean;
        activation?: {
          enrolled: boolean;
          state: string;
          cloudReachable: boolean;
        };
      };
      if (!data.applicable || !data.activation) {
        setCloudOfflineReason(null);
        return;
      }
      if (!data.activation.enrolled) {
        setCloudOfflineReason("not_enrolled");
      } else if (data.activation.state === "locked_invalid") {
        setCloudOfflineReason("installation_locked");
      } else if (!data.activation.cloudReachable) {
        setCloudOfflineReason("cloud_support_offline");
      } else {
        setCloudOfflineReason(null);
      }
    } catch {
      // Non-fatal: let POST /api/bug-report remain the authoritative check.
    } finally {
      setCheckingCloud(false);
    }
  }, []);

  useEffect(() => {
    if (open && !capturing) {
      void checkOnlineAvailability();
    }
  }, [open, capturing, checkOnlineAvailability]);

  const handleCapture = async () => {
    if (capturing) return;
    onCapturingChange(true);
    try {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!document.querySelector('[data-slot="dialog-content"]'))
            resolve();
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      });
      const shot = await captureScreenshot();
      if (shot) setScreenshot(shot);
      else
        toast.error("گرفتن تصویر ممکن نشد؛ می‌توانید بدون تصویر ادامه دهید.");
    } finally {
      onCapturingChange(false);
    }
  };

  const handleSubmit = async () => {
    const trimmed = description.trim();
    if (!trimmed) {
      toast.error("توضیح مشکل را وارد کنید.");
      textareaRef.current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/bug-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: trimmed,
          screenshot,
          pageUrl: window.location.href,
          userAgent: navigator.userAgent,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (!res.ok) {
        if (
          payload.error === "cloud_support_offline" ||
          payload.error === "not_enrolled" ||
          payload.error === "installation_locked"
        ) {
          setCloudOfflineReason(payload.error);
        }
        toast.error(bugReportErrorMessage(payload.error));
        return;
      }
      toast.success(
        payload.id
          ? `گزارش شما ثبت شد (شناسه: ${payload.id.slice(0, 8)}). سپاس!`
          : "گزارش شما ثبت شد. سپاس!",
      );
      reset();
      onOpenChange(false);
    } catch {
      toast.error("خطا در ارتباط با سرور؛ دوباره تلاش کنید.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open && !capturing}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BugIcon aria-hidden="true" className="size-5 text-destructive" />
            گزارش مشکل
          </DialogTitle>
          <DialogDescription>
            بگویید چه مشکلی پیش آمد. می‌توانید از همین صفحه عکس بگیرید و همراه
            توضیح بفرستید.
          </DialogDescription>
        </DialogHeader>

        {cloudOfflineReason ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50/90 p-3 text-xs leading-6 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100">
            <p className="font-semibold">نیاز به اتصال سرور ابری</p>
            <p className="mt-0.5">{bugReportErrorMessage(cloudOfflineReason)}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={checkingCloud}
              onClick={() => void checkOnlineAvailability()}
            >
              <RefreshCwIcon aria-hidden="true" className="size-3.5" />
              {checkingCloud ? "در حال بررسی…" : "بررسی مجدد اتصال ابری"}
            </Button>
          </div>
        ) : null}

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="bug-report-description">
              توضیح مشکل <span className="text-destructive">*</span>
            </Label>
            <textarea
              ref={textareaRef}
              id="bug-report-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="چه کاری انجام می‌دادید و چه خطایی دیدید؟"
              rows={4}
              required
              aria-required="true"
              className="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-base leading-6 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 md:text-sm"
            />
          </div>

          {screenshot ? (
            <div className="relative overflow-hidden rounded-lg border border-border/80">
              <img
                src={screenshot}
                alt="تصویر صفحه هنگام گزارش"
                className="max-h-56 w-full object-cover"
              />
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => setScreenshot(null)}
                className="absolute end-2 top-2"
              >
                <Trash2Icon aria-hidden="true" />
                حذف تصویر
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={handleCapture}
              disabled={capturing}
              className="w-full"
            >
              <CameraIcon aria-hidden="true" />
              {capturing ? "در حال گرفتن تصویر…" : "گرفتن تصویر از صفحه"}
            </Button>
          )}
        </div>

        <DialogFooter showCloseButton>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || capturing || cloudOfflineReason !== null}
          >
            <SendIcon aria-hidden="true" />
            {submitting ? "در حال ارسال…" : "ارسال گزارش"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
