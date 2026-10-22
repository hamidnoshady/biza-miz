"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { printKitchenTicket } from "@/lib/printing/client";

interface KitchenDispatchJob {
  dispatchId: string;
  claimToken: string;
  orderId: string;
  itemIds: string[];
  requestId: string;
}

/**
 * The physical-print owner polls the durable server queue and uses the existing
 * #815 document loader + print client. Database claims serialize tabs/devices;
 * ambiguous deliveries are quarantined server-side rather than auto-resent.
 */
export function KitchenDispatchAgent({ enabled }: { enabled: boolean }) {
  const alerted = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let active = false;

    const poll = async () => {
      if (stopped || active || document.visibilityState === "hidden") return;
      active = true;
      try {
        const response = await fetch("/api/printing/kitchen-dispatch", { credentials: "same-origin" });
        if (!response.ok) return;
        const payload = await response.json() as { jobs?: KitchenDispatchJob[] };
        for (const job of payload.jobs ?? []) {
          if (stopped) return;
          const result = await printKitchenTicket(null, job.orderId, {
            requestId: job.requestId,
            itemIds: job.itemIds,
          });
          const ack = await fetch("/api/printing/kitchen-dispatch", {
            method: "PATCH",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              dispatchId: job.dispatchId,
              claimToken: job.claimToken,
              handedOff: result.ok,
              errorCode: result.error,
              ambiguous: result.ambiguous,
            }),
          });
          if (!result.ok && !alerted.current.has(job.dispatchId)) {
            alerted.current.add(job.dispatchId);
            toast.warning(
              result.ambiguous
                ? "وضعیت چاپ آشپزخانه نامشخص است؛ برای جلوگیری از چاپ تکراری، ارسال خودکار متوقف شد. چاپگر را بررسی کنید."
                : "ارسال پایدار سفارش به چاپگر آشپزخانه انجام نشد؛ پس از رفع مشکل دوباره تلاش می‌شود.",
              { duration: 12_000 },
            );
          }
          if (!ack.ok) console.error("kitchen dispatch acknowledgement failed", job.dispatchId);
        }
      } catch (cause) {
        console.error("kitchen dispatch polling failed", cause);
      } finally {
        active = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 5_000);
    const onVisibility = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);

  return null;
}
