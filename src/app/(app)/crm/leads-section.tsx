"use client";

/**
 * Leads — «سرنخ‌ها».
 *
 * ## Why a lead is not a customer
 *
 * A lead is someone who enquired. Most of them never buy. If every enquiry
 * became a row in «اشخاص», the directory would fill with people who have no
 * purchase history, «چند مشتری داریم؟» would stop meaning anything, and every
 * segment built on purchase behaviour would be diluted by people who were
 * never customers at all.
 *
 * So leads live in their own table and become a party exactly once, at
 * conversion. That is also the moment the duplicate check runs — see below.
 *
 * ## The duplicate handshake, and why conversion can refuse
 *
 * Before creating a customer, the server looks for one that already exists
 * with the same phone or email. What it does next depends on how many it
 * finds:
 *
 * - **None** — convert, create the customer.
 * - **One** — show it and ask. "Is this them?" is a question a human can
 *   answer and a server cannot.
 * - **Two or more** — **refuse**. There is no honest way to choose, and the
 *   version of this that picks the oldest record is exactly the bug that
 *   attached one customer's online orders to a stranger's file. The reviewer
 *   picks a specific record, or fixes the duplicates first.
 *
 * That refusal is deliberate friction in the one place the cost of being wrong
 * is a permanently corrupted customer history.
 *
 * ## Filtering is server-side
 *
 * Every filter and the search box are query parameters, and the total the
 * pager shows is the count of rows matching the filter. Filtering a fetched
 * page in the browser is correct only until the table outgrows one response,
 * and then it is silently wrong: the search finds nothing because the match
 * was on page four.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PlusIcon, RefreshCwIcon, UserCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import { FilterChip, FilterChipRow, SearchField } from "@/app/dashboard/filters";
import { api, ErrorBox, errorMessage, Field, InfoBox, inputClass } from "@/app/dashboard/ui";
import { formatPersianNumber } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatPhoneDisplay } from "@/lib/phone";
import { crmCustomerHref } from "./crm-routes";
import { CrmTodayQueues } from "./today-queues";
import { SavedViewsBar } from "./saved-views-bar";

interface Lead {
  id: string;
  name: string;
  organization: string;
  phone: string | null;
  email: string | null;
  source: string;
  sourceDetail: string;
  status: string;
  rating: string;
  ownerName: string;
  nextAction: string;
  nextActionAt: string | null;
  convertedPartyId: string | null;
  createdAt: string;
}

interface Duplicate {
  partyId: string;
  name: string;
  matchedOn: "phone" | "email";
  note: string;
}

const STATUS_LABELS: Record<string, string> = {
  new: "تازه",
  contacted: "تماس گرفته شد",
  working: "در حال پیگیری",
  qualified: "واجد شرایط",
  unqualified: "رد شد",
  converted: "تبدیل شد",
};

const STATUS_TONES: Record<string, "positive" | "neutral" | "active" | "danger"> = {
  new: "active",
  contacted: "active",
  working: "active",
  qualified: "positive",
  converted: "positive",
  unqualified: "neutral",
};

const RATING_LABELS: Record<string, string> = { hot: "داغ", warm: "گرم", cold: "سرد" };

const STATUS_FILTERS = [
  { key: "open", label: "در جریان" },
  { key: "new", label: "تازه" },
  { key: "working", label: "در حال پیگیری" },
  { key: "qualified", label: "واجد شرایط" },
  { key: "converted", label: "تبدیل‌شده" },
  { key: "unqualified", label: "رد شده" },
] as const;

const PAGE_SIZE = 25;

export function LeadsSection({ canManage = false }: { canManage?: boolean }) {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<string>("open");
  const [search, setSearch] = useState("");
  const [dueOnly, setDueOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const [editing, setEditing] = useState<Lead | null>(null);
  const [creating, setCreating] = useState(false);
  const [converting, setConverting] = useState<Lead | null>(null);
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        status,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (search.trim()) params.set("q", search.trim());
      if (dueOnly) params.set("due", "1");
      const { ok, data } = await api<{ leads?: Lead[]; total?: number }>(
        `/api/crm/leads?${params.toString()}`,
      );
      if (ok && Array.isArray(data.leads)) {
        setLeads(data.leads);
        setTotal(data.total ?? 0);
      } else {
        setError("بارگذاری سرنخ‌ها ناموفق بود. دوباره تلاش کنید.");
      }
    } catch {
      setError("ارتباط با سرور برقرار نشد. دوباره تلاش کنید.");
    } finally {
      setLoading(false);
    }
  }, [status, search, dueOnly, offset]);

  useEffect(() => {
    // Debounced on the search box only: the query behind it scans the lead
    // table, and firing it on every keystroke is a request per character.
    const timer = setTimeout(() => void load(), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  // Any filter change resets to the first page. Staying on page three while
  // the result set shrinks to eight rows shows an empty table and looks like
  // the filter matched nothing.
  useEffect(() => setOffset(0), [status, search, dueOnly]);

  const openConvert = async (lead: Lead) => {
    setConverting(lead);
    setDuplicates([]);
    setError("");
    const { ok, data } = await api<{ duplicates?: Duplicate[] }>(
      `/api/crm/leads/${lead.id}/convert`,
    );
    if (ok && Array.isArray(data.duplicates)) setDuplicates(data.duplicates);
  };

  const convert = async (partyId?: string) => {
    if (!converting) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string; duplicates?: Duplicate[]; partyId?: string }>(
      `/api/crm/leads/${converting.id}/convert`,
      {
        method: "POST",
        // `acknowledgeDuplicates` is sent only when exactly one match was shown
        // and the user chose to create a new record anyway. With two or more
        // the server refuses regardless of this flag.
        body: JSON.stringify({
          partyId,
          acknowledgeDuplicates: !partyId && duplicates.length === 1,
        }),
      },
    );
    setBusy(false);
    if (!ok) {
      if (data.error === "duplicates_found" && Array.isArray(data.duplicates)) {
        // Someone created a matching customer between opening the dialog and
        // confirming. Show what changed rather than failing opaquely.
        setDuplicates(data.duplicates);
        setError(
          data.duplicates.length > 1
            ? "بیش از یک پروندهٔ مشابه پیدا شد. یکی را انتخاب کنید یا ابتدا پرونده‌های تکراری را ادغام کنید."
            : "پروندهٔ مشابهی پیدا شد. بررسی کنید.",
        );
        return;
      }
      setError(errorMessage(data.error));
      return;
    }
    setConverting(null);
    setInfo("سرنخ به مشتری تبدیل شد.");
    await load();
  };

  const openCount = useMemo(
    () => (leads ?? []).filter((lead) => lead.status !== "converted" && lead.status !== "unqualified").length,
    [leads],
  );
  const dueCount = useMemo(
    () =>
      (leads ?? []).filter(
        (lead) => lead.nextActionAt && new Date(lead.nextActionAt) <= new Date(),
      ).length,
    [leads],
  );

  if (loading && !leads) return <SectionCardSkeleton rows={5} />;

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {info ? <InfoBox>{info}</InfoBox> : null}

      {/* New enquiries nobody has picked up yet — the queue a lead list exists
          for, so it leads the list rather than hiding in the home page. */}
      <CrmTodayQueues section="leads" title="سرنخ‌های تازه" />

      {/* Named filter sets over this list. The bar hands its filters back here
          rather than querying anything itself, so a view can only ever be a set
          of filters this screen already understands. */}
      <SavedViewsBar
        entity="leads"
        current={{
          ...(search.trim() ? { q: search.trim() } : {}),
          ...(status ? { status } : {}),
          ...(dueOnly ? { due: "1" } : {}),
        }}
        onApply={(filters) => {
          setStatus(filters.status ?? "");
          setSearch(filters.q ?? "");
          setDueOnly(filters.due === "1");
        }}
        canSave={canManage}
        onNotice={setInfo}
      />

      <KpiRow>
        <KpiCard label="سرنخ‌های این فهرست" value={formatPersianNumber(total)} />
        <KpiCard label="در جریان" value={formatPersianNumber(openCount)} />
        <KpiCard label="پیگیری سررسیدشده" value={formatPersianNumber(dueCount)} />
      </KpiRow>

      <SectionCard
        title="سرنخ‌ها"
        description="کسانی که پرس‌وجو کرده‌اند اما هنوز مشتری نشده‌اند. سرنخ تا زمان تبدیل، وارد فهرست اشخاص نمی‌شود."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCwIcon aria-hidden="true" className="size-4" />
              تازه‌سازی
            </Button>
            <Button type="button" size="sm" onClick={() => setCreating(true)}>
              <PlusIcon aria-hidden="true" className="size-4" />
              سرنخ تازه
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <SearchField
            value={search}
            onChange={setSearch}
            label="جست‌وجو در سرنخ‌ها"
            placeholder="نام، سازمان، تلفن یا ایمیل"
          />
          <FilterChipRow label="فیلتر وضعیت سرنخ">
            {STATUS_FILTERS.map((filter) => (
              <FilterChip
                key={filter.key}
                selected={status === filter.key}
                onClick={() => setStatus(filter.key)}
              >
                {filter.label}
              </FilterChip>
            ))}
            <FilterChip selected={dueOnly} onClick={() => setDueOnly((value) => !value)}>
              فقط سررسیدشده
            </FilterChip>
          </FilterChipRow>

          {(leads?.length ?? 0) === 0 ? (
            <EmptyState
              title={search.trim() ? "سرنخی با این مشخصات پیدا نشد" : "سرنخی در این وضعیت نیست"}
            >
              {search.trim()
                ? "عبارت جست‌وجو را تغییر دهید."
                : "سرنخ تازه‌ای ثبت کنید یا فیلتر دیگری را امتحان کنید."}
            </EmptyState>
          ) : (
            <>
              <DataTable caption="فهرست سرنخ‌ها">
                <DataTableHead>
                  <tr>
                    <Th>نام</Th>
                    <Th>راه آشنایی</Th>
                    <Th>وضعیت</Th>
                    <Th>مسئول</Th>
                    <Th>پیگیری بعدی</Th>
                    <Th>اقدام</Th>
                  </tr>
                </DataTableHead>
                <DataTableBody>
                  {(leads ?? []).map((lead) => (
                    <DataTableRow key={lead.id}>
                      <Td>
                        <div className="font-medium text-foreground">{lead.name}</div>
                        {lead.organization ? (
                          <div className="text-xs text-muted-foreground">{lead.organization}</div>
                        ) : null}
                        {lead.phone ? (
                          <div className="text-xs text-muted-foreground">
                            {formatPhoneDisplay(lead.phone)}
                          </div>
                        ) : null}
                      </Td>
                      <Td muted>
                        {lead.sourceDetail || lead.source}
                        <div className="text-xs">{RATING_LABELS[lead.rating] ?? lead.rating}</div>
                      </Td>
                      <Td>
                        <StatusBadge tone={STATUS_TONES[lead.status] ?? "neutral"}>
                          {STATUS_LABELS[lead.status] ?? lead.status}
                        </StatusBadge>
                      </Td>
                      <Td muted>{lead.ownerName || "—"}</Td>
                      <Td muted nowrap>
                        {lead.nextActionAt ? formatJalali(lead.nextActionAt) : "—"}
                        {lead.nextAction ? (
                          <div className="text-xs">{lead.nextAction}</div>
                        ) : null}
                      </Td>
                      <Td>
                        {lead.convertedPartyId ? (
                          <Link
                            className="text-sm underline underline-offset-4"
                            href={crmCustomerHref(lead.convertedPartyId)}
                          >
                            پروندهٔ مشتری
                          </Link>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setEditing(lead)}
                            >
                              ویرایش
                            </Button>
                            <Button type="button" size="sm" onClick={() => void openConvert(lead)}>
                              <UserCheckIcon aria-hidden="true" className="size-4" />
                              تبدیل
                            </Button>
                          </div>
                        )}
                      </Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>

              {total > PAGE_SIZE ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-muted-foreground">
                    {`نمایش ${formatPersianNumber(offset + 1)} تا ${formatPersianNumber(
                      Math.min(offset + PAGE_SIZE, total),
                    )} از ${formatPersianNumber(total)}`}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={offset === 0}
                      onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
                    >
                      قبلی
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={offset + PAGE_SIZE >= total}
                      onClick={() => setOffset((value) => value + PAGE_SIZE)}
                    >
                      بعدی
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </SectionCard>

      <LeadDialog
        lead={editing}
        open={creating || editing !== null}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={async (message) => {
          setCreating(false);
          setEditing(null);
          setInfo(message);
          await load();
        }}
        onError={setError}
      />

      <Dialog open={converting !== null} onOpenChange={(open) => !open && setConverting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>تبدیل سرنخ به مشتری</DialogTitle>
            <DialogDescription>
              {converting
                ? `«${converting.name}» به فهرست اشخاص اضافه می‌شود و پروندهٔ مشتری می‌گیرد.`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {duplicates.length === 0 ? (
            <InfoBox>پروندهٔ مشابهی پیدا نشد. مشتری تازه‌ای ساخته می‌شود.</InfoBox>
          ) : (
            <div className="space-y-3">
              <InfoBox>
                {duplicates.length > 1
                  ? "بیش از یک پروندهٔ مشابه پیدا شد. یکی را انتخاب کنید — ساخت پروندهٔ تازه در این حالت ممکن نیست، چون تشخیص درست بدون بررسی شما امکان ندارد."
                  : "پروندهٔ مشابهی پیدا شد. اگر همان شخص است، وصلش کنید."}
              </InfoBox>
              <ul className="space-y-2">
                {duplicates.map((duplicate) => (
                  <li
                    key={duplicate.partyId}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-2"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium text-foreground">{duplicate.name}</span>
                      <span className="block text-xs text-muted-foreground">{duplicate.note}</span>
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy}
                      onClick={() => void convert(duplicate.partyId)}
                    >
                      همین شخص است
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConverting(null)}>
              انصراف
            </Button>
            {/*
              Creating a fresh customer stays available with zero or one match.
              With two or more it is withheld: the server refuses that case, and
              offering a button that always fails is worse than not offering it.
            */}
            {duplicates.length <= 1 ? (
              <Button type="button" disabled={busy} onClick={() => void convert()}>
                ساخت مشتری تازه
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LeadDialog({
  lead,
  open,
  onClose,
  onSaved,
  onError,
}: {
  lead: Lead | null;
  open: boolean;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [organization, setOrganization] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [source, setSource] = useState("other");
  const [status, setStatus] = useState("new");
  const [rating, setRating] = useState("warm");
  const [nextAction, setNextAction] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(lead?.name ?? "");
    setOrganization(lead?.organization ?? "");
    setPhone(lead?.phone ?? "");
    setEmail(lead?.email ?? "");
    setSource(lead?.source ?? "other");
    setStatus(lead?.status ?? "new");
    setRating(lead?.rating ?? "warm");
    setNextAction(lead?.nextAction ?? "");
    setNotes("");
  }, [open, lead]);

  const submit = async () => {
    if (!name.trim()) {
      onError("نام سرنخ را وارد کنید.");
      return;
    }
    setBusy(true);
    const { ok, data } = await api<{ error?: string }>("/api/crm/leads", {
      method: "POST",
      body: JSON.stringify({
        id: lead?.id,
        name: name.trim(),
        organization: organization.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        source,
        status,
        rating,
        nextAction: nextAction.trim(),
        notes: notes.trim(),
      }),
    });
    setBusy(false);
    if (!ok) {
      onError(errorMessage(data.error));
      return;
    }
    await onSaved(lead ? "سرنخ به‌روزرسانی شد." : "سرنخ ثبت شد.");
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{lead ? "ویرایش سرنخ" : "سرنخ تازه"}</DialogTitle>
          <DialogDescription>
            سرنخ هنوز مشتری نیست و در فهرست اشخاص دیده نمی‌شود.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto">
          <Field label="نام">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="سازمان">
            <input
              className={inputClass}
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
            />
          </Field>
          <Field
            label="تلفن"
            hint="برای تشخیص پروندهٔ تکراری هنگام تبدیل استفاده می‌شود."
          >
            <input
              className={inputClass}
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>
          <Field label="ایمیل">
            <input
              className={inputClass}
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="وضعیت">
            <select
              className={inputClass}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {Object.entries(STATUS_LABELS)
                // «تبدیل‌شده» is not a status anyone sets by hand — it is the
                // result of a conversion, and offering it here would let
                // someone mark a lead converted without a customer existing.
                .filter(([key]) => key !== "converted")
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="اولویت">
            <select
              className={inputClass}
              value={rating}
              onChange={(e) => setRating(e.target.value)}
            >
              {Object.entries(RATING_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="اقدام بعدی">
            <input
              className={inputClass}
              value={nextAction}
              onChange={(e) => setNextAction(e.target.value)}
            />
          </Field>
          <Field label="یادداشت">
            <textarea
              className={inputClass}
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            انصراف
          </Button>
          <Button type="button" disabled={busy} onClick={() => void submit()}>
            ذخیره
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
