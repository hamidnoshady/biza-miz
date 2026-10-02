"use client";

/**
 * Phase 46 — a Hybrid desktop says so when the Internet goes, and when it
 * comes back. Offline, the till (selling, orders, tables, kitchen, shifts)
 * keeps working on this computer; cloud screens wait for the connection.
 *
 * "Down" is the browser reporting no network, or the shell's one connection
 * probe (`useOfflineQueue`) reporting the cloud unreachable. Renders nothing
 * and only toasts on a change — never on the first reading, so opening the
 * app online is silent.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useOfflineQueue } from "./offline-queue";

export function HybridConnectivityNotice() {
  const { connectionState } = useOfflineQueue();
  const [browserOnline, setBrowserOnline] = useState(true);
  const previous = useRef<boolean | null>(null);

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

  const down =
    !browserOnline ||
    connectionState.internet === "internet_unavailable" ||
    connectionState.cloudSync === "cloud_sync_paused";

  useEffect(() => {
    const before = previous.current;
    previous.current = down;
    if (before === null || before === down) return;
    if (down) {
      toast.warning("اتصال به اینترنت و نسخهٔ ابری قطع است", {
        id: "hybrid-connectivity",
        description:
          "فقط بخش‌های محلی کار می‌کنند: صندوق، سفارش‌ها، میزها، آشپزخانه و شیفت. فروش‌ها ذخیره می‌شوند و با برگشت اینترنت به ابر می‌روند.",
        duration: 10_000,
      });
    } else {
      toast.success("اتصال برگشت", {
        id: "hybrid-connectivity",
        description: "همهٔ بخش‌ها دوباره در دسترس‌اند و فروش‌های ذخیره‌شده به ابر فرستاده می‌شوند.",
      });
    }
  }, [down]);

  return null;
}
