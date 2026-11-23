"use client";

/**
 * «اسناد دوره‌ای» — recurring voucher templates and their occurrence register.
 *
 * The screen is a *drafting* surface, never a posting one: every action here
 * ends at a manual-journal draft, and the review queue at «ثبت سند دستی» is
 * where a draft becomes a ledger entry. The heading and empty states say so,
 * because a business that believes a template posts by itself would stop
 * reviewing the drafts.
 *
 * Jalali throughout: every date is rendered through `formatJalali`, every date
 * input is `JalaliDatePicker`, and the preview's dates come from the same pure
 * recurrence module the server runs (`@/lib/recurring-voucher`) — so «رخداد
 * بعدی» cannot disagree with what the tick will actually claim.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClockIcon,
  ChevronLeftIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";

import {
  EmptyState,
  KpiCard,
  KpiRow,
  LoadingSkeleton,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
  cardClass,
} from "@/app/dashboard/page-chrome";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import { FilterChip } from "@/app/dashboard/filters";
import { api, ErrorBox, Field, InfoBox, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useMoney } from "@/components/money/money-context";
import { formatJalali, isValidIsoDate, todayIsoDate } from "@/lib/jalali";
import {
  MONTH_END_POLICIES,
  MONTH_END_POLICY_LABELS,
  RECURRENCE_FREQUENCIES,
  RECURRENCE_FREQUENCY_LABELS,
  RECURRING_DESCRIPTION_MAX,
  RECURRING_NAME_MAX,
  RECURRING_OCCURRENCE_STATUS_LABELS,
  RECURRING_TEMPLATE_STATUS_LABELS,
  recurringVoucherProblem,
  upcomingOccurrenceDates,
  type MonthEndPolicy,
  type RecurrenceFrequency,
  type RecurringOccurrenceStatus,
  type RecurringSchedule,
  type RecurringTemplateStatus,
  type RecurringVoucherLine,
} from "@/lib/recurring-voucher";
import { DimensionCatalogError, DimensionFields, useDimensionCatalog } from "./dimension-fields";
import { dimensionPayload, type DimensionDraft } from "./dimension-catalog";
import type { AccountRow, Runner } from "./accounting-manager";

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  memo: string;
  voucherReference: string | null;
  frequency: RecurrenceFrequency;
  monthEndPolicy: MonthEndPolicy;
  startDate: string;
  endDate: string | null;
  status: RecurringTemplateStatus;
  currentVersion: number;
  nextOccurrenceDate: string | null;
  lastGeneratedDate: string | null;
  locationId: string | null;
  locationName: string | null;
  ownerName: string | null;
  totalDebit: number;
  totalCredit: number;
  occurrenceCount: number;
  failedCount: number;
}

interface TemplateLine {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  partyId: string | null;
  partyName: string | null;
  debit: number;
  credit: number;
  description: string | null;
  dimensions: DimensionDraft;
}

interface OccurrenceRow {
  id: string;
  templateVersion: number;
  scheduledDate: string;
  status: RecurringOccurrenceStatus;
  draftId: string | null;
  entryId: string | null;
  attemptCount: number;
  lastError: string | null;
  heldReason: string | null;
  generatedAt: string | null;
  postedAt: string | null;
  overdue: boolean;
}

interface TemplateDetail extends TemplateRow {
  lines: TemplateLine[];
  versions: { version: number; changeKind: string; actorName: string | null; createdAt: string }[];
  occurrences: OccurrenceRow[];
  upcoming: string[];
}

interface LineDraft {
  key: string;
  accountId: string;
  side: "debit" | "credit";
  amount: string;
  description: string;
  partyId: string;
  partyName: string;
  dimensions: DimensionDraft;
}

const EMPTY_LINE: LineDraft = {
  key: "",
  accountId: "",
  side: "debit",
  amount: "",
  description: "",
  partyId: "",
  partyName: "",
  dimensions: {},
};

const STATUS_TONE: Record<RecurringTemplateStatus, "active" | "positive" | "neutral" | "danger"> = {
  active: "active",
  paused: "neutral",
  completed: "positive",
  cancelled: "danger",
};

const OCCURRENCE_TONE: Record<RecurringOccurrenceStatus, "active" | "positive" | "neutral" | "danger"> = {
  pending: "neutral",
  draft: "active",
  posted: "positive",
  skipped: "neutral",
  failed: "danger",
};

/** A reason a held occurrence shows, in words a reviewer can act on. */
const HELD_REASON_TEXT: Record<string, string> = {
  fiscal_period_locked: "دورهٔ مالی قفل است؛ برای ساخت پیش‌نویس، دوره را باز کنید یا رخداد را رد کنید.",
  fiscal_period_soft_closed: "دورهٔ مالی بستهٔ نرم است؛ پیش از ساخت سند، وضعیت دوره را بررسی کنید.",
  unknown_account: "یکی از حساب‌های سند دیگر در دسترس نیست؛ سند را ویرایش و حساب را جایگزین کنید.",
  account_inactive: "یکی از حساب‌های سند بایگانی شده است؛ سند را ویرایش کنید.",
  not_a_leaf_account: "یکی از حساب‌های انتخاب‌شده حساب کل است؛ حساب معین انتخاب کنید.",
  unknown_party: "طرف‌حساب سند دیگر در دسترس نیست.",
  not_balanced: "سند متوازن نیست؛ الگو را ویرایش کنید.",
  draft_generation_failed: "ساخت پیش‌نویس ناموفق بود؛ دوباره تلاش کنید.",
  skipped_by_user: "این رخداد به‌دست کاربر رد شده است.",
  draft_rejected: "پیش‌نویس این رخداد در صف بازبینی رد شده است.",
  draft_deleted: "پیش‌نویس این رخداد حذف شده است.",
};

