"use client";

/**
 * Accounting → «حساب‌های مالی» (issue #862).
 *
 * One screen for the business's own money containers — bank accounts, tills,
 * petty-cash floats and card terminals — each linked to exactly one postable GL
 * account. Three things this screen is deliberate about:
 *
 *  - **The balance is the ledger's.** Every figure on it (the rows, the per-kind
 *    totals, the account card) is summed server-side from `journal_lines` for the
 *    linked GL account. The screen never adds anything up itself and never keeps a
 *    running total between refreshes, so it cannot disagree with the trial balance.
 *  - **A container is archived, never deleted.** The list is the record of which
 *    GL account held which money; the delete path is a refusal with a sentence,
 *    and archiving is refused while the account still holds money.
 *  - **The bank numbers are not everybody's.** A member without
 *    `finance.accounts_manage` reads the register and sees masked identifiers, and
 *    the screen says so rather than drawing a broken field.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMoney } from "@/components/money/money-context";
import {
  ArchiveIcon,
  ArrowDownToLineIcon,
  BuildingIcon,
  CreditCardIcon,
  LandmarkIcon,
  PlusIcon,
  PrinterIcon,
  SearchIcon,
  WalletIcon,
} from "lucide-react";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { FilterChip, FilterChipRow, SearchField } from "@/app/dashboard/filters";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
  overlayPanelClass,
} from "@/app/dashboard/page-chrome";
import {
  DataCardTable,
  type DataCardTableColumn,
} from "@/app/dashboard/data-table";
import {
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  SecondaryButton,
  api,
  errorMessageOrRaw,
  inputClass,
} from "@/app/dashboard/ui";
import { OverlayDialog, LedgerLoadFailed, fmtJalali } from "./ledger-ui";
import {
  FINANCIAL_ACCOUNT_KIND_META,
  FINANCIAL_ACCOUNT_KINDS,
  financialAccountDisplayLabel,
  financialAccountScopeLabel,
  isZeroBalance,
  type FinancialAccountKind,
  type FinancialAccountRecord,
} from "@/lib/financial-accounts";
import { financialAccountErrorMessage } from "@/lib/financial-account-errors";
import { toPersianDigits } from "@/lib/digits";

type KindTab = "all" | FinancialAccountKind;
type StatusFilter = "active" | "archived" | "all";

interface ListResponse {
  accounts: FinancialAccountRecord[];
  totalsByKind: Record<FinancialAccountKind, string>;
  totalBalance: string;
  activeCount: number;
  archivedCount: number;
  canViewSensitive: boolean;
}

interface LocationOption {
  id: string;
  name: string;
}

interface CardMovementRow {
  entryId: string;
  entryDate: string;
  memo: string | null;
  sourceType: string | null;
  journalSourceId: string | null;
  debit: string;
  credit: string;
  balance: string;
  counterparty: string;
  reversedAt?: string | null;
}

interface CardResponse {
  account: FinancialAccountRecord;
  from: string | null;
  to: string | null;
  opening: string;
  rows: CardMovementRow[];
  totalDebit: string;
  totalCredit: string;
  closing: string;
  reconciliationDifference: string;
  ledgerBalance: string;
}

interface ProjectOption {
  id: string;
  name: string;
}

interface GlOption {
  id: string;
  code: string;
  name: string;
  currencyCode?: string | null;
}

interface AccountForm {
  id?: string;
  kind: FinancialAccountKind;
  name: string;
  code: string;
  glAccountId: string;
  currencyCode: string;
  locationId: string;
  isDefault: boolean;
  description: string;
  notes: string;
  bankName: string;
  bankBranchName: string;
  accountNumber: string;
  cardNumber: string;
  iban: string;
  accountHolder: string;
  settlementReference: string;
  pspProvider: string;
  terminalNumber: string;
  merchantNumber: string;
  settlementAccountId: string;
  settlementDelayDays: string;
}

function blankForm(kind: FinancialAccountKind, currencyCode: string): AccountForm {
  return {
    kind,
    name: "",
    code: "",
    glAccountId: "",
    currencyCode,
    locationId: "",
    isDefault: false,
    description: "",
    notes: "",
    bankName: "",
    bankBranchName: "",
    accountNumber: "",
    cardNumber: "",
    iban: "",
    accountHolder: "",
    settlementReference: "",
    pspProvider: "",
    terminalNumber: "",
    merchantNumber: "",
    settlementAccountId: "",
    settlementDelayDays: "",
  };
}

function formFromRecord(account: FinancialAccountRecord): AccountForm {
  return {
    id: account.id,
    kind: account.kind,
    name: account.name,
    code: account.code ?? "",
    glAccountId: account.glAccountId,
    currencyCode: account.currencyCode,
    locationId: account.locationId ?? "",
    isDefault: account.isDefault,
    description: account.description ?? "",
    notes: account.notes ?? "",
    bankName: account.bankName ?? "",
    bankBranchName: account.bankBranchName ?? "",
    accountNumber: account.accountNumber ?? "",
    cardNumber: account.cardNumber ?? "",
    iban: account.iban ?? "",
    accountHolder: account.accountHolder ?? "",
    settlementReference: account.settlementReference ?? "",
    pspProvider: account.pspProvider ?? "",
    terminalNumber: account.terminalNumber ?? "",
    merchantNumber: account.merchantNumber ?? "",
    settlementAccountId: account.settlementAccountId ?? "",
    settlementDelayDays: account.settlementDelayDays == null ? "" : String(account.settlementDelayDays),
  };
}

/**
 * The card's download URL for the filters currently on screen.
 *
 * The file has to be the same view the reader is looking at — a card exported
 * with a wider window than the one displayed is a file that quietly says
 * something else.
 */
