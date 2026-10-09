"use client";

import { useState } from "react";
import { CheckIcon, PinIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ChartType } from "./report-ui";

/**
 * Adds a report to the caller's personal dashboard as a new widget.
 *
 * ## Why this is one request and not three (issue #819)
 *
 * The button used to GET the whole layout, compute the next free row in the
 * browser, and POST the array back with the new tile appended. Two failures
 * followed from that shape and both were silent:
 *
 *  1. **A failed read was read as an empty layout.** The GET's
 *     `response.json()` ignores `response.ok`, so a 403/500 body — `{error: …}`,
 *     with no `widgets` — became `existing = []` through `?? []`. The POST then
 *     replaced the member's entire dashboard with a single tile.
 *  2. **Two pins at once lost one.** Both read the same layout, both wrote
 *     "those plus mine", and the second write deleted the first.
 *
 * So the server owns the append (`{ append: … }`): it locks the layout, places
 * the tile itself, and returns the new revision. The browser sends one request
 * it cannot corrupt by having read something stale, and a failure leaves the
 * existing layout exactly as it was.
 */
export function PinToDashboardButton({
  savedReportId,
  chartType,
  title,
  disabled = false,
}: {
  savedReportId: string;
  chartType: ChartType;
  title: string;
  disabled?: boolean;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">(
    "idle",
  );
  const [error, setError] = useState("");

  async function pin() {
    setState("busy");
    setError("");
    try {
      const response = await fetch("/api/dashboard/widgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "personal",
          append: { savedReportId, chartType, title, w: 4, h: 3 },
        }),
      });
      if (!response.ok) {
        // Every failure — refused, unknown report, network — keeps the layout
        // untouched and says so. There is no fallback path that writes anyway.
        const data = await response.json().catch(() => ({} as { error?: string }));
        setError(data.error === "unknown_saved_report" ? "این گزارش دیگر در دسترس نیست." : "سنجاق کردن انجام نشد.");
        setState("error");
        return;
      }
      setState("done");
    } catch {
      setError("سنجاق کردن انجام نشد. اتصال شبکه را بررسی کنید.");
      setState("error");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="lg"
        onClick={pin}
        disabled={disabled || state === "busy" || state === "done"}
      >
        {state === "done" ? <CheckIcon aria-hidden="true" /> : <PinIcon aria-hidden="true" />}
        {state === "done" ? "سنجاق شد" : state === "busy" ? "در حال سنجاق…" : "سنجاق به داشبورد"}
      </Button>
      {/*
        Pinning succeeds silently otherwise: the widget appears on a different
        page, so without a word here the button looks like it did nothing.
      */}
      {state === "done" ? (
        <span role="status" className="text-xs text-muted-foreground">
          در «گزارش‌های سنجاق‌شده» داشبورد اضافه شد.
        </span>
      ) : null}
      {state === "error" ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
