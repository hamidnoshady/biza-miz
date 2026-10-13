"use client";

/**
 * Phase 46 — a Hybrid desktop says so when the Internet goes, and when it
 * comes back. Offline, the till (selling, orders, tables, kitchen, shifts)
 * keeps working on this computer; cloud screens wait for the connection.
 *
 * Issue #948 P0/P1-5 — three distinct problems, three distinct messages.
 * The old notice folded them into one: any of "browser offline" / "cloud
 * unreachable" / "sync paused" toasted «اتصال به اینترنت و نسخهٔ ابری قطع
 * است» — a false claim whenever only the sync plane was stuck (IAM failure,
 * cloud auth expired, retry backoff) while the operator was standing on a
 * working Internet connection. Now:
 *
 *  - browser reports no network → an *internet* message (the only case that
 *    may say so);
 *  - sync paused for a transport fault → cloud-host message;
 *  - sync paused for an auth/identity/other fault → sync-plane message with
 *    the repair destination, and no connectivity claim at all.
 *
 * Renders nothing and only toasts on a change — never on the first reading,
 * so opening the app online is silent.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useOfflineQueue } from "./offline-queue";

export function HybridConnectivityNotice() {
  const { connectionState } = useOfflineQueue();
  const [browserOnline, setBrowserOnline] = useState(true);
  const previous = useRef<{ internetDown: boolean; cloudDown: boolean; syncStuck: boolean } | null>(null);

  useEffect(() => {
    const update = () => setBrowserOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const internetDown = !browserOnline || connectionState.internet === "internet_unavailable";
  const fault = connectionState.syncFault;
  const transportFault = fault === "transport_unreachable" || fault === "timeout" || fault === null;
  const syncPaused = connectionState.cloudSync === "cloud_sync_paused";
  const cloudDown = syncPaused && transportFault && !internetDown;
  const syncStuck = syncPaused && !transportFault;

  useEffect(() => {
    const before = previous.current;
    previous.current = { internetDown, cloudDown, syncStuck };
    if (!before) return;

    if (internetDown && !before.internetDown) {
      toast.warning("اینترنت این دستگاه قطع شد", {
        id: "hybrid-connectivity",
        description:
          "فقط بخش‌های محلی کار می‌کنند: صندوق، سفارش‌ها، میزها، آشپزخانه و شیفت. فروش‌ها ذخیره می‌شوند و با برگشت اینترنت به ابر می‌روند.",
        duration: 10_000,
      });
      return;
    }
    if (!internetDown && before.internetDown) {
      toast.success("اینترنت برگشت", {
        id: "hybrid-connectivity",
        description: "فروش‌های ذخیره‌شده به‌صورت خودکار به ابر فرستاده می‌شوند.",
      });
      return;
    }
    if (cloudDown && !before.cloudDown) {
      toast.warning("ارتباط با نسخهٔ ابری برقرار نشد", {
        id: "hybrid-connectivity",
        description:
          "اینترنت دستگاه وصل است، اما سرور ابری پاسخ نمی‌دهد. عملیات محلی ادامه دارد و همگام‌سازی به‌صورت خودکار دوباره تلاش می‌شود.",
        duration: 10_000,
      });
      return;
    }
    if (syncStuck && !before.syncStuck) {
      toast.warning("همگام‌سازی ابری موقتاً متوقف شد", {
        id: "hybrid-connectivity",
        description:
          "مشکل از اتصال اینترنت نیست؛ حساب/هویت یا سرویس ابری نیازمند بررسی است. از «تنظیمات ← ابر و همگام‌سازی» وضعیت را ببینید.",
        duration: 10_000,
      });
      return;
    }
    if (!cloudDown && !syncStuck && (before.cloudDown || before.syncStuck)) {
      toast.success("همگام‌سازی ابری از سر گرفته شد", {
        id: "hybrid-connectivity",
        description: "همهٔ بخش‌ها دوباره در دسترس‌اند و فروش‌های ذخیره‌شده به ابر فرستاده می‌شوند.",
      });
    }
  }, [internetDown, cloudDown, syncStuck]);

  return null;
}
