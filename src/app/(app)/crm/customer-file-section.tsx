"use client";

import { LoadingSkeleton, SectionCardSkeleton } from "@/app/dashboard/page-chrome";

/**
 * The 360° customer file (Phase 36) — the app's centrepiece.
 *
 * One screen that answers "who is this person": the record, what they have
 * bought, where they sit in the lifecycle, what was said to them, what they are
 * waiting for, and what they agreed to be contacted about.
 *
 * Two design rules it follows that are easy to get wrong:
 *
 * - **The timeline is a mapping, not a copy.** There is no events table; the
 *   service reads each source (orders, payments, points, reservations, repairs,
 *   notes, activities, deals, cases, consent, merges) and merges them. So the
 *   history can never drift from the documents it describes — the sale *is* the
 *   row it shows.
 * - **Consent is a control here, not a checkbox.** Changing it is owner/manager
 *   only, always asks for a reason, and writes an audit event in the same
 *   transaction. A cashier sees the state and cannot flip it.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PinIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatPhoneDisplay, isMobilePhone } from "@/lib/phone";
import { LIFECYCLE_STAGES, type LifecycleStage } from "@/lib/crm-scoring";
import { relationshipSummary, SUMMARY_SOURCE_LABELS } from "@/lib/crm-summary";
import {
  CONSENT_SOURCE_LABELS,
  CUSTOMER_TIMELINE_KINDS,
  TIMELINE_KIND_LABELS,
  type ConsentChannel,
  type ConsentSource,
  type TimelineEvent,
  type TimelineKind,
} from "@/lib/crm-shared";
import type { CustomerFile } from "@/lib/crm-service";
import { EmptyState, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessage, Field, inputClass } from "@/app/dashboard/ui";
import { crmCustomerHref, crmSectionHref } from "./crm-routes";
import { CustomerRelationshipsCard } from "./customer-relationships-card";
import { CrmCardHeading } from "./crm-card-heading";

interface Note {
  id: string;
  body: string;
  isPinned: boolean;
  createdBy: string;
  createdAt: string;
}

export function CustomerFileSection({ customerId, permissions }: { customerId: string; permissions: readonly string[] }) {
  const money = useMoney();
  const permissionSet = new Set(permissions);
  const canManageConsent = permissionSet.has("crm.consent_manage");
  // A cashier can open this file (it's floor work) but not the CRM
  // «میز کار» — `overview` is management-only in `crm-routes.ts`. Telling
  // them to go recompute there anyway would be a dead end.
  const canOpenOverview = permissionSet.has("crm.view");

  const [file, setFile] = useState<CustomerFile | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [kindFilter, setKindFilter] = useState<TimelineKind | "all">("all");
  const [error, setError] = useState("");
  // Whether the *file itself* failed to load — distinct from `error`, which
  // also carries transient action failures (a note that didn't save). Only
  // this one has to stop the page from rendering forever as a skeleton: a
  // dropped connection or a 500 here must not look identical to "still
  // loading", which is what happened before — the skeleton never resolved
  // and the `ErrorBox` holding the real reason was unreachable underneath it.
  const [fileFailed, setFileFailed] = useState(false);
  const [timelineFailed, setTimelineFailed] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [consentTarget, setConsentTarget] = useState<ConsentChannel | null>(null);

  const loadFile = useCallback(() => {
    setFileFailed(false);
    api<{ file: CustomerFile; notes: Note[]; error?: string }>(
      `/api/crm/customers/${customerId}/file`,
    ).then(({ ok, status, data, aborted }) => {
      if (ok) {
        setFile(data.file);
        setNotes(data.notes);
      } else if (status === 404) {
        setNotFound(true);
      } else if (!aborted) {
        setError(errorMessage(data.error));
        setFileFailed(true);
      }
    });
  }, [customerId]);

  const loadTimeline = useCallback(() => {
    setTimelineFailed(false);
    const query = kindFilter === "all" ? "" : `?kinds=${kindFilter}`;
    api<{ events: TimelineEvent[]; error?: string }>(
      `/api/crm/customers/${customerId}/timeline${query}`,
    ).then(({ ok, data, aborted }) => {
      if (ok) setEvents(data.events);
      else if (!aborted) {
        setError(errorMessage(data.error));
        setTimelineFailed(true);
      }
    });
  }, [customerId, kindFilter]);

  useEffect(loadFile, [loadFile]);
  useEffect(loadTimeline, [loadTimeline]);

  const addNote = async () => {
    if (!noteDraft.trim()) return;
    setBusy(true);
    const { ok, data } = await api<{ error?: string }>(`/api/crm/customers/${customerId}/notes`, {
      method: "POST",
      body: JSON.stringify({ body: noteDraft.trim() }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNoteDraft("");
    loadFile();
    loadTimeline();
  };

  const removeNote = async (note: Note) => {
    // Every other delete in this app (activities, deals, segments) asks
    // first — this one deleted on a single click with no undo, which is the
    // one destructive action here more dangerous than the rest: a note is
    // gone with no trace the moment the click lands.
    if (!window.confirm(`یادداشت «${note.body}» حذف شود؟ این کار قابل بازگشت نیست.`)) return;
    const { ok, data } = await api<{ error?: string }>(
      `/api/crm/customers/${customerId}/notes?noteId=${note.id}`,
      { method: "DELETE" },
    );
    // A failure here used to be silent: the row stayed on screen with no
    // explanation, which reads as "it didn't work" with no way to tell why.
    if (ok) loadFile();
    else setError(errorMessage(data.error));
  };

  const pinNote = async (note: Note) => {
    const { ok, data } = await api<{ error?: string }>(`/api/crm/customers/${customerId}/notes`, {
      method: "PATCH",
      body: JSON.stringify({ noteId: note.id, isPinned: !note.isPinned }),
    });
    if (ok) loadFile();
    else setError(errorMessage(data.error));
  };

  if (notFound) {
    return (
      <SectionCard title="مشتری پیدا نشد" description="این پرونده وجود ندارد یا حذف شده است.">
        <Button asChild variant="outline">
          <Link href={crmSectionHref("directory")}>بازگشت به فهرست مشتریان</Link>
        </Button>
      </SectionCard>
    );
  }

  if (!file) {
    // A failed first load must not look like a load still in progress: with
    // no way out shown here, the skeleton above kept spinning forever while
    // the actual reason sat in `error`, unreachable because nothing before
    // this point ever rendered it.
    if (fileFailed) {
      return (
        <SectionCard title="پرونده بارگذاری نشد">
          <ErrorBox>{error || errorMessage(undefined)}</ErrorBox>
          <Button type="button" variant="outline" onClick={loadFile}>
            تلاش دوباره
          </Button>
        </SectionCard>
      );
    }
    return (
      <SectionCardSkeleton rows={4} />
    );
  }

  const stage = file.rfm.stage ? LIFECYCLE_STAGES[file.rfm.stage as LifecycleStage] : null;
  // The merge banner above says "this file's content moved elsewhere" but
  // said nothing about the note/consent controls still sitting live below
  // it — a write here used to succeed silently on the archived record while
  // never reaching the winner the banner just sent you to. Disabling them
  // makes the banner's claim true everywhere on the page, not just at the
  // top of it.
  const isMerged = Boolean(file.mergedIntoId);

  /*
   * The relationship summary, built from the three things this screen has
   * already fetched — the file, the notes and the merged timeline. It runs no
   * query of its own and states no fact it cannot point at, which is why it is
   * computed here rather than asked of a model: a summary that can invent
   * something about a person is worse than none, because it is believed.
   */
  const summary = relationshipSummary({
    name: file.name,
    health: file.health,
    stats: file.stats,
    accounting: file.accounting,
    consent: { smsConsent: file.smsConsent, marketingConsent: file.marketingConsent },
    rfm: { stage: file.rfm.stage },
    // Only the events whose kind the panel can name; the timeline is capped
    // per source, so the three newest are the three most recent things.
    timeline: (events ?? []).slice(0, 3),
    formatMoney: (rial) => money.format(rial),
  });

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>

      {file.mergedIntoId ? (
        <SectionCard
          title={
            <CrmCardHeading kicker="وضعیت پرونده" title="این پرونده ادغام شده است" />
          }
          description="محتوای آن به پروندهٔ دیگری منتقل شده و اینجا فقط برای سابقه نگه داشته می‌شود."
        >
          <Button asChild variant="outline">
            <Link href={crmCustomerHref(file.mergedIntoId)}>رفتن به پروندهٔ اصلی</Link>
          </Button>
        </SectionCard>
      ) : null}

      <SectionCard
        title={
          <CrmCardHeading kicker="پرونده ۳۶۰ درجه" title={file.name} />
        }
        description={[
          file.phone ? toPersianDigits(formatPhoneDisplay(file.phone)) : null,
          file.email,
          file.address,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge tone={file.isActive ? "positive" : "neutral"}>
              {file.isActive ? "فعال" : "آرشیو"}
            </StatusBadge>
            {/* The explainable state, beside the lifecycle badge it is derived
                from. Its reasons are printed under the metrics. */}
            <StatusBadge tone={file.health.tone}>وضعیت رابطه: {file.health.label}</StatusBadge>
            {stage ? <StatusBadge tone={stage.tone}>{stage.label}</StatusBadge> : null}
          </div>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="مجموع خرید" value={money.format(file.stats.totalSpentRial)} />
          <Metric label="تعداد خرید" value={formatPersianNumber(file.stats.orderCount)} />
          <Metric
            label="میانگین هر خرید"
            value={money.format(file.stats.lifetime.averageOrderRial)}
          />
          <Metric
            label="آخرین خرید"
            value={
              file.stats.lastPurchaseDate
                ? toPersianDigits(formatJalali(file.stats.lastPurchaseDate))
                : "—"
            }
            hint={
              file.stats.daysSinceLastPurchase === null
                ? "هنوز خریدی ثبت نشده"
                : `${formatPersianNumber(file.stats.daysSinceLastPurchase)} روز پیش`
            }
          />
          {/*
            Phase 36d — the books' number, not a CRM recomputation. Only shown
            when the business actually keeps a ledger; a cash-only cafe with no
            A/R account should not be told it is owed «۰ ﷼», which reads like a
            fact about the customer rather than about the absence of a ledger.
          */}
          {file.accounting.hasLedger ? (
            <Metric
              label="مانده بدهی"
              value={money.format(file.accounting.receivableRial)}
              hint={
                file.accounting.receivableRial > 0
                  ? "طبق دفاتر حسابداری"
                  : "تسویه‌شده طبق دفاتر"
              }
            />
          ) : null}
          <Metric label="امتیاز وفاداری" value={formatPersianNumber(file.stats.loyaltyPoints)} />
          <Metric label="تیکت باز" value={formatPersianNumber(file.stats.openCases)} />
          <Metric label="معاملهٔ باز" value={formatPersianNumber(file.stats.openDeals)} />
          <Metric
            label="برآورد خرید سالانه"
            value={
              file.stats.lifetime.projectedAnnualRial === null
                ? "—"
                : money.format(file.stats.lifetime.projectedAnnualRial)
            }
            hint={
              file.stats.lifetime.purchaseIntervalDays === null
                ? "برای برآورد، حداقل دو خرید لازم است"
                : `به‌طور میانگین هر ${toPersianDigits(String(file.stats.lifetime.purchaseIntervalDays))} روز یک خرید`
            }
          />
        </div>

        <div className="mt-4 rounded-lg border border-border/80 p-3">
          <p className="text-xs font-semibold text-foreground/80">
            چرا «{file.health.label}»؟
          </p>
          <ul className="mt-1.5 space-y-1 text-xs leading-6 text-muted-foreground">
            {file.health.reasons.map((reason) => (
              <li key={reason.code} className="flex gap-1.5">
                <span aria-hidden="true">•</span>
                <span>{reason.text}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground/90">
            {file.health.description}
          </p>
        </div>

        {stage ? (
          <p className="mt-3 text-xs leading-6 text-muted-foreground">
            <span className="font-medium text-foreground/80">{stage.label}:</span> {stage.description}{" "}
            {stage.action}
          </p>
        ) : (
          <p className="mt-3 text-xs leading-6 text-muted-foreground">
            {canOpenOverview ? (
              <>
                هنوز امتیاز چرخهٔ عمر محاسبه نشده است. از{" "}
                <Link href={crmSectionHref("overview")} className="underline">
                  میز کار ارتباط با مشتری
                </Link>
                ، «محاسبهٔ دوباره» را بزنید.
              </>
            ) : (
              "هنوز امتیاز چرخهٔ عمر محاسبه نشده است. از مدیر یا مالک بخواهید آن را از میز کار ارتباط با مشتری محاسبه کند."
            )}
          </p>
        )}

        {file.tags.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {file.tags.map((tag) => (
              <li key={tag}>
                <StatusBadge tone="neutral">{tag}</StatusBadge>
              </li>
            ))}
          </ul>
        ) : null}
      </SectionCard>

      <SectionCard
        title={<CrmCardHeading kicker="خلاصه" title="این مشتری در یک نگاه" />}
        description="از همان داده‌هایی که پایین همین صفحه آمده‌اند؛ هر خط می‌گوید از کجا خوانده شده است."
      >
        <p className="text-sm font-medium leading-6 text-foreground">{summary.headline}</p>
        <ul className="mt-3 space-y-2">
          {summary.lines.map((line, index) => (
            <li key={`${line.source}-${index}`} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <StatusBadge tone="neutral">{SUMMARY_SOURCE_LABELS[line.source]}</StatusBadge>
              <span className="min-w-0 flex-1 text-sm leading-6 text-muted-foreground">{line.text}</span>
            </li>
          ))}
        </ul>
        {summary.nextStep ? (
          <p className="mt-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm leading-6">
            <span className="font-medium">قدم بعدی: </span>
            {summary.nextStep}
          </p>
        ) : null}
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title={
            <CrmCardHeading kicker="حریم و رضایت" title="رضایت ارتباط" />
          }
          description="پایهٔ هر ارسال آینده؛ تغییرش ثبت می‌شود."
        >
          <ul className="divide-y divide-border/80 text-sm">
            <ConsentRow
              label="پیامک"
              granted={file.smsConsent}
              // Reachability here must match what a send and the consent-coverage
              // page count: an SMS reaches a mobile, not a landline. Using
              // `Boolean(file.phone)` marked a landline customer «قابل ارسال»
              // while the coverage page (mobile-only) did not — the two screens
              // then disagreed about the same person.
              reachable={isMobilePhone(file.phoneE164 ?? file.phone)}
              unreachableHint={
                file.phone ? "شمارهٔ ثبت‌شده موبایل نیست." : "شماره‌ای ثبت نشده است."
              }
              canManage={canManageConsent && !isMerged}
              onChange={() => setConsentTarget("sms")}
            />
            <ConsentRow
              label="ایمیل"
              granted={file.marketingConsent}
              reachable={Boolean(file.email)}
              unreachableHint="ایمیلی ثبت نشده است."
              canManage={canManageConsent && !isMerged}
              onChange={() => setConsentTarget("email")}
            />
          </ul>
          {isMerged ? (
            <p className="mt-3 text-xs leading-6 text-muted-foreground">
              این پرونده ادغام شده است؛ رضایت ارتباط را از پروندهٔ اصلی تغییر دهید.
            </p>
          ) : !canManageConsent ? (
            <p className="mt-3 text-xs leading-6 text-muted-foreground">
              تغییر رضایت ارتباط فقط از سوی مالک یا مدیر انجام می‌شود.
            </p>
          ) : null}
        </SectionCard>

        <SectionCard
          title={
            <CrmCardHeading kicker="یادداشت‌های مشتری" title="یادداشت‌ها" />
          }
          description="آنچه دربارهٔ این مشتری باید به یاد بماند."
        >
          {isMerged ? (
            <p className="mb-3 text-xs leading-6 text-muted-foreground">
              این پرونده ادغام شده است؛ یادداشت تازه را در پروندهٔ اصلی ثبت کنید.
            </p>
          ) : (
            <div className="mb-3 flex gap-2">
              <input
                className={inputClass}
                placeholder="یادداشت تازه…"
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addNote();
                }}
              />
              <Button type="button" onClick={addNote} disabled={busy || !noteDraft.trim()}>
                ثبت
              </Button>
            </div>
          )}
          {notes.length === 0 ? (
            <EmptyState>هنوز یادداشتی ثبت نشده است.</EmptyState>
          ) : (
            <ul className="divide-y divide-border/80 text-sm">
              {notes.map((note) => (
                <li key={note.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="break-words leading-6 text-foreground">{note.body}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {note.createdBy || "—"} · {toPersianDigits(formatJalali(note.createdAt))}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => pinNote(note)}
                      disabled={isMerged}
                      aria-label={note.isPinned ? "برداشتن سنجاق" : "سنجاق کردن"}
                      className={note.isPinned ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}
                    >
                      <PinIcon aria-hidden="true" className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeNote(note)}
                      disabled={isMerged}
                      aria-label="حذف یادداشت"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2Icon aria-hidden="true" className="size-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <CustomerRelationshipsCard
        customerId={customerId}
        // A merged file is a tombstone; its links belong to the winner.
        canManage={(permissionSet.has("crm.manage") || permissionSet.has("parties.manage")) && !isMerged}
      />

      <SectionCard
        title="تاریخچهٔ ارتباط"
        description="هر چیزی که در همهٔ بخش‌های سامانه برای این مشتری ثبت شده است."
        actions={
          <div className="flex items-center gap-1.5">
            <select
              className={`${inputClass} w-40`}
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as TimelineKind | "all")}
              aria-label="نوع رویداد"
            >
              <option value="all">همهٔ رویدادها</option>
              {CUSTOMER_TIMELINE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {TIMELINE_KIND_LABELS[kind]}
                </option>
              ))}
            </select>
            <Button type="button" variant="ghost" size="icon-sm" onClick={loadTimeline} aria-label="بازخوانی">
              <RefreshCwIcon aria-hidden="true" className="size-4" />
            </Button>
          </div>
        }
      >
        {!events && timelineFailed ? (
          <div className="space-y-2">
            <EmptyState>بارگذاری تاریخچه ناموفق بود.</EmptyState>
            <Button type="button" variant="outline" size="sm" onClick={loadTimeline}>
              تلاش دوباره
            </Button>
          </div>
        ) : !events ? (
          <LoadingSkeleton rows={3} />
        ) : events.length === 0 ? (
          <EmptyState>رویدادی برای نمایش نیست.</EmptyState>
        ) : (
          <ul className="divide-y divide-border/80 text-sm">
            {events.map((event, index) => (
              <li key={`${event.at}-${index}`} className="flex items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="break-words leading-6 text-foreground">
                    {event.href ? (
                      <Link href={event.href} className="hover:underline">
                        {event.summary}
                      </Link>
                    ) : (
                      event.summary
                    )}
                  </p>
                  {event.detail ? (
                    <p className="mt-0.5 break-words text-xs leading-5 text-muted-foreground">{event.detail}</p>
                  ) : null}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    <StatusBadge tone="neutral">{event.kindLabel}</StatusBadge>
                    <span className="ms-1">{toPersianDigits(formatJalali(event.at))}</span>
                  </p>
                </div>
                {event.amount ? (
                  <span className="shrink-0 font-semibold text-foreground">
                    {money.format(event.amount.rial)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {consentTarget ? (
        <ConsentDialog
          channel={consentTarget}
          current={consentTarget === "sms" ? file.smsConsent : file.marketingConsent}
          customerId={customerId}
          onClose={() => setConsentTarget(null)}
          onSaved={() => {
            setConsentTarget(null);
            loadFile();
            loadTimeline();
          }}
        />
      ) : null}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium leading-5 text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-lg font-bold tracking-tight text-foreground">{value}</p>
      {hint ? <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * One consent line. «رضایت داده» and «قابل ارسال» are shown separately on
 * purpose: a customer who agreed to SMS but has no number on file is consented
 * and unreachable, and only saying the first would promise a send that cannot
 * happen.
 */
function ConsentRow({
  label,
  granted,
  reachable,
  unreachableHint,
  canManage,
  onChange,
}: {
  label: string;
  granted: boolean;
  reachable: boolean;
  unreachableHint: string;
  canManage: boolean;
  onChange: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2.5">
      <div className="min-w-0">
        <span className="font-medium text-foreground">{label}</span>
        {granted && !reachable ? (
          <span className="mr-2 text-xs text-amber-700 dark:text-amber-300">{unreachableHint}</span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <StatusBadge tone={granted ? "positive" : "neutral"}>
          {granted ? "رضایت داده" : "رضایت نداده"}
        </StatusBadge>
        {canManage ? (
          <Button type="button" variant="ghost" size="xs" onClick={onChange}>
            تغییر
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Changing consent always asks *why*. The reason is not decoration: it is what
 * turns "someone unticked this" into an answer to a complaint six months later,
 * and `source` distinguishes the customer asking from the shop deciding.
 */
function ConsentDialog({
  channel,
  current,
  customerId,
  onClose,
  onSaved,
}: {
  channel: ConsentChannel;
  current: boolean;
  customerId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [granted, setGranted] = useState(!current);
  const [source, setSource] = useState<ConsentSource>("customer_request");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>(`/api/crm/customers/${customerId}/consent`, {
      method: "POST",
      body: JSON.stringify({ channel, granted, source, note: note.trim() }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            تغییر رضایت {channel === "sms" ? "پیامک" : "ایمیل"}
          </DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>

        <Field label="وضعیت تازه">
          <select
            className={inputClass}
            value={granted ? "1" : "0"}
            onChange={(e) => setGranted(e.target.value === "1")}
          >
            <option value="1">رضایت داده است</option>
            <option value="0">رضایت نداده / پس گرفته است</option>
          </select>
        </Field>

        <Field label="این تغییر از کجا آمد؟" hint="مهم‌ترین بخش سابقه؛ در پاسخ‌گویی به شکایت همین ثبت می‌شود.">
          <select
            className={inputClass}
            value={source}
            onChange={(e) => setSource(e.target.value as ConsentSource)}
          >
            {(Object.keys(CONSENT_SOURCE_LABELS) as ConsentSource[])
              // `merge` is written by the merge flow itself, never chosen here.
              .filter((key) => key !== "merge")
              .map((key) => (
                <option key={key} value={key}>
                  {CONSENT_SOURCE_LABELS[key]}
                </option>
              ))}
          </select>
        </Field>

        <Field label="توضیح (اختیاری)">
          <textarea
            className={inputClass}
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            انصراف
          </Button>
          <Button type="button" onClick={save} disabled={busy}>
            ثبت تغییر
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
