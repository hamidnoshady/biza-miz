"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GridLayout, useContainerWidth, type Layout, type LayoutItem } from "react-grid-layout";
import { SparklesIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useMoney } from "@/components/money/money-context";
import { ALL_ROLES } from "@/lib/roles";
import { ROLE_LABELS } from "@/lib/role-labels";
import { reportConfigIsMoney, type ReportConfig } from "@/lib/reports";
import type { DashboardWidgetPrecondition } from "@/lib/reports-service";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { cn } from "@/lib/utils";
import { cardClass, LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, inputClass } from "./ui";
import { BarChart, LineChart, NumberCard, PieChart, type ChartDatum, type ChartValueFormatter } from "./charts";
import type { Role } from "@/lib/auth-edge";

type ChartType = "line" | "bar" | "pie" | "number";

type LayoutTarget = { scope: "personal" } | { scope: "role-default"; role: Role };

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
  report_config: ReportConfig;
  applicable?: boolean;
  applicable_reason?: "standard_report_not_in_trade" | "unknown_view";
}

interface WidgetLayoutResponse {
  scope: "personal" | "role-default";
  widgets: WidgetRow[];
  precondition: DashboardWidgetPrecondition;
}

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

const formatNumber: ChartValueFormatter = (value) =>
  toPersianDigits(Math.round(value).toLocaleString("en-US"));

