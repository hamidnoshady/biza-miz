"use client";
import { useEffect, useState } from "react";
import { errorMessage } from "@/app/dashboard/reports/standard-report-config";
/** Keyed state plus abort: a late response can never paint under newer filters. */
export function useReport<T>(url: string | null, refresh = 0, body?: string) {
  const key = `${url}|${refresh}|${body ?? ""}`;
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>({ key: "" });
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    fetch(url, { cache: "no-store", signal: controller.signal,
      ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body } : {}),
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error === "location_required"
        ? "برای این گزارش یک شعبه انتخاب کنید؛ تجمیع همهٔ شعب پشتیبانی نمی‌شود." : errorMessage(response.status));
      if (!controller.signal.aborted) setState({ key, data });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ key, error: error instanceof Error ? error.message : "خواندن گزارش ممکن نشد." });
    });
    return () => controller.abort();
  }, [url, refresh, body, key]);
  return state.key === key ? state : { key };
}
