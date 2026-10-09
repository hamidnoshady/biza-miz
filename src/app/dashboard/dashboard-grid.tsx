"use client";

import { cardClass, LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { cn } from "@/lib/utils";

import { useCallback, useEffect, useMemo, useState } from "react";
import { GridLayout, useContainerWidth, type Layout, type LayoutItem } from "react-grid-layout";
import { SparklesIcon, XIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { api, ErrorBox } from "./ui";
import { BarChart, LineChart, NumberCard, PieChart, type ChartDatum } from "./charts";

type ChartType = "line" | "bar" | "pie" | "number";

interface WidgetRow {
  id: string;
  saved_report_id: string;
  chart_type: ChartType;
  title: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  report_name: string;
  report_config: Record<string, unknown>;
  /**
   * Whether the pinned report still says something about this business
   * (issue #819): a standard report its trade no longer offers, or a custom
   * report on a view/metric the engine has retired. Absent on a layout the
   * server could not annotate; treated as applicable then, so a missing field
   * never replaces a working chart with a notice.
   */
  applicable?: boolean;
  applicable_reason?: "standard_report_not_in_trade" | "unknown_view";
}

/** The sentence a tile shows instead of an all-zero chart. */
function notApplicableReason(widget: WidgetRow): string {
  return widget.applicable_reason === "unknown_view"
    ? "ساختار این گزارش در نسخهٔ فعلی تغییر کرده است. برای حذف این ابزارک «ویرایش چیدمان» را بزنید."
    : "این گزارش برای صنف فعلی کسب‌وکار ارائه نمی‌شود. برای حذف این ابزارک «ویرایش چیدمان» را بزنید.";
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function formatDim(dim: string | null): string {
  if (dim === null) return "";
  if (ISO_DATE_RE.test(dim)) return toPersianDigits(formatJalali(dim));
  return dim;
}

function useWidgetData(config: Record<string, unknown>, enabled = true) {
  const [state, setState] = useState<{ data: ChartDatum[] | null; error: string }>({
    data: null,
    error: "",
  });
  const configKey = JSON.stringify(config);
  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      // A retained widget whose report no longer applies is a notice, not a
      // hidden data read. Keeping the hook mounted is required by React, but it
      // must not execute the stale config through the generic query endpoint.
      setState({ data: null, error: "" });
      return () => {
        cancelled = true;
      };
    }
    api<{ rows?: { dim: string | null; value: string | number | null }[]; message?: string }>(
      "/api/reports/query",
      { method: "POST", body: configKey },
    ).then(({ ok, data: res }) => {
      if (cancelled) return;
      if (ok && res.rows) {
        setState({ data: res.rows.map((r) => ({ label: formatDim(r.dim), value: Number(r.value) || 0 })), error: "" });
      } else {
        // A refused read is not an empty result: the tile says why rather than
        // drawing zero, which would read as "this branch sold nothing"
        // (issue #819 — the query route now refuses a member with no branch).
        setState({ data: [], error: res.message ?? "این ابزارک قابل خواندن نیست." });
      }
    });
    return () => {
      cancelled = true;
    };

  }, [configKey, enabled]);
  return state;
}

function requestWidgetExplanation(widget: WidgetRow, data: ChartDatum[]) {
  const title = widget.title ?? widget.report_name;
  const facts = data
    .slice(0, 8)
    .map((row) => `${row.label}: ${toPersianDigits(Math.round(row.value).toLocaleString("en-US"))}`)
    .join("؛ ");
  const prompt = [
    `عدد یا نمودار «${title}» را با اتکا به داده‌های واقعی گزارش بررسی و توضیح بده.`,
    facts ? `دادهٔ نمایشی فعلی: ${facts}.` : "",
    "اگر دادهٔ کافی برای نتیجه‌گیری وجود ندارد، صریح بگو چه گزارشی باید بررسی شود؛ عددی را حدس نزن.",
  ]
    .filter(Boolean)
    .join("\n");
  window.dispatchEvent(new CustomEvent("ai:prefill", { detail: { prompt } }));
}

