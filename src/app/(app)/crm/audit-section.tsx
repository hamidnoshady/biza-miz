"use client";

/**
 * CRM → «سابقهٔ تصمیم‌ها» — the decision log.
 *
 * ## What this screen is for
 *
 * Six months after a customer complains that their consent was switched off, or
 * asks why they were merged with somebody else, this is the screen that answers
 * it: **who decided this, and when**. It reads `crm_audit_events`, which only
 * ever grows.
 *
 * ## What it is not
 *
 * It is not the customer timeline and does not replace it. The timeline is a
 * mapping over the tables that own each fact — the order, the note, the case —
 * and shows one person's whole history across every app. This log holds only
 * the *judgements* that leave no natural row behind, which is why a customer's
 * orders do not appear here and why a merge does.
 *
 * ## Why the filters are menus of what happened
 *
 * The kind and actor filters are built from the log's own `GROUP BY` counts, not
 * from a hardcoded vocabulary, so a business that has never merged anybody does
 * not get an empty «ادغام» option. The two menus are deliberately *not*
 * narrowed by the current filters: a menu that shrinks to the selection already
 * made cannot be used to change it.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  crmAuditEntityLabel,
  crmAuditKindLabel,
  CRM_AUDIT_ENTITY_TYPES,
} from "@/lib/crm-shared";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, inputClass } from "@/app/dashboard/ui";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { SearchField } from "@/app/dashboard/filters";
import { crmCustomerHref } from "./crm-routes";
import { CrmCardHeading } from "./crm-card-heading";

interface AuditEvent {
  id: string;
  kind: string;
  entityType: string;
  entityId: string | null;
  partyId: string | null;
  partyName: string | null;
  summary: string;
  detail: Record<string, unknown>;
  actorUserId: string | null;
  actorName: string;
  createdAt: string;
}

interface AuditPage {
  events: AuditEvent[];
  total: number;
  actors: { userId: string; name: string; count: number }[];
  kinds: { kind: string; count: number }[];
}

interface Filters {
  q: string;
  kind: string;
  actor: string;
  entityType: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = { q: "", kind: "", actor: "", entityType: "", from: "", to: "" };

export function CrmAuditSection() {
  const [page, setPage] = useState<AuditPage | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback((active: Filters, signal?: AbortSignal) => {
    setRefreshing(true);
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(active)) {
      if (value) search.set(key, value);
    }
    search.set("limit", "100");
    return api<AuditPage>(`/api/crm/audit?${search.toString()}`, { signal }).then(
      ({ ok, data, aborted }) => {
        // A superseded request must not clobber fresher state, and an
        // unmounted component must not flip its busy flags.
        if (aborted) return;
        if (ok) {
          setPage({
            events: data.events ?? [],
            total: data.total ?? 0,
            actors: data.actors ?? [],
            kinds: data.kinds ?? [],
          });
          setError("");
        } else {
          setError("بارگذاری سابقهٔ تصمیم‌ها ناموفق بود.");
        }
        setLoading(false);
        setRefreshing(false);
      },
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(filters, controller.signal);
    return () => controller.abort();
  }, [load, filters]);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const filtered = Object.values(filters).some((value) => value !== "");

  if (loading && !page) return <SectionCardSkeleton rows={5} />;

  if (!page) {
    return (
      <div className="min-w-0 space-y-4">
        <ErrorBox>{error || "بارگذاری سابقهٔ تصمیم‌ها ناموفق بود."}</ErrorBox>
        <SectionCard title={<CrmCardHeading kicker="حاکمیت" title="سابقهٔ تصمیم‌ها" />}>
          <EmptyState>اطلاعات سابقهٔ تصمیم‌ها دریافت نشد.</EmptyState>
          <div className="mt-3 flex justify-center">
            <Button type="button" variant="outline" size="sm" onClick={() => load(filters)} disabled={refreshing}>
              <RefreshCwIcon aria-hidden="true" className="size-4" />
              {refreshing ? "در حال تلاش…" : "تلاش دوباره"}
            </Button>
          </div>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <SectionCard
        title={<CrmCardHeading kicker="حاکمیت" title="سابقهٔ تصمیم‌ها" />}
        description="تصمیم‌هایی که ردّ طبیعی در هیچ جدول دیگری نمی‌گذارند: ادغام، تبدیل سرنخ، تغییر مرحله، تطبیق هویت و تغییر رضایت. این دفتر فقط افزودنی است."
        actions={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => load(filters)}
            disabled={refreshing}
            aria-label="بازخوانی"
            aria-busy={refreshing}
          >
            <RefreshCwIcon aria-hidden="true" className="size-4" />
          </Button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="جست‌وجو" hint="در خلاصهٔ تصمیم و نام تصمیم‌گیرنده.">
            <SearchField
              value={filters.q}
              onChange={(value) => set("q", value)}
              placeholder="مثلاً ادغام یا نام عضو تیم"
              label="جست‌وجو در سابقهٔ تصمیم‌ها"
            />
          </Field>
          <Field label="نوع تصمیم">
            <select
              className={inputClass}
              value={filters.kind}
              onChange={(event) => set("kind", event.target.value)}
            >
              <option value="">همهٔ تصمیم‌ها</option>
              {page.kinds.map((entry) => (
                <option key={entry.kind} value={entry.kind}>
                  {crmAuditKindLabel(entry.kind)} ({entry.count})
                </option>
              ))}
            </select>
          </Field>
          <Field label="تصمیم‌گیرنده">
            <select
              className={inputClass}
              value={filters.actor}
              onChange={(event) => set("actor", event.target.value)}
            >
              <option value="">همه</option>
              {page.actors.map((actor) => (
                <option key={actor.userId} value={actor.userId}>
                  {actor.name} ({actor.count})
                </option>
              ))}
            </select>
          </Field>
          <Field label="نوع پرونده">
            <select
              className={inputClass}
              value={filters.entityType}
              onChange={(event) => set("entityType", event.target.value)}
            >
              <option value="">همه</option>
              {CRM_AUDIT_ENTITY_TYPES.map((entity) => (
                <option key={entity} value={entity}>
                  {crmAuditEntityLabel(entity)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="از تاریخ" hint="تقویم شمسی؛ روز شروع هم شامل می‌شود.">
            <JalaliDatePicker
              value={filters.from}
              onChange={(iso) => set("from", iso)}
              ariaLabel="از تاریخ"
            />
          </Field>
          <Field label="تا تاریخ" hint="تقویم شمسی؛ تمام روز پایان شامل می‌شود.">
            <JalaliDatePicker
              value={filters.to}
              onChange={(iso) => set("to", iso)}
              ariaLabel="تا تاریخ"
            />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {formatPersianNumber(page.total)} تصمیم ثبت‌شده
            {filtered ? " با این فیلترها" : ""}
            {page.events.length < page.total
              ? ` — ${formatPersianNumber(page.events.length)} مورد آخر نمایش داده می‌شود.`
              : ""}
          </p>
          {filtered ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
              پاک کردن فیلترها
            </Button>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        title={<CrmCardHeading kicker="دفتر تصمیم‌ها" title="آخرین رویدادها" />}
        description="جدیدترین بالا. ردیف‌ها ویرایش یا حذف نمی‌شوند."
      >
        {page.events.length === 0 ? (
          <EmptyState>
            {filtered
              ? "با این فیلترها تصمیمی ثبت نشده است."
              : "هنوز تصمیمی ثبت نشده است. ادغام، تبدیل سرنخ، تغییر مرحله و تغییر رضایت اینجا ثبت می‌شوند."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border/80 text-sm">
            {page.events.map((event) => (
              <AuditRow key={event.id} event={event} />
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function AuditRow({ event }: { event: AuditEvent }) {
  const details = Object.entries(event.detail ?? {}).filter(
    ([, value]) => value !== null && value !== undefined && value !== "",
  );
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="leading-6 text-foreground">{event.summary}</p>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <StatusBadge tone="neutral">{crmAuditKindLabel(event.kind)}</StatusBadge>
          <span>{crmAuditEntityLabel(event.entityType)}</span>
          {event.partyId && event.partyName ? (
            <Link href={crmCustomerHref(event.partyId)} className="font-medium text-foreground hover:underline">
              {event.partyName}
            </Link>
          ) : null}
          {/* Evidence needs the time of day, not only the date: «کِی این اتفاق
              افتاد» is the question this page exists to answer. */}
          <time dateTime={event.createdAt}>{toPersianDigits(formatJalali(event.createdAt, { withTime: true }))}</time>
          <span aria-hidden="true">·</span>
          <span>{event.actorName || "بدون تصمیم‌گیرندهٔ ثبت‌شده"}</span>
        </p>
        {details.length > 0 ? (
          <details className="mt-1.5">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              جزئیات
            </summary>
            <dl className="mt-1.5 space-y-1 ps-3">
              {details.map(([key, value]) => (
                <div key={key} className="flex flex-wrap gap-x-2 text-xs">
                  <dt className="font-medium text-muted-foreground">{key}</dt>
                  <dd className="min-w-0 break-all text-foreground">{formatDetailValue(value)}</dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}
      </div>
    </li>
  );
}

/** A detail value is arbitrary JSON, so it is rendered as text and never as markup. */
function formatDetailValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return toPersianDigits(String(value));
  return JSON.stringify(value);
}
