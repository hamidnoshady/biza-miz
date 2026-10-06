"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

/**
 * The service desk (Phase 36) — complaints and requests.
 *
 * Floor-accessible, because the person who hears a complaint is the person at
 * the counter. A ticket queue only the office can write to is a queue that
 * never matches what customers actually said.
 *
 * ## One filter document, and the server applies all of it
 *
 * The screen's controls write into a single `CaseViewFilters` — the document
 * `crm-case-views.ts` parses, serialises and describes. The request is built
 * from it, the chips are described from it, and `SavedViewsBar` hands its
 * filters back into it, so a saved view named «فوری‌های معوق» narrows the rows
 * exactly as its name says. Before this the desk declared six filter keys to
 * `crm_saved_views` and honoured two, which is how a shared view could open
 * looking perfectly normal and quietly show everything.
 *
 * ## One clock
 *
 * Lateness is decided by `crm-case-clock.ts` — the same rule behind the row's
 * badge, the SLA panel above the list and the `breached` filter the server
 * applies. The panel and the rows therefore cannot disagree, and a ticket in
 * «منتظر مشتری» is late for nothing, because the clock is the customer's then.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  CASE_PRIORITIES,
  CASE_PRIORITY_LABELS,
  CASE_PRIORITY_TARGET_HOURS,
  CASE_STATUSES,
  CASE_STATUS_LABELS,
  CASE_STATUS_TONES,
  type CasePriority,
  type CaseStatus,
} from "@/lib/crm-shared";
import { caseIsBreached } from "@/lib/crm-case-clock";
import {
  CASE_VIEW_FILTER_KEYS,
  EMPTY_CASE_VIEW_FILTERS,
  caseViewDuration,
  caseViewFilterCount,
  caseViewQuery,
  caseViewSearchParams,
  caseViewErrorLine,
  describeCaseView,
  parseCaseViewFilters,
  type CaseViewFilters,
} from "@/lib/crm-case-views";
import { EmptyState, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessage, Field, InfoBox, inputClass } from "@/app/dashboard/ui";
import { crmCustomerHref } from "./crm-routes";
import { CustomerSearchField } from "./customer-search";
import { CrmCardHeading } from "./crm-card-heading";
import { CrmAssigneePicker, type CrmAssignee } from "./crm-assignee-picker";
import { CrmTodayQueues } from "./today-queues";
import { SavedViewsBar } from "./saved-views-bar";

/** The SLA position across the desk — computed by the same clock as the rows. */
interface CaseSlaSummary {
  open: number;
  breached: number;
  waitingOnCustomer: number;
  atRisk: number;
  medianFirstResponseSeconds: number | null;
}

interface ServiceCase {
  id: string;
  customerId: string | null;
  customerName: string | null;
  subject: string;
  body: string;
  status: CaseStatus;
  priority: CasePriority;
  category: string;
  orderId: string | null;
  /** The display snapshot of the handler (see `crm-ownership.ts`). */
  assignedTo: string;
  /** The member handling it, when the handler is one. */
  assigneeUserId: string | null;
  resolution: string;
  openedAt: string;
  resolvedAt: string | null;
}