function WidgetBody({ widget, canExplain }: { widget: WidgetRow; canExplain: boolean }) {
  const { data, error } = useWidgetData(widget.report_config, widget.applicable !== false);
  if (widget.applicable === false) {
    return (
      <p className="flex h-full items-center justify-center px-2 text-center text-xs leading-5 text-muted-foreground">
        {notApplicableReason(widget)}
      </p>
    );
  }
  if (data === null) return <LoadingSkeleton rows={2} compact />;
  if (error) {
    return (
      <p role="alert" className="flex h-full items-center justify-center px-2 text-center text-xs leading-5 text-destructive">
        {error}
      </p>
    );
  }

  const chart =
    widget.chart_type === "number" ? (
      <NumberCard
        label={widget.title ?? widget.report_name}
        value={toPersianDigits(Math.round(data.reduce((sum, row) => sum + row.value, 0)).toLocaleString("en-US"))}
      />
    ) : widget.chart_type === "line" ? (
      <LineChart data={data} />
    ) : widget.chart_type === "pie" ? (
      <PieChart data={data} />
    ) : (
      <BarChart data={data} />
    );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="min-h-0 flex-1">{chart}</div>
      {canExplain ? (
        <button
          type="button"
          onClick={() => requestWidgetExplanation(widget, data)}
          className="inline-flex min-h-8 w-fit items-center gap-1 rounded-lg px-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SparklesIcon className="size-3.5" /> توضیح این عدد
        </button>
      ) : null}
    </div>
  );
}

// Below this container width the 12-column grid is too cramped to be usable —
// widgets get sub-30px columns and their content overflows — so we collapse to
// a single full-width column and stack the tiles in reading order instead.
const STACK_MAX_WIDTH = 640;

