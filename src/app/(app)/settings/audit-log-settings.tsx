"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, RefreshCw, SearchX } from "lucide-react";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { auditActionLabel, auditEntityLabel, credentialKindLabel, type CredentialKind } from "@/lib/audit";
import { ErrorBox, api, errorMessage } from "@/app/dashboard/ui";
import { LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";

interface AuditEntry {
  id: number;
  actorName: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  entityName: string | null;
  locationName: string | null;
  createdAt: string;
  credentialType: string | null;
  deviceLabel: string | null;
}

const PAGE_SIZE = 50;
const ENTITY_FILTERS = [
  ["", "همه"], ["employee", "کارمند"], ["team", "تیم"], ["device", "دستگاه"],
  ["shift", "شیفت"], ["order", "سفارش"], ["location", "شعبه"], ["account", "حساب"],
  ["fiscal_year", "سال مالی"], ["fiscal_period", "دورهٔ مالی"],
  // The settings writers (business identity, MFA policy) log under this
  // entity; without the chip those rows were reachable only via «همه».
  ["settings", "تنظیمات"],
] as const;

function formatTime(iso: string): string {
  try {
    return toPersianDigits(formatJalali(iso, { withMonthName: true, withTime: true }));
  } catch {
    return "زمان نامشخص";
  }
}

function sessionDetail(entry: AuditEntry): string | null {
  if (entry.action !== "employee.session_created") return null;
  const kind: CredentialKind = entry.credentialType === "webauthn" ? "webauthn" : "pin";
  return [`با ${credentialKindLabel(kind)}`, entry.deviceLabel ? `از دستگاه «${entry.deviceLabel}»` : ""]
    .filter(Boolean).join(" ");
}

export function AuditLogSettings() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [entity, setEntity] = useState("");
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const requestId = useRef(0);

  const load = useCallback(async (filterEntity: string, before?: number) => {
    const currentRequest = ++requestId.current;
    if (before) setLoadingMore(true);
    else setEntries(null);
    setError("");
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (filterEntity) qs.set("entity", filterEntity);
    if (before) qs.set("before", String(before));

    const { ok, data } = await api<{ entries?: AuditEntry[]; error?: string }>(`/api/audit-log?${qs}`);
    if (currentRequest !== requestId.current) return;
    setLoadingMore(false);
    if (!ok) {
      setError(errorMessage(data.error));
      if (!before) setEntries([]);
      return;
    }
    const page = data.entries ?? [];
    setEntries((old) => before ? [...(old ?? []), ...page] : page);
    setHasMore(page.length === PAGE_SIZE);
  }, []);

  useEffect(() => {
    setExpanded(new Set());
    void load(entity);
  }, [load, entity]);

  function toggle(id: number) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <SectionCard title="گزارش حسابرسی">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            سابقهٔ تغییرات و رویدادهای امنیتی کسب‌وکار، از جدیدترین به قدیمی‌ترین. این گزارش فقط خواندنی است.
          </p>
          <Button type="button" variant="outline" size="sm" className="w-full shrink-0 sm:w-auto"
            onClick={() => void load(entity)} disabled={entries === null}>
            <RefreshCw className="h-4 w-4" aria-hidden /> تازه‌سازی
          </Button>
        </div>
        <ErrorBox>{error}</ErrorBox>

        <div className="-mx-1 mb-5 overflow-x-auto px-1 pb-1" role="group" aria-label="فیلتر نوع رویداد">
          <div className="flex min-w-max gap-2">
            {ENTITY_FILTERS.map(([value, label]) => (
              <button key={value} type="button" onClick={() => setEntity(value)} aria-pressed={entity === value}
                className={`min-h-10 rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
            entity === value
                    ? "border-amber-300 bg-amber-100 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/20 dark:text-amber-200"
                    : "border-border/80 text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {entries === null ? <LoadingSkeleton rows={5} /> : null}
        {entries !== null && entries.length === 0 && !error ? (
          <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-4 py-10 text-center">
            <SearchX className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden />
            <p className="font-medium">رویدادی در این دسته ثبت نشده است.</p>
            {entity ? <button className="mt-2 text-sm text-primary hover:underline" onClick={() => setEntity("")}>نمایش همهٔ رویدادها</button> : null}
          </div>
        ) : null}

        {entries && entries.length > 0 ? (
          <div className="space-y-2" aria-live="polite">
            {entries.map((entry) => {
              const open = expanded.has(entry.id);
              const detail = sessionDetail(entry);
              // A log entry is a list row *inside* a card, so it takes the
              // canonical inner-wash (same skin as the ledger's entry lists),
              // not a restated card skin — design-lint bans the latter.
              return (
                <article key={entry.id} className="rounded-xl border border-border/80 bg-muted/60 px-3 py-3 sm:px-4">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                    <p className="min-w-0 font-medium leading-6">{auditActionLabel(entry.action)}</p>
                    <time dateTime={entry.createdAt} className="shrink-0 text-xs leading-6 text-muted-foreground">
                      {formatTime(entry.createdAt)}
                    </time>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>{entry.actorName ?? "سیستم"}</span><span aria-hidden>·</span>
                    <span>{auditEntityLabel(entry.entity)}</span>
                    {entry.entityName ? <><span aria-hidden>·</span><span>{entry.entityName}</span></> : null}
                    {detail ? <><span aria-hidden>·</span><span>{detail}</span></> : null}
                  </div>
                  {(entry.locationName || entry.entityId) ? (
                    <button type="button" onClick={() => toggle(entry.id)} aria-expanded={open}
                      className="mt-2 inline-flex min-h-8 items-center gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                      {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      {open ? "بستن جزئیات" : "جزئیات"}
                    </button>
                  ) : null}
                  {open ? (
                    <dl className="mt-2 grid gap-2 rounded-lg bg-muted/60 p-3 text-xs sm:grid-cols-2">
                      {entry.locationName ? <div><dt className="text-muted-foreground">شعبه</dt><dd className="mt-0.5 font-medium">{entry.locationName}</dd></div> : null}
                      {entry.entityId ? <div className="min-w-0"><dt className="text-muted-foreground">شناسهٔ رکورد</dt><dd dir="ltr" className="mt-0.5 truncate text-left font-mono" title={entry.entityId}>{entry.entityId}</dd></div> : null}
                    </dl>
                  ) : null}
                </article>
              );
            })}
            {hasMore ? (
              <div className="pt-2 text-center">
                <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={loadingMore}
                  onClick={() => void load(entity, entries[entries.length - 1]?.id)}>
                  {loadingMore ? "در حال دریافت…" : "نمایش رویدادهای قدیمی‌تر"}
                </Button>
              </div>
            ) : <p className="pt-2 text-center text-xs text-muted-foreground">همهٔ رویدادهای موجود نمایش داده شد.</p>}
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}