function cardExportUrl(
  accountId: string,
  format: "csv" | "xlsx",
  filters: { from: string; to: string; projectId: string; locationId: string },
): string {
  const params = new URLSearchParams({ format });
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.projectId) params.set("projectId", filters.projectId);
  if (filters.locationId) params.set("locationId", filters.locationId);
  return `/api/ledger/financial-accounts/${accountId}/card?${params.toString()}`;
}

/**
 * A failed request always carries a code worth showing: the financial-account
 * dictionary first (it owns the domain's sentences), then the shared map, then
 * the caller's own fallback. The response body is `unknown` on purpose — a
 * proxy error page parses to `{}` and must not crash the screen.
 */
function messageFor(data: unknown, fallback: string): string {
  const code = (data as { error?: unknown } | null | undefined)?.error;
  if (typeof code !== "string" || !code) return fallback;
  return financialAccountErrorMessage(code) ?? errorMessageOrRaw(code) ?? fallback;
}

export function FinancialAccountsSection({
  busy,
  refreshKey,
  canManage,
}: {
  busy: boolean;
  refreshKey: number;
  canManage: boolean;
}) {
  const money = useMoney();
  const [data, setData] = useState<ListResponse | null>(null);
  const [loadError, setLoadError] = useState("");
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [baseCurrency, setBaseCurrency] = useState("IRR");
  const [enabledCurrencies, setEnabledCurrencies] = useState<string[]>([]);

  const [kind, setKind] = useState<KindTab>("all");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [search, setSearch] = useState("");
  const [locationId, setLocationId] = useState("");
  const [defaultOnly, setDefaultOnly] = useState(false);

  const [form, setForm] = useState<AccountForm | null>(null);
  const [glOptions, setGlOptions] = useState<GlOption[] | null>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const [archiveTarget, setArchiveTarget] = useState<FinancialAccountRecord | null>(null);
  const [archiveReason, setArchiveReason] = useState("");
  /**
   * Two error slots on purpose. `actionError` is the register's own (a restore
   * that failed), `archiveError` belongs to the dialog that caused it — a
   * refusal shown in two places at once reads as two failures.
   */
  const [actionError, setActionError] = useState("");
  const [archiveError, setArchiveError] = useState("");

  const [cardAccount, setCardAccount] = useState<FinancialAccountRecord | null>(null);
  const [card, setCard] = useState<CardResponse | null>(null);
  const [cardError, setCardError] = useState("");
  const [cardFrom, setCardFrom] = useState("");
  const [cardTo, setCardTo] = useState("");
  /*
   * The card's own filters. The route accepts a branch and a project as well as
   * a window — a card answers «what did this account do for THIS job, in THIS
   * branch» — so the dialog offers them rather than leaving three of the four
   * filters reachable only from a URL.
   */
  const [cardProjectId, setCardProjectId] = useState("");
  const [cardLocationId, setCardLocationId] = useState("");
  const [projects, setProjects] = useState<ProjectOption[]>([]);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (kind !== "all") params.set("kind", kind);
    params.set("status", status);
    if (locationId) params.set("locationId", locationId);
    if (defaultOnly) params.set("defaultOnly", "1");
    if (search.trim()) params.set("q", search.trim());
    api<ListResponse>(`/api/ledger/financial-accounts?${params.toString()}`).then(({ ok, data: body }) => {
      if (ok) {
        setData(body);
        setLoadError("");
      } else {
        setLoadError(messageFor(body, "بارگذاری حساب‌های مالی ناموفق بود."));
      }
    });
  }, [kind, status, locationId, defaultOnly, search]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useEffect(() => {
    api<{ active?: { id: string } | null; locations?: LocationOption[] }>("/api/locations/active").then(
      ({ ok, data: body }) => {
        if (ok) setLocations(body.locations ?? []);
      },
    );
    // Best-effort: a member who holds the ledger keys but not `workspace.view`
    // simply has no project filter, rather than a broken one.
    api<{ projects?: ProjectOption[] }>("/api/workspace/projects?limit=200").then(({ ok, data: body }) => {
      if (ok) setProjects(body.projects ?? []);
    });
    api<{ config?: { baseCurrencyCode?: string; enabled?: string[] } }>("/api/currencies").then(
      ({ ok, data: body }) => {
        if (!ok) return;
        const base = body.config?.baseCurrencyCode ?? "IRR";
        setBaseCurrency(base);
        const enabled = body.config?.enabled ?? [];
        setEnabledCurrencies(enabled.includes(base) ? enabled : [base, ...enabled]);
      },
    );
  }, []);

  /* The GL candidate list is per kind, and the kind can change inside the form —
     so it is fetched from the same eligibility endpoint the server enforces,
     never re-derived in the browser. */
  useEffect(() => {
    if (!form) {
      setGlOptions(null);
      return;
    }
    const params = new URLSearchParams({ kind: form.kind });
    if (form.id) params.set("excludeId", form.id);
    api<{ accounts: GlOption[] }>(`/api/ledger/financial-accounts/eligible?${params.toString()}`).then(
      ({ ok, data: body }) => {
        setGlOptions(ok ? (body.accounts ?? []) : []);
      },
    );
  }, [form?.kind, form?.id, form]);

  const openCard = useCallback(
    (account: FinancialAccountRecord) => {
      setCardAccount(account);
      setCard(null);
      setCardError("");
    },
    [],
  );

  const loadCard = useCallback(
    (accountId: string, filters: { from: string; to: string; projectId: string; locationId: string }) => {
      const params = new URLSearchParams();
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      if (filters.projectId) params.set("projectId", filters.projectId);
      if (filters.locationId) params.set("locationId", filters.locationId);
      api<CardResponse>(`/api/ledger/financial-accounts/${accountId}/card?${params.toString()}`).then(
        ({ ok, data: body }) => {
          if (ok) {
            setCard(body);
            setCardError("");
          } else {
            setCardError(messageFor(body, "بارگذاری صورت حساب ناموفق بود."));
          }
        },
      );
    },
    [],
  );

  useEffect(() => {
    if (cardAccount) {
      loadCard(cardAccount.id, { from: cardFrom, to: cardTo, projectId: cardProjectId, locationId: cardLocationId });
    }
  }, [cardAccount, cardFrom, cardTo, cardProjectId, cardLocationId, loadCard]);

  async function save() {
    if (!form) return;
    setSaving(true);
    setFormError("");
    const payload: Record<string, unknown> = {
      kind: form.kind,
      name: form.name.trim(),
      code: form.code.trim() || null,
      glAccountId: form.glAccountId,
      currencyCode: form.currencyCode || undefined,
      locationId: form.locationId || null,
      isDefault: form.isDefault,
      description: form.description.trim() || null,
      notes: form.notes.trim() || null,
    };
    if (FINANCIAL_ACCOUNT_KIND_META[form.kind].bankMetadata) {
      Object.assign(payload, {
        bankName: form.bankName.trim() || null,
        bankBranchName: form.bankBranchName.trim() || null,
        accountNumber: form.accountNumber.trim() || null,
        cardNumber: form.cardNumber.trim() || null,
        iban: form.iban.trim() || null,
        accountHolder: form.accountHolder.trim() || null,
        settlementReference: form.settlementReference.trim() || null,
      });
    }
    if (FINANCIAL_ACCOUNT_KIND_META[form.kind].pspMetadata) {
      Object.assign(payload, {
        pspProvider: form.pspProvider.trim() || null,
        terminalNumber: form.terminalNumber.trim() || null,
        merchantNumber: form.merchantNumber.trim() || null,
        settlementAccountId: form.settlementAccountId || null,
        settlementDelayDays: form.settlementDelayDays === "" ? null : Number(form.settlementDelayDays),
      });
    }
    const { ok, data: body } = form.id
      ? await api<{ error?: string }>(`/api/ledger/financial-accounts/${form.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      : await api<{ error?: string }>("/api/ledger/financial-accounts", {
          method: "POST",
          body: JSON.stringify(payload),
        });
    setSaving(false);
    if (!ok) {
      setFormError(messageFor(body, "ذخیرهٔ حساب ناموفق بود."));
      return;
    }
    setForm(null);
    load();
  }

  async function archive() {
    if (!archiveTarget) return;
    setSaving(true);
    setArchiveError("");
    const { ok, data: body } = await api<{ error?: string }>(
      `/api/ledger/financial-accounts/${archiveTarget.id}/archive`,
      { method: "POST", body: JSON.stringify({ reason: archiveReason.trim() || null }) },
    );
    setSaving(false);
    if (!ok) {
      setArchiveError(messageFor(body, "بایگانی حساب ناموفق بود."));
      return;
    }
    setArchiveTarget(null);
    setArchiveReason("");
    load();
  }

  /*
   * Restore is a `useCallback` rather than a plain function because the register
   * table is memoised on it: a new identity every render would rebuild the row
   * cells (and their handlers) on every keystroke of the search field.
   */
  const restore = useCallback(
    async (account: FinancialAccountRecord) => {
      setActionError("");
      const { ok, data: body } = await api<{ error?: string }>(
        `/api/ledger/financial-accounts/${account.id}`,
        { method: "PUT", body: JSON.stringify({}) },
      );
      if (!ok) {
        setActionError(messageFor(body, "بازگردانی حساب ناموفق بود."));
        return;
      }
      load();
    },
    [load],
  );

  function exportSummary(format: "csv" | "xlsx") {
    const params = new URLSearchParams({ format, status });
    if (kind !== "all") params.set("kind", kind);
    if (locationId) params.set("locationId", locationId);
    // A download, not a fetch: the browser's own save dialog is what a person
    // expects from «خروجی», and it keeps the file out of this component's state.
    window.open(`/api/ledger/financial-accounts/export?${params.toString()}`, "_blank");
  }

  const cardFilters = { from: cardFrom, to: cardTo, projectId: cardProjectId, locationId: cardLocationId };
  const totals = data?.totalsByKind;
  const columns: readonly DataCardTableColumn<FinancialAccountRecord>[] = useMemo(
    () => [
      {
        key: "name",
        header: "حساب",
        cell: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">
              {financialAccountDisplayLabel(row)}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{FINANCIAL_ACCOUNT_KIND_META[row.kind].plural}</span>
              <span aria-hidden="true">·</span>
              <span>{financialAccountScopeLabel(row.locationName)}</span>
              {row.isDefault ? <StatusBadge tone="active">پیش‌فرض</StatusBadge> : null}
              {!row.isActive ? <StatusBadge tone="neutral">بایگانی</StatusBadge> : null}
            </div>
          </div>
        ),
      },
      {
        key: "gl",
        header: "سرفصل دفتر کل",
        muted: true,
        cell: (row) => (
          <span className="font-mono text-xs" dir="ltr">
            {row.glAccountCode} — {row.glAccountName}
          </span>
        ),
      },
      { key: "code", header: "کد حساب", muted: true, cell: (row) => row.code ?? "—" },
      {
        key: "balance",
        header: `مانده (${money.unitLabel})`,
        align: "end",
        numeric: true,
        cell: (row) => <span className="font-medium">{money.formatText(row.balance)}</span>,
      },
      {
        key: "actions",
        header: "دسترسی",
        align: "end",
        desktopOnly: false,
        cell: (row) => (
          <div className="flex flex-wrap justify-end gap-1.5">
            <SecondaryButton onClick={() => openCard(row)}>صورت حساب</SecondaryButton>
            {canManage && row.isActive ? (
              <>
                <SecondaryButton onClick={() => setForm(formFromRecord(row))}>ویرایش</SecondaryButton>
                <SecondaryButton
                  onClick={() => {
                    setArchiveError("");
                    setArchiveReason("");
                    setArchiveTarget(row);
                  }}
                >
                  بایگانی
                </SecondaryButton>
              </>
            ) : null}
            {canManage && !row.isActive ? (
              <SecondaryButton onClick={() => restore(row)}>بازگردانی</SecondaryButton>
            ) : null}
          </div>
        ),
      },
    ],
    [canManage, money, openCard, restore],
  );

  if (!data && !loadError) return <SectionCardSkeleton rows={5} />;
  if (!data && loadError) {
    return <LedgerLoadFailed message={loadError} onRetry={load} />;
  }

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <ErrorBox>{loadError}</ErrorBox>
      <ErrorBox>{actionError}</ErrorBox>

      <KpiRow>
        <KpiCard
          label="جمع مانده حساب‌ها"
          value={`${money.formatText(data!.totalBalance)} ${money.unitLabel}`}
          icon={WalletIcon}
        />
        <KpiCard
          label={FINANCIAL_ACCOUNT_KIND_META.bank.plural}
          value={`${money.formatText(totals?.bank ?? "0")} ${money.unitLabel}`}
          hint="مجموع حساب‌های بانکی"
          icon={LandmarkIcon}
        />
        <KpiCard
          label={FINANCIAL_ACCOUNT_KIND_META.cash.plural}
          value={`${money.formatText(totals?.cash ?? "0")} ${money.unitLabel}`}
          hint="وجه نقد در صندوق‌ها"
          icon={BuildingIcon}
        />
        <KpiCard
          label={`${FINANCIAL_ACCOUNT_KIND_META.petty_cash.plural} و ${FINANCIAL_ACCOUNT_KIND_META.pos_psp.plural}`}
          value={`${money.formatText(
            (BigInt(totals?.petty_cash ?? "0") + BigInt(totals?.pos_psp ?? "0")).toString(),
          )} ${money.unitLabel}`}
          hint={`${toPersianDigits(String(data!.activeCount))} حساب فعال`}
          icon={CreditCardIcon}
        />
      </KpiRow>

      <SectionCard
        title="حساب‌های مالی"
        description="هر حساب به یک سرفصل دفتر کل وصل است؛ مانده از همان سرفصل خوانده می‌شود."
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <SecondaryButton onClick={() => exportSummary("csv")} disabled={busy}>
              <ArrowDownToLineIcon className="size-4" aria-hidden="true" />
              خروجی CSV
            </SecondaryButton>
            <SecondaryButton onClick={() => exportSummary("xlsx")} disabled={busy}>
              خروجی Excel
            </SecondaryButton>
            {canManage ? (
              <PrimaryButton onClick={() => setForm(blankForm("bank", baseCurrency))} disabled={busy}>
                <PlusIcon className="size-4" aria-hidden="true" />
                حساب تازه
              </PrimaryButton>
            ) : null}
          </div>
        }
      >
        <div className="space-y-3">
          <FilterChipRow label="نوع حساب" className="flex-nowrap overflow-x-auto pb-1">
            <FilterChip selected={kind === "all"} onClick={() => setKind("all")}>
              همه
            </FilterChip>
            {FINANCIAL_ACCOUNT_KINDS.map((candidate) => (
              <FilterChip
                key={candidate}
                selected={kind === candidate}
                onClick={() => setKind(candidate)}
              >
                {FINANCIAL_ACCOUNT_KIND_META[candidate].plural}
              </FilterChip>
            ))}
          </FilterChipRow>

          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1">
              <SearchField
                label="جست‌وجو در حساب‌ها"
                value={search}
                onChange={setSearch}
                placeholder="نام، کد، بانک یا شمارهٔ پایانه"
              />
            </div>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <SearchIcon className="size-3.5" aria-hidden="true" />
                شعبه
              </span>
              <select
                className={inputClass}
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
              >
                <option value="">همهٔ شعبه‌ها</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>وضعیت</span>
              <select
                className={inputClass}
                value={status}
                onChange={(event) => setStatus(event.target.value as StatusFilter)}
              >
                <option value="active">فعال</option>
                <option value="archived">بایگانی‌شده</option>
                <option value="all">همه</option>
              </select>
            </label>
            <FilterChip selected={defaultOnly} onClick={() => setDefaultOnly((value) => !value)}>
              فقط پیش‌فرض‌ها
            </FilterChip>
          </div>

          {!data!.canViewSensitive ? (
            <InfoBox>
              شمارهٔ حساب، کارت و شناسهٔ پایانه برای شما پوشیده است. برای دیدن مقدار کامل،
              دسترسی «مدیریت حساب‌های مالی» لازم است.
            </InfoBox>
          ) : null}

          {data!.accounts.length === 0 ? (
            <EmptyState
              icon={WalletIcon}
              title="حسابی با این فیلترها پیدا نشد"
              action={
                canManage ? (
                  <PrimaryButton onClick={() => setForm(blankForm("bank", baseCurrency))}>
                    ثبت نخستین حساب
                  </PrimaryButton>
                ) : undefined
              }
            >
              حساب‌های بانکی، صندوق‌ها، تنخواه و کارت‌خوان‌ها را اینجا ثبت کنید تا انتقال وجه،
              تطبیق و مانده‌گیری روی همان سرفصل‌های دفتر کل انجام شود.
            </EmptyState>
          ) : (
            <DataCardTable
              columns={columns}
              rows={data!.accounts}
              rowKey={(row) => row.id}
              caption="حساب‌های مالی کسب‌وکار"
              cardTitle={(row) => financialAccountDisplayLabel(row)}
              breakpoint="md"
            />
          )}
        </div>
      </SectionCard>

      {form ? (
        <AccountFormDialog
          form={form}
          setForm={setForm}
          glOptions={glOptions}
          locations={locations}
          currencies={enabledCurrencies.length > 0 ? enabledCurrencies : [baseCurrency]}
          busy={saving}
          error={formError}
          onSubmit={save}
          onClose={() => {
            setForm(null);
            setFormError("");
          }}
        />
      ) : null}

      {archiveTarget ? (
        <OverlayDialog
          headingId="financial-account-archive-heading"
          role="alertdialog"
          dismissible={!saving}
          onClose={() => setArchiveTarget(null)}
          className={`${overlayPanelClass} max-h-[88vh] w-full max-w-lg overflow-y-auto p-4 sm:p-5`}
        >
          <h2 id="financial-account-archive-heading" className="text-base font-semibold text-foreground">
            بایگانی «{archiveTarget.name}»
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            حساب بایگانی می‌شود و از فهرست‌های فعال بیرون می‌رود، اما سابقهٔ حسابداری آن
            و سند‌هایش دست‌نخورده می‌مانند. حساب با ماندهٔ غیرصفر بایگانی نمی‌شود.
          </p>
          <div className="mt-3">
            <Field label="دلیل بایگانی (اختیاری)">
              <input
                className={inputClass}
                value={archiveReason}
                onChange={(event) => setArchiveReason(event.target.value)}
                placeholder="مثلاً: بستن شعبه"
              />
            </Field>
          </div>
          <ErrorBox>{archiveError}</ErrorBox>
          <div className="mt-4 flex justify-end gap-2">
            <SecondaryButton onClick={() => setArchiveTarget(null)} disabled={saving}>
              انصراف
            </SecondaryButton>
            <PrimaryButton onClick={archive} disabled={saving}>
              <ArchiveIcon className="size-4" aria-hidden="true" />
              {saving ? "در حال بایگانی…" : "بایگانی کن"}
            </PrimaryButton>
          </div>
        </OverlayDialog>
      ) : null}

      {cardAccount ? (
        <OverlayDialog
          headingId="financial-account-card-heading"
          sheet
          onClose={() => {
            setCardAccount(null);
            setCard(null);
            setCardError("");
          }}
          className={`${overlayPanelClass} max-h-[92vh] w-full max-w-4xl overflow-y-auto p-4 sm:p-5`}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2
                id="financial-account-card-heading"
                className="text-base font-semibold text-foreground"
              >
                صورت حساب {cardAccount.name}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                سرفصل {cardAccount.glAccountCode} — {cardAccount.glAccountName} ·{" "}
                {financialAccountScopeLabel(cardAccount.locationName)} · {cardAccount.currencyCode}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <SecondaryButton onClick={() => window.print()}>
                <PrinterIcon className="size-4" aria-hidden="true" />
                چاپ / PDF
              </SecondaryButton>
              <SecondaryButton onClick={() => window.open(cardExportUrl(cardAccount.id, "csv", cardFilters), "_blank")}>
                خروجی CSV
              </SecondaryButton>
              <SecondaryButton onClick={() => window.open(cardExportUrl(cardAccount.id, "xlsx", cardFilters), "_blank")}>
                خروجی Excel
              </SecondaryButton>
            </div>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="از تاریخ">
              <JalaliDatePicker value={cardFrom} onChange={setCardFrom} ariaLabel="از تاریخ" />
            </Field>
            <Field label="تا تاریخ">
              <JalaliDatePicker value={cardTo} onChange={setCardTo} ariaLabel="تا تاریخ" />
            </Field>
            <Field label="شعبه">
              <select
                className={inputClass}
                value={cardLocationId}
                onChange={(event) => setCardLocationId(event.target.value)}
              >
                <option value="">همهٔ شعبه‌ها</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </Field>
            {projects.length > 0 ? (
              <Field label="پروژه">
                <select
                  className={inputClass}
                  value={cardProjectId}
                  onChange={(event) => setCardProjectId(event.target.value)}
                >
                  <option value="">بدون پروژه</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </div>

          <ErrorBox>{cardError}</ErrorBox>

          {!card && !cardError ? (
            <div className="mt-3">
              <SectionCardSkeleton rows={4} />
            </div>
          ) : null}

          {card ? (
            <div className="mt-3 space-y-3">
              <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <CardStat label="مانده ابتدای دوره" value={money.formatText(card.opening)} />
                <CardStat label="جمع بدهکار" value={money.formatText(card.totalDebit)} />
                <CardStat label="جمع بستانکار" value={money.formatText(card.totalCredit)} />
                <CardStat label="مانده پایان دوره" value={money.formatText(card.closing)} />
              </dl>
              {!isZeroBalance(card.reconciliationDifference) ? (
                <ErrorBox>
                  مغایرت با دفتر کل: {money.formatText(card.reconciliationDifference)} {money.unitLabel}
                </ErrorBox>
              ) : (
                <InfoBox>
                  صورت حساب با دفتر کل تطبیق دارد؛ ماندهٔ دفتر کل{" "}
                  {money.formatText(card.ledgerBalance)} {money.unitLabel} است.
                </InfoBox>
              )}
              {card.rows.length === 0 ? (
                <EmptyState icon={WalletIcon} title="در این بازه گردشی ثبت نشده است">
                  برای دیدن همهٔ گردش‌ها، بازهٔ تاریخ را بازتر کنید.
                </EmptyState>
              ) : (
                <DataCardTable
                  columns={cardColumns(money, card.rows)}
                  rows={card.rows}
                  rowKey={(row) => row.entryId}
                  caption="گردش حساب مالی"
                  breakpoint="md"
                />
              )}
            </div>
          ) : null}
        </OverlayDialog>
      ) : null}
    </div>
  );
}

function CardStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function cardColumns(
  money: ReturnType<typeof useMoney>,
  rows: readonly CardMovementRow[],
): readonly DataCardTableColumn<CardMovementRow>[] {
  void rows;
  return [
    {
      key: "date",
      header: "تاریخ",
      muted: true,
      cell: (row) => fmtJalali(row.entryDate),
    },
    {
      key: "memo",
      header: "شرح",
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate">{row.memo ?? "—"}</div>
          <div className="text-xs text-muted-foreground">{row.counterparty || "—"}</div>
        </div>
      ),
    },
    {
      key: "debit",
      header: "بدهکار",
      align: "end",
      numeric: true,
      cell: (row) => (row.debit === "0" ? "—" : money.formatText(row.debit)),
    },
    {
      key: "credit",
      header: "بستانکار",
      align: "end",
      numeric: true,
      cell: (row) => (row.credit === "0" ? "—" : money.formatText(row.credit)),
    },
    {
      key: "balance",
      header: "مانده",
      align: "end",
      numeric: true,
      cell: (row) => (
        <span className={row.reversedAt ? "text-muted-foreground line-through" : undefined}>
          {money.formatText(row.balance)}
        </span>
      ),
    },
    {
      key: "entry",
      header: "سند",
      muted: true,
      desktopOnly: true,
      cell: (row) => (
        <span className="font-mono text-xs" dir="ltr">
          {row.entryId.slice(0, 8)}
        </span>
      ),
    },
  ];
}

function AccountFormDialog({
  form,
  setForm,
  glOptions,
  locations,
  currencies,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  form: AccountForm;
  setForm: (next: AccountForm) => void;
  glOptions: GlOption[] | null;
  locations: LocationOption[];
  currencies: string[];
  busy: boolean;
  error: string;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const meta = FINANCIAL_ACCOUNT_KIND_META[form.kind];
  const set = <K extends keyof AccountForm>(key: K, value: AccountForm[K]) =>
    setForm({ ...form, [key]: value });

  return (
    <OverlayDialog
      headingId="financial-account-form-heading"
      sheet
      dismissible={!busy}
      onClose={onClose}
      className={`${overlayPanelClass} max-h-[92vh] w-full max-w-3xl overflow-y-auto p-4 sm:p-5`}
    >
      <h2 id="financial-account-form-heading" className="text-base font-semibold text-foreground">
        {form.id ? "ویرایش حساب مالی" : "حساب مالی تازه"}
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">{meta.description}</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="نوع حساب">
          <select
            className={inputClass}
            value={form.kind}
            onChange={(event) => set("kind", event.target.value as FinancialAccountKind)}
            disabled={Boolean(form.id)}
          >
            {FINANCIAL_ACCOUNT_KINDS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {FINANCIAL_ACCOUNT_KIND_META[candidate].label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="نام حساب">
          <input
            className={inputClass}
            value={form.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="مثلاً: بانک ملت — حساب جاری"
          />
        </Field>
        <Field label="سرفصل دفتر کل" hint="هر سرفصل فقط به یک حساب مالی وصل می‌شود.">
          <select
            className={inputClass}
            value={form.glAccountId}
            onChange={(event) => set("glAccountId", event.target.value)}
            disabled={glOptions === null}
          >
            <option value="">
              {glOptions === null ? "در حال خواندن سرفصل‌ها…" : "انتخاب سرفصل"}
            </option>
            {(glOptions ?? []).map((option) => (
              <option key={option.id} value={option.id}>
                {option.code} — {option.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="کد حساب (اختیاری)">
          <input
            className={inputClass}
            value={form.code}
            onChange={(event) => set("code", event.target.value)}
            dir="ltr"
          />
        </Field>
        <Field label="شعبه" hint="خالی یعنی حساب کل کسب‌وکار.">
          <select
            className={inputClass}
            value={form.locationId}
            onChange={(event) => set("locationId", event.target.value)}
          >
            <option value="">همهٔ شعبه‌ها</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="ارز">
          <select
            className={inputClass}
            value={form.currencyCode}
            onChange={(event) => set("currencyCode", event.target.value)}
          >
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {meta.bankMetadata ? (
        <fieldset className="mt-4 grid gap-3 sm:grid-cols-2">
          <legend className="mb-1 text-sm font-medium text-foreground">اطلاعات بانکی</legend>
          <Field label="نام بانک">
            <input
              className={inputClass}
              value={form.bankName}
              onChange={(event) => set("bankName", event.target.value)}
            />
          </Field>
          <Field label="نام شعبهٔ بانک">
            <input
              className={inputClass}
              value={form.bankBranchName}
              onChange={(event) => set("bankBranchName", event.target.value)}
            />
          </Field>
          <Field label="شمارهٔ حساب">
            <input
              className={inputClass}
              value={form.accountNumber}
              onChange={(event) => set("accountNumber", event.target.value)}
              dir="ltr"
            />
          </Field>
          <Field label="شمارهٔ کارت" hint="۱۶ رقم.">
            <input
              className={inputClass}
              value={form.cardNumber}
              onChange={(event) => set("cardNumber", event.target.value)}
              dir="ltr"
            />
          </Field>
          <Field label="شبا" hint="با IR و ۲۴ رقم.">
            <input
              className={inputClass}
              value={form.iban}
              onChange={(event) => set("iban", event.target.value)}
              dir="ltr"
            />
          </Field>
          <Field label="صاحب حساب">
            <input
              className={inputClass}
              value={form.accountHolder}
              onChange={(event) => set("accountHolder", event.target.value)}
            />
          </Field>
          <Field label="شناسهٔ پذیرنده / تسویه">
            <input
              className={inputClass}
              value={form.settlementReference}
              onChange={(event) => set("settlementReference", event.target.value)}
              dir="ltr"
            />
          </Field>
        </fieldset>
      ) : null}

      {meta.pspMetadata ? (
        <fieldset className="mt-4 grid gap-3 sm:grid-cols-2">
          <legend className="mb-1 text-sm font-medium text-foreground">اطلاعات پایانه</legend>
          <Field label="ارائه‌دهندهٔ خدمات">
            <input
              className={inputClass}
              value={form.pspProvider}
              onChange={(event) => set("pspProvider", event.target.value)}
              placeholder="مثلاً: به‌پرداخت"
            />
          </Field>
          <Field label="شمارهٔ پایانه">
            <input
              className={inputClass}
              value={form.terminalNumber}
              onChange={(event) => set("terminalNumber", event.target.value)}
              dir="ltr"
            />
          </Field>
          <Field label="شمارهٔ پذیرنده">
            <input
              className={inputClass}
              value={form.merchantNumber}
              onChange={(event) => set("merchantNumber", event.target.value)}
              dir="ltr"
            />
          </Field>
          <Field label="مهلت تسویه (روز)" hint="۰ تا ۹۰ روز.">
            <PersianNumberInput
              className={inputClass}
              value={form.settlementDelayDays}
              onChange={(event) => set("settlementDelayDays", event.target.value)}
              inputMode="numeric"
            />
          </Field>
          <Field label="حساب تسویه">
            <input
              className={inputClass}
              value={form.settlementAccountId}
              onChange={(event) => set("settlementAccountId", event.target.value)}
              placeholder="شناسهٔ حساب بانکی تسویه"
              dir="ltr"
            />
          </Field>
        </fieldset>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="توضیح">
          <input
            className={inputClass}
            value={form.description}
            onChange={(event) => set("description", event.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 pt-6 text-sm text-foreground">
          <input
            type="checkbox"
            checked={form.isDefault}
            onChange={(event) => set("isDefault", event.target.checked)}
          />
          پیش‌فرض این نوع در این شعبه
        </label>
      </div>

      <ErrorBox>{error}</ErrorBox>
      <div className="mt-4 flex justify-end gap-2">
        <SecondaryButton onClick={onClose} disabled={busy}>
          انصراف
        </SecondaryButton>
        <PrimaryButton onClick={onSubmit} disabled={busy || !form.name.trim() || !form.glAccountId}>
          {busy ? "در حال ذخیره…" : form.id ? "ذخیرهٔ تغییرات" : "ثبت حساب"}
        </PrimaryButton>
      </div>
    </OverlayDialog>
  );
}