function heldText(row: OccurrenceRow): string {
  const code = row.heldReason ?? row.lastError;
  if (!code) return "—";
  return HELD_REASON_TEXT[code] ?? code;
}

function nextLineKey(): string {
  return `line-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function blankLines(): LineDraft[] {
  return [
    { ...EMPTY_LINE, key: nextLineKey(), side: "debit" },
    { ...EMPTY_LINE, key: nextLineKey(), side: "credit" },
  ];
}

const MONEY_SUFFIX = (unit: string) => `مبلغ (${unit})`;

export function RecurringVouchersSection({
  accounts,
  busy,
  run,
  refreshKey,
  canPropose,
}: {
  accounts: AccountRow[];
  busy: boolean;
  run: Runner;
  refreshKey: number;
  canPropose?: boolean;
}) {
  const money = useMoney();
  const mayWrite = canPropose !== false;
  const dimensions = useDimensionCatalog();

  const [templates, setTemplates] = useState<TemplateRow[] | null>(null);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [activeLocation, setActiveLocation] = useState<{ id: string; name: string } | null>(null);
  const [listError, setListError] = useState("");
  const [statusFilter, setStatusFilter] = useState<RecurringTemplateStatus | "">("");

  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notice, setNotice] = useState("");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    description: "",
    memo: "",
    voucherReference: "",
    frequency: "monthly" as RecurrenceFrequency,
    monthEndPolicy: "clamp" as MonthEndPolicy,
    startDate: todayIsoDate(),
    endDate: "",
    locationId: "",
    ownerUserId: "",
  });
  const [lines, setLines] = useState<LineDraft[]>(blankLines());
  const [formError, setFormError] = useState("");

  const [parties, setParties] = useState<{ id: string; name: string }[] | null>(null);
  const requestId = useRef(0);

  const leafAccounts = useMemo(
    () =>
      accounts
        .filter((account) => account.is_postable !== false)
        .map((account) => ({
          value: account.id,
          label: `${account.code} — ${account.name}`,
          searchString: `${account.code} ${account.name}`,
        })),
    [accounts],
  );

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const load = useCallback(async () => {
    const ticket = ++requestId.current;
    const result = await api<{
      templates: TemplateRow[];
      locations?: { id: string; name: string }[];
      activeLocation?: { id: string; name: string } | null;
    }>(`/api/ledger/recurring${statusFilter ? `?status=${statusFilter}` : ""}`);
    if (ticket !== requestId.current) return;
    if (!result.ok) {
      setListError("بارگذاری قالب‌های سند دوره‌ای انجام نشد.");
      setTemplates([]);
      return;
    }
    setListError("");
    setTemplates(result.data.templates);
    setLocations(result.data.locations ?? []);
    setActiveLocation(result.data.activeLocation ?? null);
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // The party picker is optional: a member without `parties.view` simply gets no
  // party column rather than a form that fails on every keystroke.
  useEffect(() => {
    if (!editorOpen || parties !== null) return;
    let cancelled = false;
    void api<{ parties?: { id: string; displayName: string }[] }>("/api/parties?q=&limit=50").then(
      (result) => {
        if (cancelled) return;
        if (!result.ok) {
          setParties([]);
          return;
        }
        setParties(
          (result.data.parties ?? []).map((party) => ({ id: party.id, name: party.displayName })),
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [editorOpen, parties]);

  async function openDetail(id: string) {
    setDetailLoading(true);
    setNotice("");
    const result = await api<{ template: TemplateDetail }>(`/api/ledger/recurring/${id}`);
    setDetailLoading(false);
    if (!result.ok) {
      setNotice("بارگذاری جزئیات قالب انجام نشد.");
      return;
    }
    setDetail(result.data.template);
  }

  function resetForm() {
    setEditingId(null);
    setForm({
      name: "",
      description: "",
      memo: "",
      voucherReference: "",
      frequency: "monthly",
      monthEndPolicy: "clamp",
      startDate: todayIsoDate(),
      endDate: "",
      locationId: activeLocation?.id ?? "",
      ownerUserId: "",
    });
    setLines(blankLines());
    setFormError("");
  }

  function startNew() {
    setEditorOpen(true);
    setDetail(null);
    resetForm();
  }

  function startEdit(template: TemplateDetail | TemplateRow) {
    setEditorOpen(true);
    setEditingId(template.id);
    setDetail((current) => (current && current.id === template.id ? current : null));
    setForm({
      name: template.name,
      description: template.description ?? "",
      memo: template.memo,
      voucherReference: template.voucherReference ?? "",
      frequency: template.frequency,
      monthEndPolicy: template.monthEndPolicy,
      startDate: template.startDate,
      endDate: template.endDate ?? "",
      locationId: template.locationId ?? "",
      ownerUserId: "",
    });
    const source = "lines" in template ? (template as TemplateDetail).lines : [];
    setLines(
      source.length > 0
        ? source.map((line) => ({
            key: nextLineKey(),
            accountId: line.accountId,
            side: line.debit > 0 ? "debit" : "credit",
            amount: String(money.toInput(line.debit > 0 ? line.debit : line.credit)),
            description: line.description ?? "",
            partyId: line.partyId ?? "",
            partyName: line.partyName ?? "",
            dimensions: line.dimensions,
          }))
        : blankLines(),
    );
    setFormError("");
    if (!("lines" in template)) void openDetail(template.id);
  }

  /** The form's lines as integer Rial, or the problem that stops them becoming a document. */
  const buildLines = useCallback((): { ok: true; lines: RecurringVoucherLine[] } | { ok: false; problem: string } => {
    const out: RecurringVoucherLine[] = [];
    for (const line of lines) {
      if (!line.accountId) continue;
      let rial: number;
      try {
        rial = money.parse(line.amount);
      } catch {
        return { ok: false, problem: "مبلغ هر سطر باید یک عدد کامل و معتبر باشد." };
      }
      if (!Number.isSafeInteger(rial) || rial <= 0) {
        return { ok: false, problem: "مبلغ هر سطر باید یک عدد کامل مثبت باشد." };
      }
      out.push({
        accountId: line.accountId,
        debit: line.side === "debit" ? rial : 0,
        credit: line.side === "credit" ? rial : 0,
        partyId: line.partyId || null,
        description: line.description || null,
        dimensions: dimensionPayload(line.dimensions),
      });
    }
    return { ok: true, lines: out };
  }, [lines, money]);

  const preview = useMemo(() => {
    const built = buildLines();
    if (!built.ok) return { problem: built.problem, dates: [] as string[], debit: 0, credit: 0 };
    const totals = built.lines.reduce(
      (acc, line) => ({ debit: acc.debit + line.debit, credit: acc.credit + line.credit }),
      { debit: 0, credit: 0 },
    );
    const problem = recurringVoucherProblem({
      name: form.name,
      description: form.description || null,
      memo: form.memo,
      frequency: form.frequency,
      monthEndPolicy: form.monthEndPolicy,
      startDate: form.startDate,
      endDate: form.endDate || null,
      lines: built.lines,
    });
    if (problem) return { problem, dates: [] as string[], ...totals };
    const schedule: RecurringSchedule = {
      frequency: form.frequency,
      monthEndPolicy: form.monthEndPolicy,
      startDate: form.startDate,
      endDate: form.endDate || null,
    };
    return {
      problem: null,
      dates: upcomingOccurrenceDates(schedule, todayIsoDate(), 6),
      ...totals,
    };
  }, [form, buildLines]);

  async function saveTemplate() {
    const built = buildLines();
    if (!built.ok) {
      setFormError(built.problem);
      return;
    }
    const problem = recurringVoucherProblem({
      name: form.name,
      description: form.description || null,
      memo: form.memo,
      frequency: form.frequency,
      monthEndPolicy: form.monthEndPolicy,
      startDate: form.startDate,
      endDate: form.endDate || null,
      lines: built.lines,
    });
    if (problem) {
      setFormError("سند هنوز کامل یا متوازن نیست؛ پیش‌نمایش را ببینید.");
      return;
    }
    setFormError("");
    const body = {
      name: form.name,
      description: form.description || null,
      memo: form.memo,
      voucherReference: form.voucherReference || null,
      frequency: form.frequency,
      monthEndPolicy: form.monthEndPolicy,
      startDate: form.startDate,
      endDate: form.endDate || null,
      locationId: form.locationId || null,
      lines: built.lines,
    };
    const url = editingId ? `/api/ledger/recurring/${editingId}` : "/api/ledger/recurring";
    const ok = await run(() =>
      api(url, { method: editingId ? "PATCH" : "POST", body: JSON.stringify(body) }),
    );
    if (!ok) return;
    setNotice(editingId ? "تغییرات الگو ثبت شد؛ رخدادهای پیشین دست‌نخورده می‌مانند." : "قالب سند دوره‌ای ساخته شد.");
    setEditorOpen(false);
    resetForm();
    void load();
  }

  async function templateAction(
    templateId: string,
    action: "pause" | "resume" | "cancel",
  ) {
    const ok = await run(() =>
      api(`/api/ledger/recurring/${templateId}`, {
        method: "PATCH",
        body: JSON.stringify({ action }),
      }),
    );
    if (!ok) return;
    setNotice(
      action === "pause"
        ? "قالب موقتاً متوقف شد."
        : action === "resume"
          ? "قالب فعال شد."
          : "قالب لغو شد.",
    );
    await openDetail(templateId);
  }

  async function generateNow(templateId: string) {
    const ok = await run(() =>
      api(`/api/ledger/recurring/${templateId}/generate`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    if (!ok) return;
    setNotice("رخدادهای سررسیدشده بررسی شدند؛ پیش‌نویس‌ها در صف بازبینی هستند.");
    await openDetail(templateId);
  }

  async function occurrenceAction(
    templateId: string,
    occurrenceId: string,
    action: "retry" | "skip",
  ) {
    const ok = await run(() =>
      api(`/api/ledger/recurring/${templateId}`, {
        method: "PATCH",
        body: JSON.stringify({ action, occurrenceId }),
      }),
    );
    if (!ok) return;
    setNotice(action === "retry" ? "رخداد دوباره بررسی شد." : "رخداد رد شد.");
    await openDetail(templateId);
  }

  const kpis = useMemo(() => {
    const list = templates ?? [];
    const active = list.filter((t) => t.status === "active").length;
    const paused = list.filter((t) => t.status === "paused").length;
    const failed = list.reduce((sum, t) => sum + t.failedCount, 0);
    const next = list
      .map((t) => t.nextOccurrenceDate)
      .filter((date): date is string => !!date)
      .sort()[0];
    return { active, paused, failed, next };
  }, [templates]);

  return (
    <div className="space-y-4">
      {notice ? <InfoBox>{notice}</InfoBox> : null}
      {listError ? <ErrorBox>{listError}</ErrorBox> : null}

      <KpiRow>
        <KpiCard label="قالب‌های فعال" value={kpis.active} hint="آمادهٔ ساخت پیش‌نویس در سررسید" />
        <KpiCard label="موقتاً متوقف" value={kpis.paused} hint="تا فعال‌شدن، رخدادی ساخته نمی‌شود" />
        <KpiCard
          label="رخدادهای متوقف"
          value={kpis.failed}
          hint="دورهٔ قفل‌شده یا حساب نامعتبر — نیازمند بررسی"
        />
        <KpiCard
          label="رخداد بعدی"
          value={kpis.next ? formatJalali(kpis.next) : "—"}
          hint="زودترین سررسید میان قالب‌های فعال"
        />
      </KpiRow>

      <SectionCard
        title="قالب‌های سند دوره‌ای"
        description="هر رخداد یک «پیش‌نویس» می‌سازد؛ ثبت نهایی فقط با تأیید در صف بازبینی «ثبت سند دستی» انجام می‌شود."
        actions={
          mayWrite ? (
            <PrimaryButton type="button" onClick={startNew}>
              <span className="inline-flex items-center gap-1">
                <PlusIcon className="size-4" aria-hidden="true" />
                قالب جدید
              </span>
            </PrimaryButton>
          ) : null
        }
        flush
      >
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3 pt-1">
          <FilterChip selected={statusFilter === ""} onClick={() => setStatusFilter("")}>
            همه
          </FilterChip>
          {(["active", "paused", "completed", "cancelled"] as const).map((status) => (
            <FilterChip
              key={status}
              selected={statusFilter === status}
              onClick={() => setStatusFilter(status)}
            >
              {RECURRING_TEMPLATE_STATUS_LABELS[status]}
            </FilterChip>
          ))}
        </div>
        {templates === null ? (
          <div className="px-4 pb-4">
            <LoadingSkeleton rows={4} label="در حال بارگذاری قالب‌های سند دوره‌ای" />
          </div>
        ) : templates.length === 0 ? (
          <div className="px-4 pb-4">
            <EmptyState icon={CalendarClockIcon} title="هنوز قالب سند دوره‌ای ساخته نشده است">
              اجاره، بیمه، اشتراک یا هر تعهد تکرارشونده را یک‌بار تعریف کنید؛ سررسیدها به‌صورت
              پیش‌نویس برای بازبینی ساخته می‌شوند.
            </EmptyState>
          </div>
        ) : (
          <DataTable caption="قالب‌های سند دوره‌ای">
            <DataTableHead>
              <tr>
                <Th>نام</Th>
                <Th>تکرار</Th>
                <Th>مبلغ سند</Th>
                <Th>رخداد بعدی</Th>
                <Th>وضعیت</Th>
                <Th>شعبه</Th>
                <Th />
              </tr>
            </DataTableHead>
            <DataTableBody>
              {templates.map((template) => (
                <DataTableRow key={template.id}>
                  <Td>
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{template.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {template.memo}
                        {template.failedCount > 0 ? ` · ${template.failedCount} رخداد متوقف` : ""}
                      </p>
                    </div>
                  </Td>
                  <Td>{RECURRENCE_FREQUENCY_LABELS[template.frequency]}</Td>
                  <Td className="tabular-nums">{money.format(template.totalDebit)}</Td>
                  <Td>{template.nextOccurrenceDate ? formatJalali(template.nextOccurrenceDate) : "—"}</Td>
                  <Td>
                    <StatusBadge tone={STATUS_TONE[template.status]}>
                      {RECURRING_TEMPLATE_STATUS_LABELS[template.status]}
                    </StatusBadge>
                  </Td>
                  <Td>{template.locationName ?? "همهٔ شعبه‌ها"}</Td>
                  <Td>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <SecondaryButton
                        type="button"
                        onClick={() => {
                          void openDetail(template.id);
                          if (mayWrite) startEdit(template);
                        }}
                      >
                        {mayWrite ? "مدیریت" : "رخدادها"}
                      </SecondaryButton>
                    </div>
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>

      {editorOpen ? (
        <SectionCard
          title={editingId ? "ویرایش قالب سند دوره‌ای" : "قالب سند دوره‌ای جدید"}
          description="سطرها باید متوازن باشند. ویرایش، فقط رخدادهای آیندهٔ ساخته‌نشده را تغییر می‌دهد؛ پیش‌نویس‌ها و اسناد ثبت‌شده دست‌نخورده می‌مانند."
          actions={
            <SecondaryButton
              type="button"
              onClick={() => {
                setEditorOpen(false);
                resetForm();
              }}
            >
              بستن
            </SecondaryButton>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="نام قالب">
              <input
                className={inputClass}
                value={form.name}
                maxLength={RECURRING_NAME_MAX}
                onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
              />
            </Field>
            <Field label="شرح (اختیاری)">
              <input
                className={inputClass}
                value={form.description}
                maxLength={RECURRING_DESCRIPTION_MAX}
                onChange={(event) => setForm((f) => ({ ...f, description: event.target.value }))}
              />
            </Field>
            <Field label="متن سند (شرح حسابداری)">
              <input
                className={inputClass}
                value={form.memo}
                maxLength={500}
                onChange={(event) => setForm((f) => ({ ...f, memo: event.target.value }))}
              />
            </Field>
            <Field label="شمارهٔ مرجع سند (اختیاری)" hint="شمارهٔ قرارداد یا سند پشتیبان؛ فقط یادداشت است.">
              <input
                className={inputClass}
                value={form.voucherReference}
                maxLength={80}
                onChange={(event) => setForm((f) => ({ ...f, voucherReference: event.target.value }))}
              />
            </Field>
            <Field label="تکرار" as="div">
              <div className="flex flex-wrap gap-2">
                {RECURRENCE_FREQUENCIES.map((frequency) => (
                  <FilterChip
                    key={frequency}
                    selected={form.frequency === frequency}
                    onClick={() => setForm((f) => ({ ...f, frequency }))}
                  >
                    {RECURRENCE_FREQUENCY_LABELS[frequency]}
                  </FilterChip>
                ))}
              </div>
            </Field>
            <Field label="شعبه" hint={activeLocation ? `شعبهٔ فعال: ${activeLocation.name}` : undefined}>
              <SearchableSelect
                value={form.locationId}
                onChange={(value) => setForm((f) => ({ ...f, locationId: value }))}
                options={[
                  { value: "", label: "همهٔ شعبه‌ها / بدون شعبه" },
                  ...locations.map((location) => ({ value: location.id, label: location.name })),
                ]}
                ariaLabel="شعبهٔ قالب سند دوره‌ای"
              />
            </Field>
            <Field label="تاریخ شروع">
              <JalaliDatePicker
                value={form.startDate}
                onChange={(value) => setForm((f) => ({ ...f, startDate: value }))}
                ariaLabel="تاریخ شروع قالب"
              />
            </Field>
            <Field label="تاریخ پایان (اختیاری)">
              <JalaliDatePicker
                value={form.endDate}
                onChange={(value) => setForm((f) => ({ ...f, endDate: value }))}
                ariaLabel="تاریخ پایان قالب"
              />
            </Field>
            {form.frequency !== "weekly" ? (
              <Field
                label="سیاست ماه کوتاه"
                hint="ماه‌های شمسی ۲۹ تا ۳۱ روز دارند؛ رفتار روز ۲۹ تا ۳۱ را این‌جا انتخاب کنید."
                as="div"
              >
                <div className="flex flex-wrap gap-2">
                  {MONTH_END_POLICIES.map((policy) => (
                    <FilterChip
                      key={policy}
                      selected={form.monthEndPolicy === policy}
                      onClick={() => setForm((f) => ({ ...f, monthEndPolicy: policy }))}
                    >
                      {MONTH_END_POLICY_LABELS[policy]}
                    </FilterChip>
                  ))}
                </div>
              </Field>
            ) : null}
          </div>

          <div className="mt-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">سطرهای سند</h3>
              <SecondaryButton
                type="button"
                onClick={() =>
                  setLines((current) => [
                    ...current,
                    { ...EMPTY_LINE, key: nextLineKey(), side: current.length % 2 === 0 ? "debit" : "credit" },
                  ])
                }
              >
                افزودن سطر
              </SecondaryButton>
            </div>
            {lines.map((line, index) => (
              <div key={line.key} className={`${cardClass} space-y-3 p-3`}>
                <div className="grid gap-3 md:grid-cols-12">
                  <div className="md:col-span-4">
                    <Field label="حساب">
                      <SearchableSelect
                        value={line.accountId}
                        onChange={(value) =>
                          setLines((current) =>
                            current.map((entry, i) => (i === index ? { ...entry, accountId: value } : entry)),
                          )
                        }
                        options={leafAccounts}
                        ariaLabel={`حساب سطر ${index + 1}`}
                        placeholder="حساب معین را انتخاب کنید"
                      />
                    </Field>
                  </div>
                  <div className="md:col-span-2">
                    <Field label="نوع" as="div">
                      <div className="flex gap-2">
                        <FilterChip
                          selected={line.side === "debit"}
                          onClick={() =>
                            setLines((current) =>
                              current.map((entry, i) => (i === index ? { ...entry, side: "debit" } : entry)),
                            )
                          }
                        >
                          بدهکار
                        </FilterChip>
                        <FilterChip
                          selected={line.side === "credit"}
                          onClick={() =>
                            setLines((current) =>
                              current.map((entry, i) => (i === index ? { ...entry, side: "credit" } : entry)),
                            )
                          }
                        >
                          بستانکار
                        </FilterChip>
                      </div>
                    </Field>
                  </div>
                  <div className="md:col-span-3">
                    <Field label={MONEY_SUFFIX(money.unitLabel)}>
                      <PersianNumberInput
                        value={line.amount}
                        onChange={(event) =>
                          setLines((current) =>
                            current.map((entry, i) =>
                              i === index ? { ...entry, amount: event.target.value } : entry,
                            ),
                          )
                        }
                        aria-label={`مبلغ سطر ${index + 1}`}
                      />
                    </Field>
                  </div>
                  <div className="md:col-span-3">
                    <Field label="شرح سطر (اختیاری)">
                      <input
                        className={inputClass}
                        value={line.description}
                        maxLength={300}
                        onChange={(event) =>
                          setLines((current) =>
                            current.map((entry, i) =>
                              i === index ? { ...entry, description: event.target.value } : entry,
                            ),
                          )
                        }
                      />
                    </Field>
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-12">
                  <div className="md:col-span-4">
                    <Field label="طرف‌حساب (اختیاری)">
                      <SearchableSelect
                        value={line.partyId}
                        onChange={(value) =>
                          setLines((current) =>
                            current.map((entry, i) =>
                              i === index
                                ? {
                                    ...entry,
                                    partyId: value,
                                    partyName: parties?.find((p) => p.id === value)?.name ?? "",
                                  }
                                : entry,
                            ),
                          )
                        }
                        options={[
                          { value: "", label: "بدون طرف‌حساب" },
                          ...(line.partyId && !parties?.some((p) => p.id === line.partyId)
                            ? [{ value: line.partyId, label: line.partyName || "طرف‌حساب ثبت‌شده" }]
                            : []),
                          ...(parties ?? []).map((party) => ({ value: party.id, label: party.name })),
                        ]}
                        disabled={parties !== null && parties.length === 0}
                        ariaLabel={`طرف‌حساب سطر ${index + 1}`}
                      />
                    </Field>
                  </div>
                  <div className="md:col-span-8">
                    {dimensions.loaded && dimensions.catalog ? (
                      <DimensionFields
                        idPrefix={`recurring-${line.key}`}
                        catalog={dimensions.catalog}
                        locationId={form.locationId || null}
                        value={line.dimensions}
                        onChange={(next) =>
                          setLines((current) =>
                            current.map((entry, i) =>
                              i === index ? { ...entry, dimensions: next } : entry,
                            ),
                          )
                        }
                      />
                    ) : dimensions.error ? (
                      <DimensionCatalogError error={dimensions.error} onRetry={dimensions.retry} />
                    ) : (
                      <LoadingSkeleton rows={1} compact label="در حال بارگذاری ابعاد حسابداری" />
                    )}
                  </div>
                </div>
                <div className="flex justify-end">
                  <SecondaryButton
                    type="button"
                    disabled={lines.length <= 2}
                    onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                  >
                    <span className="inline-flex items-center gap-1">
                      <Trash2Icon className="size-4" aria-hidden="true" />
                      حذف سطر
                    </span>
                  </SecondaryButton>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4">
            <PreviewPanel
              problem={preview.problem}
              dates={preview.dates}
              debit={preview.debit}
              credit={preview.credit}
            />
          </div>

          {formError ? <ErrorBox>{formError}</ErrorBox> : null}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <PrimaryButton type="button" disabled={busy || preview.problem !== null} onClick={saveTemplate}>
              {editingId ? "ذخیرهٔ تغییرات" : "ساخت قالب"}
            </PrimaryButton>
            {preview.problem ? (
              <p className="text-xs text-muted-foreground">تا رفع ایراد سند، دکمهٔ ذخیره غیرفعال است.</p>
            ) : null}
          </div>
        </SectionCard>
      ) : null}

      {detailLoading ? <SectionCardSkeleton rows={5} /> : null}

      {detail ? (
        <SectionCard
          title={`قالب «${detail.name}»`}
          description={`${RECURRENCE_FREQUENCY_LABELS[detail.frequency]} · ${MONTH_END_POLICY_LABELS[detail.monthEndPolicy]} · نسخهٔ ${detail.currentVersion}`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {mayWrite && detail.status === "active" ? (
                <SecondaryButton type="button" onClick={() => templateAction(detail.id, "pause")}>
                  توقف موقت
                </SecondaryButton>
              ) : null}
              {mayWrite && detail.status === "paused" ? (
                <SecondaryButton type="button" onClick={() => templateAction(detail.id, "resume")}>
                  فعال‌سازی
                </SecondaryButton>
              ) : null}
              {mayWrite && (detail.status === "active" || detail.status === "paused") ? (
                <SecondaryButton type="button" onClick={() => templateAction(detail.id, "cancel")}>
                  لغو قالب
                </SecondaryButton>
              ) : null}
              {mayWrite ? (
                <PrimaryButton type="button" disabled={busy} onClick={() => generateNow(detail.id)}>
                  <span className="inline-flex items-center gap-1">
                    <PlayIcon className="size-4" aria-hidden="true" />
                    تولید رخدادهای سررسید
                  </span>
                </PrimaryButton>
              ) : null}
            </div>
          }
        >
          <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">شروع</dt>
              <dd>{formatJalali(detail.startDate)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">پایان</dt>
              <dd>{detail.endDate ? formatJalali(detail.endDate) : "بدون پایان"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">رخداد بعدی</dt>
              <dd>{detail.nextOccurrenceDate ? formatJalali(detail.nextOccurrenceDate) : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">جمع سند</dt>
              <dd className="tabular-nums">{money.format(detail.totalDebit)}</dd>
            </div>
          </dl>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-semibold text-foreground">رخدادهای پیش‌رو</h3>
              {detail.upcoming.length === 0 ? (
                <p className="text-sm text-muted-foreground">رخداد آینده‌ای برای این قالب نیست.</p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {detail.upcoming.map((date) => (
                    <li
                      key={date}
                      className="rounded-xl border border-border/80 bg-card px-3 py-1 text-sm tabular-nums"
                    >
                      {formatJalali(date)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold text-foreground">تاریخچهٔ نسخه‌ها</h3>
              <ul className="space-y-1 text-sm">
                {detail.versions.map((version) => (
                  <li key={`${version.version}-${version.createdAt}`} className="flex justify-between gap-2">
                    <span>
                      نسخهٔ {version.version} ·{" "}
                      {version.changeKind === "created"
                        ? "ایجاد"
                        : version.changeKind === "edited"
                          ? "ویرایش"
                          : "تغییر وضعیت"}
                    </span>
                    <span className="text-muted-foreground">{formatJalali(version.createdAt.slice(0, 10))}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-5">
            <h3 className="mb-2 text-sm font-semibold text-foreground">دفتر رخدادها</h3>
            {detail.occurrences.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                هنوز رخدادی ساخته نشده است. «تولید رخدادهای سررسید» نخستین پیش‌نویس‌ها را می‌سازد.
              </p>
            ) : (
              <DataTable caption="دفتر رخدادهای قالب سند دوره‌ای">
                <DataTableHead>
                  <tr>
                    <Th>سررسید</Th>
                    <Th>وضعیت</Th>
                    <Th>نسخهٔ الگو</Th>
                    <Th>تلاش</Th>
                    <Th>توضیح</Th>
                    <Th />
                  </tr>
                </DataTableHead>
                <DataTableBody>
                  {detail.occurrences.map((occurrence) => (
                    <DataTableRow key={occurrence.id}>
                      <Td className="tabular-nums">
                        <div className="flex items-center gap-2">
                          {formatJalali(occurrence.scheduledDate)}
                          {occurrence.overdue ? <StatusBadge tone="danger">عقب‌افتاده</StatusBadge> : null}
                        </div>
                      </Td>
                      <Td>
                        <StatusBadge tone={OCCURRENCE_TONE[occurrence.status]}>
                          {RECURRING_OCCURRENCE_STATUS_LABELS[occurrence.status]}
                        </StatusBadge>
                      </Td>
                      <Td>{occurrence.templateVersion}</Td>
                      <Td>{occurrence.attemptCount}</Td>
                      <Td className="max-w-[22rem] text-xs text-muted-foreground">{heldText(occurrence)}</Td>
                      <Td>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {occurrence.draftId ? (
                            <Link
                              href="/accounting/manual"
                              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                            >
                              صف بازبینی
                              <ChevronLeftIcon className="size-3" aria-hidden="true" />
                            </Link>
                          ) : null}
                          {mayWrite && (occurrence.status === "failed" || occurrence.status === "pending") ? (
                            <SecondaryButton
                              type="button"
                              onClick={() => occurrenceAction(detail.id, occurrence.id, "retry")}
                            >
                              <span className="inline-flex items-center gap-1">
                                <RefreshCwIcon className="size-3.5" aria-hidden="true" />
                                تلاش دوباره
                              </span>
                            </SecondaryButton>
                          ) : null}
                          {mayWrite && (occurrence.status === "failed" || occurrence.status === "pending") ? (
                            <SecondaryButton
                              type="button"
                              onClick={() => occurrenceAction(detail.id, occurrence.id, "skip")}
                            >
                              رد کردن
                            </SecondaryButton>
                          ) : null}
                        </div>
                      </Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            )}
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

/**
 * The balanced-entry preview the issue asks for: totals in the business's money
 * unit, the next occurrences, and the one sentence describing what is wrong
 * when the document is not yet valid.
 */
function PreviewPanel({
  problem,
  dates,
  debit,
  credit,
}: {
  problem: string | null;
  dates: string[];
  debit: number;
  credit: number;
}) {
  const money = useMoney();
  const balanced = debit === credit && debit > 0;
  return (
    <div className={`${cardClass} p-4`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">پیش‌نمایش سند و سررسیدها</h3>
        {balanced ? (
          <StatusBadge tone="positive" dot>
            متوازن
          </StatusBadge>
        ) : (
          <StatusBadge tone="danger" dot>
            نامتوازن
          </StatusBadge>
        )}
      </div>
      <div className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
        <p>
          جمع بدهکار: <span className="tabular-nums">{money.format(debit)}</span>
        </p>
        <p>
          جمع بستانکار: <span className="tabular-nums">{money.format(credit)}</span>
        </p>
      </div>
      {problem ? (
        <p className="mt-2 text-xs leading-6 text-destructive">
          سند هنوز قابل ذخیره نیست: نام، شرح، تاریخ‌ها و سطرها باید کامل و متوازن باشند و دست‌کم دو
          سطر با حساب متفاوت داشته باشند.
        </p>
      ) : dates.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {dates.map((date) => (
            <li
              key={date}
              className="rounded-xl border border-border/80 bg-muted/40 px-3 py-1 text-sm tabular-nums"
            >
              {formatJalali(date)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          با تاریخ پایان انتخاب‌شده، رخداد آینده‌ای در دست نیست.
        </p>
      )}
    </div>
  );
}

export function RecurringVouchersSectionSkeleton() {
  return <SectionCardSkeleton rows={5} />;
}