export function CasesSection({
  canDelete = false,
  canSaveViews = false,
}: {
  /** Owner/manager only — mirrors the DELETE route's own gate. */
  canDelete?: boolean;
  /** Mirrors `api/crm/saved-views`'s key, so the bar cannot offer a save that will 403. */
  canSaveViews?: boolean;
}) {
  const searchParams = useSearchParams();
  const [cases, setCases] = useState<ServiceCase[] | null>(null);
  const [sla, setSla] = useState<CaseSlaSummary | null>(null);
  /**
   * The one filter document this screen owns — built from the request, handed
   * to the saved-view bar and described for the chips.
   *
   * The desk opens on the open tickets, as it always has: a service desk that
   * starts by showing every ticket ever closed buries the ones that need
   * somebody today.
   */
  const [filters, setFilters] = useState<CaseViewFilters>(() => {
    // A queue opens here with its rule as the query string (`?breached=1&open=1`
    // is «خطر از دست رفتن مهلت»), so the rows a person lands on are the rows the
    // count promised. A URL with no filters starts on the screen's own default.
    const parsed = parseCaseViewFilters(searchParams);
    if (parsed.error) return { ...EMPTY_CASE_VIEW_FILTERS, openOnly: true };
    // A URL that names no filter key has asked for nothing — `?case=<id>` is a
    // deep link, not a view — so the desk keeps its own default: the open
    // tickets, not every ticket ever closed.
    const asked = CASE_VIEW_FILTER_KEYS.some((key) => searchParams.has(key));
    return asked ? parsed.filters : { ...EMPTY_CASE_VIEW_FILTERS, openOnly: true };
  });
  /** The member names the assignee filter and its chip can use. */
  const [members, setMembers] = useState<{ id: string; name: string; isActive: boolean }[]>([]);
  const [filterError, setFilterError] = useState("");
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ServiceCase | "new" | null>(null);
  const deepLinkId = searchParams.get("case");
  const [deepLinkHandled, setDeepLinkHandled] = useState(false);

  // `canDelete` and `canSaveViews` arrive from `crm-section.tsx`, which computes
  // them from `crm-permissions.ts` — the same table the endpoints are guarded
  // by. The screen holds no opinion of its own about permissions, because an
  // inline `includes("crm.manage")` is how the delete button came to be drawn
  // for people whose route required `crm.delete`.

  // `load(next)` takes the document explicitly rather than reading the state it
  // will soon be compared against: the refresh button, the first render and an
  // applied saved view all ask the same question of the same value. The cleanup
  // cancels a superseded fetch, so two quick filter changes cannot race each
  // other into the list.
  const load = useCallback((next: CaseViewFilters) => {
    let cancelled = false;
    const params = caseViewSearchParams(next);
    api<{
      cases: ServiceCase[];
      sla?: CaseSlaSummary;
      members?: { id: string; name: string; isActive: boolean }[];
      error?: string;
      field?: string;
    }>(`/api/crm/cases${params.size > 0 ? `?${params.toString()}` : ""}`).then(({ ok, data }) => {
      if (cancelled) return;
      if (ok) {
        setCases(data.cases);
        setSla(data.sla ?? null);
        if (Array.isArray(data.members)) setMembers(data.members);
        setFilterError("");
        setError("");
        return;
      }
      // A filter the server refused is the reader's own control, so it is named
      // beside the control — and the list keeps what it was showing, because
      // blanking it would read as «تیکتی نیست» when the truth is «آن فیلتر
      // معتبر نیست».
      if (data.error === "bad_filter") {
        setFilterError(caseViewErrorLine(data.field ?? ""));
        return;
      }
      setError("بارگذاری تیکت‌ها ناموفق بود.");
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => load(filters), [load, filters]);

  /**
   * Keep the address bar equal to the filter document.
   *
   * `replaceState`, not a navigation: the reader is already here. A URL copied
   * out of the address bar then reproduces exactly the list it was copied from,
   * and a queue's link stops being a one-way door — change a filter and the URL
   * no longer claims to be the queue. `?case=` is left alone: it belongs to the
   * deep-link effect below.
   */
  useEffect(() => {
    const url = new URL(window.location.href);
    for (const key of ["q", "status", "priority", "assignee", "open", "breached"]) {
      url.searchParams.delete(key);
    }
    for (const [key, value] of Object.entries(caseViewQuery(filters))) {
      url.searchParams.set(key, value);
    }
    window.history.replaceState(null, "", url.toString());
  }, [filters]);

  // The customer timeline links here as `/crm/cases?case=<id>`. Honour it:
  // fetch that one ticket (it may be resolved and thus invisible under the
  // default open-only filter) and open it directly. Non-UUID values are
  // ignored rather than sent to the API to trip over.
  useEffect(() => {
    if (!deepLinkId || deepLinkHandled) return;
    setDeepLinkHandled(true);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deepLinkId)) return;
    void api<{ case?: ServiceCase; error?: string }>(`/api/crm/cases/${deepLinkId}`).then(
      ({ ok, data }) => {
        if (ok && data.case) setEditing(data.case);
        else setError(errorMessage(data.error ?? "case_not_found"));
      },
    );
  }, [deepLinkId, deepLinkHandled]);

  if (!cases) {
    // A failed first load must surface the error, not an eternal skeleton.
    return (
      <div className="min-w-0 space-y-4">
        <ErrorBox>
          {error ? (
            <span className="flex flex-wrap items-center gap-2">
              {error}
              <Button type="button" variant="outline" size="xs" onClick={() => load(filters)}>
                تلاش دوباره
              </Button>
            </span>
          ) : null}
        </ErrorBox>
        {!error ? <SectionCardSkeleton rows={4} /> : null}
      </div>
    );
  }

  const now = new Date();

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>

      {/* The service desk's own outstanding work, above the list: a queue of
          tickets about to breach their target is the reason somebody opens
          this screen, not a report they read afterwards. */}
      <CrmTodayQueues section="cases" title="تیکت‌های نیازمند توجه" />

      {/* The SLA position, from the backend the rows are already judged by —
          and from *one* clock, so «۳ معوق» above cannot sit over rows that all
          look fine. The three figures stay apart on purpose: lumping tickets
          nobody has touched together with tickets waiting on the customer makes
          a number nobody can act on and hides the handful that matter today. */}
      {sla ? <CaseSlaPanel sla={sla} /> : null}

      {/* Named filter sets over this screen. The bar hands its filters back
          here, and every one of them is applied by the server: that is what
          lets a shared view («فوری‌های معوق») show what its name says. */}
      <SavedViewsBar
        entity="cases"
        current={caseViewQuery(filters)}
        onApply={(applied) => setFilters((current) => ({ ...current, ...normaliseAppliedFilters(applied) }))}
        canSave={canSaveViews}
        onNotice={setInfo}
      />

      {filterError ? <ErrorBox>{filterError}</ErrorBox> : null}
      {info ? <InfoBox>{info}</InfoBox> : null}

      <SectionCard
        title={
          <CrmCardHeading kicker="میز خدمت" title="تیکت‌های خدمات" />
        }
        description="شکایت‌ها و درخواست‌های مشتریان، با زمان هدف رسیدگی بر پایهٔ اولویت."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => load(filters)}
              aria-label="بازخوانی"
            >
              <RefreshCwIcon aria-hidden="true" className="size-4" />
            </Button>
            <Button type="button" onClick={() => setEditing("new")}>
              <PlusIcon aria-hidden="true" className="size-4" />
              تیکت جدید
            </Button>
          </div>
        }
      >
        <CaseFilterBar filters={filters} members={members} onChange={setFilters} />

        {cases.length === 0 ? (
          <EmptyState>
            {hasVisibleFilters(filters)
              ? "با این فیلترها تیکتی پیدا نشد."
              : filters.openOnly
                ? "تیکت بازی نمانده است."
                : "هنوز تیکتی ثبت نشده است."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border/80 text-sm">
            {cases.map((row) => {
              // The same clock the SLA panel and the `breached` filter use —
              // the row, the panel and the filter cannot disagree because
              // there is only one rule (`crm-case-clock.ts`).
              const breached = caseIsBreached(row, now);
              return (
                <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => setEditing(row)}
                      className="max-w-full break-words text-start font-medium text-foreground hover:underline"
                    >
                      {row.subject}
                    </button>
                    {row.body ? (
                      <p className="mt-0.5 line-clamp-2 break-words text-xs leading-5 text-muted-foreground">
                        {row.body}
                      </p>
                    ) : null}
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <StatusBadge tone={CASE_STATUS_TONES[row.status]}>
                        {CASE_STATUS_LABELS[row.status]}
                      </StatusBadge>
                      <StatusBadge tone={row.priority === "urgent" ? "danger" : "neutral"}>
                        {CASE_PRIORITY_LABELS[row.priority]}
                      </StatusBadge>
                      {breached ? <StatusBadge tone="danger">از زمان هدف گذشته</StatusBadge> : null}
                      {row.customerId && row.customerName ? (
                        <Link href={crmCustomerHref(row.customerId)} className="hover:underline">
                          {row.customerName}
                        </Link>
                      ) : null}
                      {/* The urgent target is 4 hours, so the opened time matters, not just the day. */}
                      <span>ثبت: {toPersianDigits(formatJalali(row.openedAt, { withTime: true }))}</span>
                      {row.resolvedAt ? (
                        <span>رسیدگی: {toPersianDigits(formatJalali(row.resolvedAt, { withTime: true }))}</span>
                      ) : null}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <p className="mt-3 text-xs leading-6 text-muted-foreground">
          زمان هدف رسیدگی: فوری {toPersianDigits(String(CASE_PRIORITY_TARGET_HOURS.urgent))} ساعت،
          زیاد {toPersianDigits(String(CASE_PRIORITY_TARGET_HOURS.high))} ساعت، عادی{" "}
          {toPersianDigits(String(CASE_PRIORITY_TARGET_HOURS.normal))} ساعت، کم{" "}
          {toPersianDigits(String(CASE_PRIORITY_TARGET_HOURS.low))} ساعت. تیکتی که «منتظر مشتری»
          است از زمان هدف نمی‌گذرد.
        </p>
      </SectionCard>

      {editing ? (
        <CaseDialog
          record={editing === "new" ? null : editing}
          canDelete={canDelete}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load(filters);
          }}
        />
      ) : null}
    </div>
  );
}

function CaseDialog({
  record,
  canDelete,
  onClose,
  onSaved,
}: {
  record: ServiceCase | null;
  /** Owner/manager only — mirrors the DELETE route's own gate. */
  canDelete?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [subject, setSubject] = useState(record?.subject ?? "");
  const [body, setBody] = useState(record?.body ?? "");
  const [status, setStatus] = useState<CaseStatus>(record?.status ?? "open");
  const [priority, setPriority] = useState<CasePriority>(record?.priority ?? "normal");
  const [category, setCategory] = useState(record?.category ?? "");
  // A handler is a member, not a typed name — same rule as the deals board and
  // the activity dialog, and the same control (`CrmAssigneePicker`), so
  // «تیکت‌های بی‌مسئول» cannot be answered by a name that resolves to nobody.
  const [assignee, setAssignee] = useState<CrmAssignee>({
    userId: record?.assigneeUserId ?? "",
    name: record?.assignedTo ?? "",
  });
  const [resolution, setResolution] = useState(record?.resolution ?? "");
  // Scoped to the customer slice — a ticket belongs to a customer, and an
  // unscoped search would offer suppliers and employees as matches.
  const [customerName, setCustomerName] = useState(record?.customerName ?? "");
  const [customerId, setCustomerId] = useState<string | null>(record?.customerId ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    if (!subject.trim()) {
      setError(errorMessage("case_subject_required"));
      return;
    }
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>("/api/crm/cases", {
      method: "POST",
      body: JSON.stringify({
        id: record?.id,
        subject: subject.trim(),
        body: body.trim(),
        status,
        priority,
        category: category.trim(),
        assigneeUserId: assignee.userId || null,
        assignedTo: assignee.name.trim(),
        resolution: resolution.trim(),
        customerId,
        // Threaded back unchanged so an edit never silently unlinks the ticket
        // from the order the complaint was about.
        orderId: record?.orderId ?? null,
      }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    onSaved();
  };

  const remove = async () => {
    if (!record || busy) return;
    if (!window.confirm(`تیکت «${record.subject}» برای همیشه حذف شود؟ بستن تیکت (وضعیت «بسته‌شده») معمولاً کافی است.`)) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>(`/api/crm/cases/${record.id}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    onSaved();
  };

  const resolved = status === "resolved" || status === "closed";

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="break-words">
            {record ? `تیکت: ${record.subject}` : "تیکت جدید"}
          </DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>

        <Field label="موضوع">
          <input className={inputClass} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="شرح">
          <textarea
            className={`${inputClass} h-auto min-h-20 py-2`}
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        <Field label="مشتری (اختیاری)">
          <CustomerSearchField
            selectedId={customerId}
            selectedName={customerName}
            onPick={(match) => {
              setCustomerId(match.id);
              setCustomerName(match.name);
            }}
            onClear={() => {
              setCustomerId(null);
              setCustomerName("");
            }}
            emptyText="مشتری‌ای با این مشخصات پیدا نشد."
          />
        </Field>
        <Field label="وضعیت">
          <select
            className={inputClass}
            value={status}
            onChange={(e) => setStatus(e.target.value as CaseStatus)}
          >
            {CASE_STATUSES.map((key) => (
              <option key={key} value={key}>
                {CASE_STATUS_LABELS[key]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="اولویت"
          hint={`زمان هدف رسیدگی: ${toPersianDigits(String(CASE_PRIORITY_TARGET_HOURS[priority]))} ساعت.`}
        >
          <select
            className={inputClass}
            value={priority}
            onChange={(e) => setPriority(e.target.value as CasePriority)}
          >
            {CASE_PRIORITIES.map((key) => (
              <option key={key} value={key}>
                {CASE_PRIORITY_LABELS[key]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="دسته (اختیاری)">
          <input className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)} />
        </Field>
        <CrmAssigneePicker
          label="مسئول رسیدگی (اختیاری)"
          value={assignee}
          onChange={setAssignee}
        />
        {resolved ? (
          <Field label="شرح رسیدگی" hint="چه کاری برای مشتری انجام شد.">
            <textarea
              className={`${inputClass} h-auto min-h-16 py-2`}
              rows={2}
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
            />
          </Field>
        ) : null}

        <DialogFooter>
          {record && canDelete ? (
            <Button
              type="button"
              variant="ghost"
              onClick={remove}
              disabled={busy}
              className="me-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              حذف
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            انصراف
          </Button>
          <Button type="button" onClick={save} disabled={busy}>
            {busy ? "در حال ذخیره…" : "ذخیره"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The desk's SLA position, from `caseSlaSummary()`.
 *
 * These figures exist on the backend already; the screen simply never showed
 * them, which meant the only place a person could learn that three tickets were
 * past target was by opening each one. They are rendered from the same clock the
 * rows and the `breached` filter use, so the panel cannot say «۲ معوق» over a
 * list of rows that all look fine.
 *
 * The figures are kept apart on purpose. A single «۱۲ تیکت معطل» that lumps
 * together tickets waiting on the customer and tickets nobody has touched makes
 * a number nobody can act on — and hides the handful that need somebody today.
 */
function CaseSlaPanel({ sla }: { sla: CaseSlaSummary }) {
  return (
    <div
      // Named so the five figures are one labelled group to assistive tech —
      // and so a test can ask *this* panel rather than a word that also
      // appears in the status filter.
      role="group"
      aria-label="وضعیت زمان هدف"
      className="rounded-2xl border border-border/80 p-3"
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-foreground">وضعیت زمان هدف</p>
        <p className="text-xs text-muted-foreground">
          تیکتی که «منتظر مشتری» است از زمان هدف نمی‌گذرد.
        </p>
      </div>
      <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <SlaFigure label="تیکت باز" value={toPersianDigits(String(sla.open))} />
        <SlaFigure
          label="از مهلت گذشته"
          value={toPersianDigits(String(sla.breached))}
          tone={sla.breached > 0 ? "danger" : undefined}
        />
        <SlaFigure label="منتظر مشتری" value={toPersianDigits(String(sla.waitingOnCustomer))} />
        <SlaFigure label="نزدیک مهلت" value={toPersianDigits(String(sla.atRisk))} />
        <SlaFigure
          label="میانهٔ اولین پاسخ"
          value={
            sla.medianFirstResponseSeconds === null
              ? "—"
              : caseViewDuration(sla.medianFirstResponseSeconds)
          }
        />
      </dl>
    </div>
  );
}

function SlaFigure({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={
          tone === "danger"
            ? "mt-1 font-semibold text-destructive"
            : "mt-1 font-semibold text-foreground"
        }
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * The filters a saved view applied, as a document.
 *
 * Deliberately a *replace* rather than a merge: applying «فوری‌های معوق» after
 * having searched for a name must not show one person's urgent tickets filtered
 * by last week's word. What the view stores is what the screen shows.
 */
function normaliseAppliedFilters(applied: Record<string, string>): CaseViewFilters {
  return {
    q: applied.q ?? "",
    status: applied.status ?? "",
    priority: applied.priority ?? "",
    assignee: applied.assignee ?? "",
    openOnly: applied.open === "1",
    breachedOnly: applied.breached === "1",
  };
}

/** Whether anything is narrowing the list — «هیچ تیکتی نیست» vs «با این فیلترها نمی‌شود». */
function hasVisibleFilters(filters: CaseViewFilters): boolean {
  return caseViewFilterCount(filters) > 0;
}

/**
 * The desk's filters, as controls.
 *
 * Every control writes into the one document the request is built from, and the
 * chips under it are described *from* that document — so a filter that is on is
 * a filter that is visible, and removing it is one click rather than a hunt
 * through the form. The count is the honest one (`caseViewFilterCount`), so the
 * reset control can say how much it is about to reset.
 */
function CaseFilterBar({
  filters,
  members,
  onChange,
}: {
  filters: CaseViewFilters;
  members: { id: string; name: string; isActive: boolean }[];
  onChange: (next: CaseViewFilters) => void;
}) {
  const chips = describeCaseView(filters, {
    memberName: (id) => members.find((member) => member.id === id)?.name ?? null,
  });
  const count = caseViewFilterCount(filters);

  return (
    <div className="mb-4 grid gap-3 rounded-2xl border border-border/80 p-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="min-w-0">
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="case-search">
            جست‌وجو
          </label>
          <input
            id="case-search"
            className={inputClass}
            value={filters.q}
            onChange={(event) => onChange({ ...filters, q: event.target.value })}
            placeholder="موضوع، شرح یا نام مشتری"
          />
        </div>

        <div className="min-w-0">
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="case-status">
            وضعیت
          </label>
          <select
            id="case-status"
            className={inputClass}
            value={filters.status}
            onChange={(event) => onChange({ ...filters, status: event.target.value })}
          >
            <option value="">همهٔ وضعیت‌ها</option>
            {CASE_STATUSES.map((key) => (
              <option key={key} value={key}>
                {CASE_STATUS_LABELS[key]}
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-0">
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="case-priority">
            اولویت
          </label>
          <select
            id="case-priority"
            className={inputClass}
            value={filters.priority}
            onChange={(event) => onChange({ ...filters, priority: event.target.value })}
          >
            <option value="">همهٔ اولویت‌ها</option>
            {CASE_PRIORITIES.map((key) => (
              <option key={key} value={key}>
                {CASE_PRIORITY_LABELS[key]}
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-0">
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="case-assignee">
            مسئول
          </label>
          <select
            id="case-assignee"
            className={inputClass}
            value={filters.assignee}
            onChange={(event) => onChange({ ...filters, assignee: event.target.value })}
          >
            <option value="">همه</option>
            <option value="mine">تیکت‌های من</option>
            {/* An unclaimed ticket is the one that rots, so "nobody" is a
                first-class answer rather than the absence of a filter. */}
            <option value="none">بدون مسئول</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
                {member.isActive ? "" : " (غیرفعال)"}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex min-h-10 items-center gap-2 text-sm text-foreground">
          <Checkbox
            checked={filters.openOnly}
            onCheckedChange={(checked) => onChange({ ...filters, openOnly: checked === true })}
          />
          فقط بازها
        </label>
        <label className="flex min-h-10 items-center gap-2 text-sm text-foreground">
          <Checkbox
            checked={filters.breachedOnly}
            onCheckedChange={(checked) => onChange({ ...filters, breachedOnly: checked === true })}
          />
          فقط معوق‌ها
        </label>
        <span className="text-xs text-muted-foreground">
          {count > 0 ? `${toPersianDigits(String(count))} فیلتر فعال` : "بدون فیلتر"}
        </span>
        {count > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            // Back to how this screen opens — the open tickets — rather than to
            // every ticket ever closed. Same rule as the task list's reset.
            onClick={() => onChange({ ...EMPTY_CASE_VIEW_FILTERS, openOnly: true })}
          >
            برداشتن فیلترها
          </Button>
        ) : null}
      </div>

      {chips.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="فیلترهای اعمال‌شده">
          {chips.map((chip) => (
            <li key={chip}>
              <StatusBadge tone="neutral">{chip}</StatusBadge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