export function DashboardGrid({ canEdit, canExplain }: { canEdit: boolean; canExplain: boolean }) {
  // measureBeforeMount keeps `mounted` false until the container's real width
  // is measured, so the grid below (gated on `mounted`) never renders at the
  // hook's 1280px default first. Without it, the first paint lays the grid out
  // as a 1280px desktop layout — wider than any phone viewport, and above the
  // STACK_MAX_WIDTH threshold so it never collapses to one column — which
  // overflows the screen horizontally on mobile before the effect corrects it.
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  const [widgets, setWidgets] = useState<WidgetRow[] | null>(null);
  /**
   * The layout revision the rows above were read at (issue #819). Sent with
   * every write so a save built from a stale screen is refused instead of
   * deleting what another tab changed.
   */
  const [revision, setRevision] = useState<string>("");
  const [editMode, setEditMode] = useState(false);
  const [error, setError] = useState("");

  const stacked = mounted && width > 0 && width < STACK_MAX_WIDTH;
  const cols = stacked ? 1 : 12;
  // Editing (drag/resize) persists positions in 12-column coordinates, so we
  // only allow it on the full grid — never in the stacked mobile view, whose
  // one-column layout would otherwise clobber the saved desktop arrangement.
  const canEditLayout = canEdit && !stacked;

  const load = useCallback(() => {
    api<{ widgets: WidgetRow[]; revision?: string }>("/api/dashboard/widgets").then(({ ok, data }) => {
      if (!ok) return;
      setWidgets(data.widgets);
      setRevision(data.revision ?? "");
    });
  }, []);
  useEffect(load, [load]);

  const layout: Layout = useMemo(() => {
    const items = widgets ?? [];
    if (stacked) {
      // Full-width tiles stacked top-to-bottom in the saved reading order.
      let y = 0;
      return [...items]
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((w) => {
          const h = Math.max(w.h, 3);
          const item = { i: w.id, x: 0, y, w: 1, h, minW: 1, minH: 2 };
          y += h;
          return item;
        });
    }
    return items.map((w) => ({ i: w.id, x: w.x, y: w.y, w: w.w, h: w.h, minW: 2, minH: 2 }));
  }, [widgets, stacked]);

  async function persist(next: WidgetRow[]) {
    const previous = widgets;
    setWidgets(next);
    setError("");
    const { ok, data, status } = await api<{ error?: string; revision?: string }>("/api/dashboard/widgets", {
      method: "POST",
      body: JSON.stringify({
        scope: "personal",
        ifRevision: revision,
        widgets: next.map((w) => ({
          savedReportId: w.saved_report_id,
          chartType: w.chart_type,
          title: w.title,
          x: w.x,
          y: w.y,
          w: w.w,
          h: w.h,
        })),
      }),
    });
    if (ok) {
      if (data.revision) setRevision(data.revision);
      return;
    }
    // The write did not land, so the screen must not keep showing it: 409 means
    // another tab got there first, and anything else is a plain failure.
    setWidgets(previous ?? null);
    if (status === 409) {
      setError("چیدمان داشبورد از جای دیگری تغییر کرده بود؛ نسخهٔ تازه بارگذاری شد. تغییر خود را دوباره اعمال کنید.");
      load();
      return;
    }
    setError(data.error ?? "خطای غیرمنتظره در ذخیرهٔ چیدمان.");
  }

  function onLayoutChange(next: Layout) {
    if (!widgets || !editMode || stacked) return;
    const byId = new Map(next.map((l: LayoutItem) => [l.i, l]));
    const updated = widgets.map((w) => {
      const l = byId.get(w.id);
      return l ? { ...w, x: l.x, y: l.y, w: l.w, h: l.h } : w;
    });
    persist(updated);
  }

  function removeWidget(id: string) {
    if (!widgets) return;
    persist(widgets.filter((w) => w.id !== id));
  }

  return (
    <div>
      <ErrorBox>{error}</ErrorBox>
      {canEditLayout && widgets && widgets.length > 0 ? (
        <div className="mb-3 flex justify-end">
          <button
            type="button"
            onClick={() => setEditMode((v) => !v)}
            aria-pressed={editMode}
            className={`inline-flex h-9 items-center rounded-lg border px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40 ${editMode ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 text-amber-950 dark:text-amber-200 hover:bg-amber-200 dark:hover:bg-amber-500/25" : "border-border bg-card text-foreground/80 hover:bg-muted"}`}
          >
            {editMode ? "پایان ویرایش چیدمان" : "ویرایش چیدمان"}
          </button>
        </div>
      ) : null}
      {/*
        react-grid-layout positions items with `transform: translate(Xpx,Ypx)`
        and no explicit left/right — under dir="rtl" the browser's fallback
        "static position" for an absolutely-positioned box with both offsets
        auto anchors from the right edge instead of the left, so every
        translate() lands far off in the wrong place. Isolating the grid to
        dir="ltr" fixes the positioning; widget content re-declares dir="rtl"
        so Persian text still reads correctly inside each tile.

        We also don't import react-grid-layout's stylesheet, so the grid root
        never picks up its `position: relative`. Without it the absolutely
        positioned tiles resolve their offsetParent to a far-up ancestor, and
        the drag math (which bases the moving tile on clientRect - offsetParent
        rect) makes the box jump away from the cursor on grab. The `relative`
        class on GridLayout below makes the grid its own offsetParent so the
        tile tracks the pointer exactly.
      */}
      {/*
        The container ref must stay in the DOM from the first render, before
        widgets have loaded. useContainerWidth (with measureBeforeMount) only
        flips `mounted` to true when its effect finds `containerRef.current`
        attached, and that effect never re-runs while `mounted` stays false —
        so if this element were behind a `widgets === null` early return, the
        width would never be measured and the grid would never mount. Keeping
        it always rendered lets the width be measured on first paint; the
        loading and empty states live inside it (re-declaring dir="rtl" so the
        Persian text reads correctly).
      */}
      <div ref={containerRef} dir="ltr">
        {widgets === null ? (
          <LoadingSkeleton rows={4} label="در حال بارگذاری داشبورد" />
        ) : widgets.length === 0 ? (
          <p dir="rtl" className="flex min-h-52 items-center justify-center rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {canEdit
              ? "هنوز ابزارکی به داشبورد سنجاق نشده است. از صفحهٔ «گزارش‌ها» یک گزارش را به داشبورد سنجاق کنید."
              : "هنوز ابزارکی برای این نقش تنظیم نشده است."}
          </p>
        ) : mounted ? (
          <GridLayout
            className="relative"
            width={width}
            layout={layout}
            gridConfig={{ cols, rowHeight: 52, margin: [8, 8] }}
            dragConfig={{ enabled: editMode && !stacked }}
            resizeConfig={{ enabled: editMode && !stacked }}
            onDragStop={onLayoutChange}
            onResizeStop={onLayoutChange}
            autoSize
          >
            {widgets.map((w) => (
              <div key={w.id} dir="rtl" className={cn("overflow-hidden", cardClass)}>
                <div className="flex min-h-8 items-center justify-between border-b border-border/80 px-2.5 py-1.5">
                  <p className="truncate text-xs font-semibold text-muted-foreground">{w.title ?? w.report_name}</p>
                  {editMode ? (
                    <button
                      type="button"
                      onClick={() => removeWidget(w.id)}
                      className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label="حذف ابزارک"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  ) : null}
                </div>
                <div className="h-[calc(100%-2rem)] p-2">
                  <WidgetBody widget={w} canExplain={canExplain} />
                </div>
              </div>
            ))}
          </GridLayout>
        ) : null}
      </div>
    </div>
  );
}