function useWidgetData(config: ReportConfig, enabled = true) {
  const [state, setState] = useState<{ data: ChartDatum[] | null; error: string }>({ data: null, error: "" });
  const configKey = JSON.stringify(config);
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    if (!enabled) {
      setState({ data: null, error: "" });
      return () => {
        cancelled = true;
        controller.abort();
      };
    }
    api<{ rows?: { dim: string | null; value: string | number | null }[]; message?: string }>(
      "/api/reports/query",
      { method: "POST", body: configKey, signal: controller.signal },
    ).then(({ ok, data: res, aborted }) => {
      if (cancelled || aborted) return;
      if (ok && res.rows) {
        setState({ data: res.rows.map((row) => ({ label: formatDim(row.dim), value: Number(row.value) || 0 })), error: "" });
      } else {
        setState({ data: [], error: res.message ?? "این ابزارک قابل خواندن نیست." });
      }
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [configKey, enabled]);
  return state;
}

function requestWidgetExplanation(
  widget: WidgetRow,
  data: ChartDatum[],
  formatValue: ChartValueFormatter,
) {
  const title = widget.title ?? widget.report_name;
  const facts = data.slice(0, 8).map((row) => `${row.label}: ${formatValue(row.value)}`).join("؛ ");
  const prompt = [
    `عدد یا نمودار «${title}» را با اتکا به داده‌های واقعی گزارش بررسی و توضیح بده.`,
    facts ? `دادهٔ نمایشی فعلی: ${facts}.` : "",
    "اگر دادهٔ کافی برای نتیجه‌گیری وجود ندارد، صریح بگو چه گزارشی باید بررسی شود؛ عددی را حدس نزن.",
  ].filter(Boolean).join("\n");
  window.dispatchEvent(new CustomEvent("ai:prefill", { detail: { prompt } }));
}

function WidgetBody({ widget, canExplain }: { widget: WidgetRow; canExplain: boolean }) {
  const { data, error } = useWidgetData(widget.report_config, widget.applicable !== false);
  const money = useMoney();
  const isMoney = reportConfigIsMoney(widget.report_config);
  const formatValue = isMoney ? money.format : formatNumber;

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

  const chart = widget.chart_type === "number" ? (
    <NumberCard
      label={widget.title ?? widget.report_name}
      value={formatValue(data.reduce((sum, row) => sum + row.value, 0))}
    />
  ) : widget.chart_type === "line" ? (
    <LineChart data={data} formatValue={formatValue} />
  ) : widget.chart_type === "pie" ? (
    <PieChart data={data} formatValue={formatValue} />
  ) : (
    <BarChart data={data} formatValue={formatValue} />
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="min-h-0 flex-1">{chart}</div>
      {canExplain ? (
        <button
          type="button"
          onClick={() => requestWidgetExplanation(widget, data, formatValue)}
          className="inline-flex min-h-8 w-fit items-center gap-1 rounded-lg px-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SparklesIcon className="size-3.5" /> توضیح این عدد
        </button>
      ) : null}
    </div>
  );
}

// The 12-column grid is too cramped below this width, so mobile stacks tiles
// without mutating their saved desktop positions.
const STACK_MAX_WIDTH = 640;

export function DashboardGrid({
  canEdit,
  canExplain,
  canManageRoleDefaults = false,
}: {
  canEdit: boolean;
  canExplain: boolean;
  canManageRoleDefaults?: boolean;
}) {
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  const [widgets, setWidgets] = useState<WidgetRow[] | null>(null);
  const [precondition, setPrecondition] = useState<DashboardWidgetPrecondition | null>(null);
  const [target, setTarget] = useState<LayoutTarget>({ scope: "personal" });
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const saveInFlight = useRef(false);
  const loadController = useRef<AbortController | null>(null);

  const stacked = mounted && width > 0 && width < STACK_MAX_WIDTH;
  const cols = stacked ? 1 : 12;
  const canEditTarget = target.scope === "personal" ? canEdit : canManageRoleDefaults;
  const targetUrl = target.scope === "personal"
    ? "/api/dashboard/widgets"
    : `/api/dashboard/widgets?scope=role-default&role=${encodeURIComponent(target.role)}`;

  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setWidgets(null);
    setPrecondition(null);
    setLoadError("");
    const { ok, data, aborted } = await api<WidgetLayoutResponse>(targetUrl, { signal: controller.signal });
    if (aborted || controller.signal.aborted) return;
    if (!ok || !Array.isArray(data.widgets) || !data.precondition) {
      setLoadError("بارگذاری ابزارک‌های سنجاق‌شده ناموفق بود. دوباره تلاش کنید.");
      return;
    }
    setWidgets(data.widgets);
    setPrecondition(data.precondition);
  }, [targetUrl]);

  useEffect(() => {
    void load();
    return () => loadController.current?.abort();
  }, [load]);

  const layout: Layout = useMemo(() => {
    const items = widgets ?? [];
    if (stacked) {
      let y = 0;
      return [...items]
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((widget) => {
          const h = Math.max(widget.h, 3);
          const item = { i: widget.id, x: 0, y, w: 1, h, minW: 1, minH: 2 };
          y += h;
          return item;
        });
    }
    return items.map((widget) => ({
      i: widget.id,
      x: widget.x,
      y: widget.y,
      w: widget.w,
      h: widget.h,
      minW: 2,
      minH: 2,
    }));
  }, [widgets, stacked]);

  async function persist(next: WidgetRow[]) {
    if (!widgets || !precondition || saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    const previous = widgets;
    setWidgets(next);
    setError("");
    const scope = target.scope === "role-default" ? "role" : "personal";
    const body = {
      scope,
      ...(target.scope === "role-default" ? { role: target.role } : {}),
      precondition,
      widgets: next.map((widget) => ({
        savedReportId: widget.saved_report_id,
        chartType: widget.chart_type,
        title: widget.title,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
      })),
    };

    try {
      const { ok, data, status } = await api<{
        error?: string;
        revision?: string;
        precondition?: DashboardWidgetPrecondition;
      }>("/api/dashboard/widgets", { method: "POST", body: JSON.stringify(body) });
      if (ok && data.precondition) {
        setPrecondition(data.precondition);
        return;
      }
      setWidgets(previous);
      if (status === 409) {
        setError("چیدمان از زمان بارگذاری تغییر کرده بود؛ نسخهٔ تازه بارگذاری شد. تغییر خود را دوباره اعمال کنید.");
        void load();
        return;
      }
      setError(data.error ?? "خطای غیرمنتظره در ذخیرهٔ چیدمان.");
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  function onLayoutChange(next: Layout) {
    if (!widgets || !editMode || stacked || saveInFlight.current) return;
    const byId = new Map(next.map((item: LayoutItem) => [item.i, item]));
    const updated = widgets.map((widget) => {
      const item = byId.get(widget.id);
      return item ? { ...widget, x: item.x, y: item.y, w: item.w, h: item.h } : widget;
    });
    void persist(updated);
  }

  function removeWidget(id: string) {
    if (!widgets || saveInFlight.current) return;
    void persist(widgets.filter((widget) => widget.id !== id));
  }

  function changeTarget(next: LayoutTarget) {
    if (saving) return;
    setEditMode(false);
    setError("");
    setLoadError("");
    setTarget(next);
  }

  const isInheriting = target.scope === "personal" && precondition?.source.scope === "role-default";
  const isExplicitEmpty = target.scope === "personal" && precondition?.source.scope === "personal" && widgets?.length === 0;

  return (
    <div className="space-y-3">
      <ErrorBox>{error}</ErrorBox>

      {canManageRoleDefaults ? (
        <div className="grid gap-3 rounded-xl border border-border/80 bg-muted p-3 sm:grid-cols-2 sm:p-4">
          <Field label="چیدمان نمایشی">
            <SearchableSelect
              className={inputClass}
              ariaLabel="چیدمان نمایشی"
              value={target.scope}
              disabled={saving}
              onChange={(value) => {
                if (value === "personal") changeTarget({ scope: "personal" });
                else changeTarget({ scope: "role-default", role: "owner" });
              }}
              options={[
                { value: "personal", label: "چیدمان شخصی من" },
                { value: "role-default", label: "پیش‌فرض نقش‌ها" },
              ]}
            />
          </Field>
          {target.scope === "role-default" ? (
            <Field label="نقش دریافت‌کنندهٔ پیش‌فرض">
              <SearchableSelect
                className={inputClass}
                ariaLabel="نقش دریافت‌کنندهٔ پیش‌فرض"
                value={target.role}
                disabled={saving}
                onChange={(value) => changeTarget({ scope: "role-default", role: value as Role })}
                options={ALL_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] }))}
              />
            </Field>
          ) : null}
        </div>
      ) : null}

      {target.scope === "role-default" ? (
        <p role="status" className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs leading-5 text-muted-foreground">
          این پیش‌فرض فقط برای اعضای نقش «{ROLE_LABELS[target.role]}» است که چیدمان شخصی نساخته‌اند؛ اعضای دارای چیدمان شخصی از آن ارث‌بری نمی‌کنند.
        </p>
      ) : isInheriting ? (
        <p role="status" className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs leading-5 text-muted-foreground">
          این چیدمان از پیش‌فرض نقش شما می‌آید. نخستین ویرایش، یک نسخهٔ شخصی می‌سازد و پیش‌فرض نقش را تغییر نمی‌دهد.
        </p>
      ) : isExplicitEmpty ? (
        <p role="status" className="rounded-lg border border-border/70 bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
          چیدمان شخصی شما خالی است و به‌صورت عمدی از پیش‌فرض نقش استفاده نمی‌کند. سنجاق‌کردن یک گزارش، آن را به همین چیدمان اضافه می‌کند.
        </p>
      ) : null}

      {canEditTarget && widgets && widgets.length > 0 ? (
        <div className="mb-3 flex justify-end">
          <Button
            type="button"
            variant={editMode ? "secondary" : "outline"}
            size="sm"
            onClick={() => setEditMode((value) => !value)}
            aria-pressed={editMode}
            disabled={saving}
          >
            {saving ? "در حال ذخیره…" : editMode ? "پایان ویرایش چیدمان" : stacked ? "مدیریت ابزارک‌ها" : "ویرایش چیدمان"}
          </Button>
        </div>
      ) : null}

      {editMode && stacked ? (
        <p role="status" className="text-xs leading-5 text-muted-foreground">
          در نمایش تلفن، جایگاه دسکتاپ ثابت می‌ماند؛ می‌توانید ابزارک‌ها را حذف کنید.
        </p>
      ) : null}

      {/* react-grid-layout's positioning is LTR; each tile restores RTL content. */}
      <div ref={containerRef} dir="ltr">
        {widgets === null ? (
          loadError ? (
            <div dir="rtl" className="flex min-h-52 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border p-6 text-center">
              <p role="alert" className="text-sm text-destructive">{loadError}</p>
              <Button type="button" variant="outline" onClick={() => void load()}>تلاش دوباره</Button>
            </div>
          ) : <LoadingSkeleton rows={4} label="در حال بارگذاری ابزارک‌های سنجاق‌شده" />
        ) : widgets.length === 0 ? (
          <div dir="rtl" className="flex min-h-52 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border p-6 text-center">
            <p className="text-sm text-muted-foreground">
              {target.scope === "role-default"
                ? "برای این نقش هنوز پیش‌فرضی تنظیم نشده است."
                : isExplicitEmpty
                  ? "چیدمان شخصی شما خالی است. از گزارش‌های آماده یا گزارش‌ساز، گزارشی را به داشبورد گزارش‌ها سنجاق کنید."
                  : "هنوز ابزارکی به داشبورد گزارش‌ها سنجاق نشده است. از گزارش‌های آماده یا گزارش‌ساز شروع کنید."}
            </p>
            {isInheriting && canEditTarget ? (
              <Button type="button" variant="outline" disabled={saving} onClick={() => void persist([])}>
                ثبت چیدمان شخصی خالی
              </Button>
            ) : null}
          </div>
        ) : mounted ? (
          <GridLayout
            className="relative"
            width={width}
            layout={layout}
            gridConfig={{ cols, rowHeight: 52, margin: [8, 8] }}
            dragConfig={{ enabled: editMode && !stacked && !saving }}
            resizeConfig={{ enabled: editMode && !stacked && !saving }}
            onDragStop={onLayoutChange}
            onResizeStop={onLayoutChange}
            autoSize
          >
            {widgets.map((widget) => (
              <div key={widget.id} dir="rtl" className={cn("overflow-hidden", cardClass)}>
                <div className="flex min-h-8 items-center justify-between border-b border-border/80 px-2.5 py-1.5">
                  <p className="truncate text-xs font-semibold text-muted-foreground">{widget.title ?? widget.report_name}</p>
                  {editMode ? (
                    <button
                      type="button"
                      onClick={() => removeWidget(widget.id)}
                      disabled={saving}
                      className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      aria-label="حذف ابزارک"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  ) : null}
                </div>
                <div className="h-[calc(100%-2rem)] p-2">
                  <WidgetBody widget={widget} canExplain={canExplain} />
                </div>
              </div>
            ))}
          </GridLayout>
        ) : null}
      </div>
    </div>
  );
}
