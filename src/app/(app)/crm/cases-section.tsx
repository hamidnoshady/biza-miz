"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

/**
 * The service desk (Phase 36) — complaints and requests.
 *
 * Floor-accessible, because the person who hears a complaint is the person at
 * the counter. A ticket queue only the office can write to is a queue that
 * never matches what customers actually said.
 *
 * `caseBreached` marks a ticket that has passed its priority's target. Note the
 * one asymmetry: a ticket in «منتظر مشتری» never breaches, because the clock
 * belongs to the customer then, and blaming the shop for the customer's silence
 * would make the whole indicator meaningless.
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
  caseBreached,
  type CasePriority,
  type CaseStatus,
} from "@/lib/crm-shared";
import { EmptyState, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessage, Field, inputClass } from "@/app/dashboard/ui";
import { crmCustomerHref } from "./crm-routes";
import { CustomerSearchField } from "./customer-search";
import { CrmCardHeading } from "./crm-card-heading";
import { CrmTodayQueues } from "./today-queues";

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
  assignedTo: string;
  resolution: string;
  openedAt: string;
  resolvedAt: string | null;
}

export function CasesSection({ canDelete = false }: { canDelete?: boolean }) {
  const [cases, setCases] = useState<ServiceCase[] | null>(null);
  const [openOnly, setOpenOnly] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ServiceCase | "new" | null>(null);
  const searchParams = useSearchParams();
  const deepLinkId = searchParams.get("case");
  const [deepLinkHandled, setDeepLinkHandled] = useState(false);

  // The server page derives this from the same effective crm.manage capability
  // enforced by the mutation API; role names are irrelevant here.

  // Returns a cleanup so a toggle of «فقط بازها» cancels the superseded fetch
  // instead of letting two in-flight responses race each other into the list.
  const load = useCallback(() => {
    let cancelled = false;
    api<{ cases: ServiceCase[] }>(`/api/crm/cases${openOnly ? "?open=1" : ""}`).then(
      ({ ok, data }) => {
        if (cancelled) return;
        if (ok) {
          setCases(data.cases);
          setError("");
        } else setError("بارگذاری تیکت‌ها ناموفق بود.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [openOnly]);
  useEffect(load, [load]);

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
              <Button type="button" variant="outline" size="xs" onClick={load}>
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

      <SectionCard
        title={
          <CrmCardHeading kicker="میز خدمت" title="تیکت‌های خدمات" />
        }
        description="شکایت‌ها و درخواست‌های مشتریان، با زمان هدف رسیدگی بر پایهٔ اولویت."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={openOnly}
                onCheckedChange={(checked) => setOpenOnly(checked === true)}
              />
              فقط بازها
            </label>
            <Button type="button" variant="ghost" size="icon-sm" onClick={load} aria-label="بازخوانی">
              <RefreshCwIcon aria-hidden="true" className="size-4" />
            </Button>
            <Button type="button" onClick={() => setEditing("new")}>
              <PlusIcon aria-hidden="true" className="size-4" />
              تیکت جدید
            </Button>
          </div>
        }
      >
        {cases.length === 0 ? (
          <EmptyState>
            {openOnly ? "تیکت بازی نمانده است." : "هنوز تیکتی ثبت نشده است."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border/80 text-sm">
            {cases.map((row) => {
              const breached = caseBreached(row, now);
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
            load();
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
  const [assignedTo, setAssignedTo] = useState(record?.assignedTo ?? "");
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
        assignedTo: assignedTo.trim(),
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
        <Field label="مسئول رسیدگی (اختیاری)">
          <input
            className={inputClass}
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
          />
        </Field>
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
