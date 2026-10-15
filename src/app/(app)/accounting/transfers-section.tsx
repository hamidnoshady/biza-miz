"use client";

/**
 * Accounting → «انتقال وجه» (issue #862).
 *
 * The register of money moved between the business's own financial accounts, and
 * the form that moves it. Four things this screen is deliberate about:
 *
 *  - **The preview is the real posting.** The journal lines shown before the
 *    confirm are computed by `buildTransferLines` — the same pure function the
 *    server posts with — so the preview cannot describe an entry the ledger will
 *    not get. A form that "looks balanced" and posts something else is how a
 *    transfer screen loses its readers' trust.
 *  - **One request is one document.** The form carries an idempotency key minted
 *    when it opens and reused on every retry, so a lost response cannot post the
 *    movement twice.
 *  - **A transfer is never edited.** A mistake is reversed: a mirror entry, a
 *    reason, and both documents stay on the register.
 *  - **No invented money.** The amount is entered in the business's own display
 *    unit and converted to Rial exactly (`parseToRialText`), and a foreign
 *    transfer needs a rate that already exists — the server refuses rather than
 *    converting at a rate it made up.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMoney } from "@/components/money/money-context";
import {
  ArrowDownToLineIcon,
  ArrowLeftRightIcon,
  PlusIcon,
  PrinterIcon,
  UndoIcon,
  WalletIcon,
} from "lucide-react";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { SearchableSelect, type SelectOption } from "@/components/ui/searchable-select";
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
import { DataCardTable, type DataCardTableColumn } from "@/app/dashboard/data-table";
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
import { MediaPickerDialog, mediaFileUrl, type PickedMedia } from "@/app/dashboard/media/media-picker";
import { JournalPeekDialog } from "./journal-peek-dialog";
import { OverlayDialog, LedgerLoadFailed, fmtJalali } from "./ledger-ui";
import { financialAccountErrorMessage } from "@/lib/financial-account-errors";
import {
  FINANCIAL_ACCOUNT_KIND_META,
  financialAccountDisplayLabel,
  isRialAmountText,
  type FinancialAccountKind,
  type FinancialAccountRecord,
} from "@/lib/financial-accounts";
import {
  TRANSFER_FEE_PAYER_LABELS,
  TRANSFER_FEE_PAYERS,
  TRANSFER_STATUS_LABELS,
  TRANSFER_DESCRIPTION_MAX,
  TRANSFER_REFERENCE_MAX,
  TRANSFER_REVERSAL_REASON_MAX,
  buildTransferLines,
  isTransferFeePayer,
  transferPostingProblem,
  type TransferFeePayer,
  type TransferStatus,
} from "@/lib/financial-transfers";
import { parseToRialText } from "@/lib/money";
import { todayIsoDate } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";

interface TransferRow {
  id: string;
  transferNumber: string;
  transferDate: string;
  sourceAccountId: string;
  sourceAccountName: string | null;
  sourceAccountKind: FinancialAccountKind | null;
  destinationAccountId: string;
  destinationAccountName: string | null;
  destinationAccountKind: FinancialAccountKind | null;
  amount: string;
  feeAmount: string;
  feePayer: TransferFeePayer;
  currencyCode: string;
  referenceNumber: string | null;
  description: string | null;
  projectName: string | null;
  status: TransferStatus;
  postingMode: "transfer" | "reversal";
  journalEntryId: string;
  reversalEntryId: string | null;
  reversesTransferId: string | null;
  reversalReason: string | null;
  reversalTransferNumber: string | null;
  locationName: string | null;
  createdByName: string | null;
  attachmentAssetId: string | null;
  sourceOutflow: string;
  destinationInflow: string;
}

interface RegisterResponse {
  transfers: TransferRow[];
  totalCount: number;
  totalAmount: string;
  totalFee: string;
  postedCount: number;
  reversedCount: number;
}

interface DetailResponse {
  transfer: TransferRow & {
    journalLines: { accountId: string; accountCode: string; accountName: string; debit: string; credit: string }[];
  };
}

interface LocationOption {
  id: string;
  name: string;
}

interface ChartAccount {
  id: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  is_postable?: boolean;
}

interface ProjectOption {
  id: string;
  name: string;
}

interface TransferForm {
  transferDate: string;
  sourceAccountId: string;
  destinationAccountId: string;
  amountInput: string;
  feeInput: string;
  feePayer: TransferFeePayer;
  feeAccountId: string;
  referenceNumber: string;
  description: string;
  projectId: string;
  /** Minted once per attempt, so a retry after a lost response is the same request. */
  idempotencyKey: string;
  attachment: PickedMedia | null;
}

/**
 * A new transfer, dated today.
 *
 * The date is pre-filled rather than left empty: «انتقال وجه» is written when the
 * money moved, which is almost always today, and a form that refuses to submit
 * until a date is picked is a form that hides its own button for no reason. The
 * date stays editable for the day the receipt arrives late — and the server still
 * enforces its own fiscal-period locks on whatever date is sent.
 */
function blankForm(today: string): TransferForm {
  return {
    transferDate: today,
    sourceAccountId: "",
    destinationAccountId: "",
    amountInput: "",
    feeInput: "",
    feePayer: "source",
    feeAccountId: "",
    referenceNumber: "",
    description: "",
    projectId: "",
    idempotencyKey: crypto.randomUUID(),
    attachment: null,
  };
}

/**
 * A failed request always carries a code worth showing: the financial-account
 * dictionary first (it owns the domain's sentences), then the shared map, then
 * the caller's own fallback. The body is `unknown` on purpose — a proxy error
 * page parses to `{}` and must not crash the screen.
 */
function messageFor(data: unknown, fallback: string): string {
  const code = (data as { error?: unknown } | null | undefined)?.error;
  if (typeof code !== "string" || !code) return fallback;
  return financialAccountErrorMessage(code) ?? errorMessageOrRaw(code) ?? fallback;
}

export function TransfersSection({
  busy,
  run,
  refreshKey,
  canManage,
  canBrowseMedia,
}: {
  busy: boolean;
  run: (fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => Promise<boolean>;
  refreshKey: number;
  canManage: boolean;
  canBrowseMedia?: boolean;
}) {
  const money = useMoney();
  const [data, setData] = useState<RegisterResponse | null>(null);
  const [loadError, setLoadError] = useState("");
  const [accounts, setAccounts] = useState<FinancialAccountRecord[]>([]);
  const [chart, setChart] = useState<ChartAccount[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState<"posted" | "reversed" | "">("");
  const [accountId, setAccountId] = useState("");
  const [kind, setKind] = useState<FinancialAccountKind | "">("");
  const [locationId, setLocationId] = useState("");
  const [search, setSearch] = useState("");

  const [form, setForm] = useState<TransferForm | null>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);

  const [detail, setDetail] = useState<DetailResponse["transfer"] | null>(null);
  const [detailError, setDetailError] = useState("");
  const [peek, setPeek] = useState<{ entryId: string; title: string } | null>(null);

  const [reverseTarget, setReverseTarget] = useState<TransferRow | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseDate, setReverseDate] = useState("");
  const [reverseError, setReverseError] = useState("");

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (status) params.set("status", status);
    if (accountId) params.set("accountId", accountId);
    if (kind) params.set("kind", kind);
    if (locationId) params.set("locationId", locationId);
    if (search.trim()) params.set("q", search.trim());
    api<RegisterResponse>(`/api/ledger/transfers?${params.toString()}`).then(({ ok, data: body }) => {
      if (ok) {
        setData(body);
        setLoadError("");
      } else {
        setLoadError(messageFor(body, "بارگذاری فهرست انتقال‌ها ناموفق بود."));
      }
    });
  }, [from, to, status, accountId, kind, locationId, search]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useEffect(() => {
    api<{ accounts: FinancialAccountRecord[] }>("/api/ledger/financial-accounts?status=active").then(
      ({ ok, data: body }) => {
        if (ok) setAccounts(body.accounts ?? []);
      },
    );
    api<{ accounts: ChartAccount[] }>("/api/ledger/accounts").then(({ ok, data: body }) => {
      if (ok) setChart(body.accounts ?? []);
    });
    api<{ locations?: LocationOption[] }>("/api/locations/active").then(({ ok, data: body }) => {
      if (ok) setLocations(body.locations ?? []);
    });
    // Best-effort: a member who holds `finance.transfers_manage` but not
    // `workspace.view` simply has no project picker, rather than a broken one.
    api<{ projects?: ProjectOption[] }>("/api/workspace/projects?limit=200").then(({ ok, data: body }) => {
      if (ok) setProjects(body.projects ?? []);
    });
  }, []);

  const accountOptions: SelectOption[] = useMemo(
    () =>
      accounts.map((account) => ({
        value: account.id,
        label: financialAccountDisplayLabel(account),
        searchString: `${account.name} ${account.code ?? ""} ${account.bankName ?? ""} ${account.glAccountCode}`,
      })),
    [accounts],
  );

  const selectedSource = accounts.find((account) => account.id === form?.sourceAccountId) ?? null;
  const selectedDestination = accounts.find((account) => account.id === form?.destinationAccountId) ?? null;

  const preview = useMemo(() => {
    if (!form || !selectedSource || !selectedDestination) return null;
    const amount = moneyTextField(form.amountInput, money.unit);
    const fee = form.feeInput.trim() ? moneyTextField(form.feeInput, money.unit) : "0";
    if (!amount || !isRialAmountText(amount) || !isRialAmountText(fee)) return null;
    const postingAccounts = {
      sourceGlAccountId: selectedSource.glAccountId,
      destinationGlAccountId: selectedDestination.glAccountId,
      feeGlAccountId: form.feeAccountId || null,
    };
    const postingInput = { amount, feeAmount: fee, feePayer: form.feePayer };
    const problem = transferPostingProblem(postingAccounts, postingInput);
    if (problem) return { problem, lines: null as null | ReturnType<typeof buildTransferLines> };
    return { problem: null, lines: buildTransferLines(postingAccounts, postingInput) };
  }, [form, selectedSource, selectedDestination, money.unit]);

  async function submit() {
    if (!form) return;
    setSaving(true);
    setFormError("");
    const amount = moneyTextField(form.amountInput, money.unit);
    const fee = form.feeInput.trim() ? moneyTextField(form.feeInput, money.unit) : "0";
    const payload: Record<string, unknown> = {
      transferDate: form.transferDate,
      sourceAccountId: form.sourceAccountId,
      destinationAccountId: form.destinationAccountId,
      amount,
      feeAmount: fee,
      feePayer: form.feePayer,
      feeAccountId: form.feeAccountId || null,
      referenceNumber: form.referenceNumber.trim() || null,
      description: form.description.trim() || null,
      projectId: form.projectId || null,
      attachmentAssetId: form.attachment?.id ?? null,
      idempotencyKey: form.idempotencyKey,
    };
    const { ok, data: body } = await api<{ error?: string }>("/api/ledger/transfers", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (!ok) {
      setFormError(messageFor(body, "ثبت انتقال وجه ناموفق بود."));
      return;
    }
    setForm(null);
    load();
  }

  const openDetail = useCallback(async (id: string) => {
    setDetailError("");
    setDetail(null);
    const { ok, data: body } = await api<DetailResponse>(`/api/ledger/transfers/${id}`);
    if (ok) setDetail(body.transfer);
    else setDetailError(messageFor(body, "بارگذاری سند انتقال ناموفق بود."));
  }, []);

  async function reverse() {
    if (!reverseTarget) return;
    if (!reverseReason.trim()) {
      setReverseError("دلیل برگشت سند الزامی است.");
      return;
    }
    setSaving(true);
    setReverseError("");
    const { ok, data: body } = await api<{ error?: string }>(
      `/api/ledger/transfers/${reverseTarget.id}/reverse`,
      {
        method: "POST",
        body: JSON.stringify({
          reason: reverseReason.trim(),
          reversalDate: reverseDate || null,
        }),
      },
    );
    setSaving(false);
    if (!ok) {
      setReverseError(messageFor(body, "برگشت سند ناموفق بود."));
      return;
    }
    setReverseTarget(null);
    setReverseReason("");
    setReverseDate("");
    load();
  }

  function exportRegister(format: "csv" | "xlsx") {
    const params = new URLSearchParams({ format });
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (status) params.set("status", status);
    if (accountId) params.set("accountId", accountId);
    if (kind) params.set("kind", kind);
    if (locationId) params.set("locationId", locationId);
    if (search.trim()) params.set("q", search.trim());
    window.open(`/api/ledger/transfers/export?${params.toString()}`, "_blank");
  }

  const columns: readonly DataCardTableColumn<TransferRow>[] = useMemo(
    () => [
      {
        key: "number",
        header: "شماره / تاریخ",
        cell: (row) => (
          <div className="min-w-0">
            <div className="font-medium text-foreground" dir="ltr">
              {row.transferNumber}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{fmtJalali(row.transferDate)}</span>
              <StatusBadge tone={row.status === "posted" ? "positive" : "neutral"}>
                {TRANSFER_STATUS_LABELS[row.status]}
              </StatusBadge>
              {row.status === "reversed" && row.reversalTransferNumber ? (
                <span>{`برگشت با ${row.reversalTransferNumber}`}</span>
              ) : null}
              {row.postingMode === "reversal" ? <StatusBadge tone="neutral">برگشت سند</StatusBadge> : null}
            </div>
          </div>
        ),
      },
      {
        key: "route",
        header: "از ← به",
        cell: (row) => (
          <div className="min-w-0 text-sm">
            <div className="truncate">{row.sourceAccountName ?? "—"}</div>
            <div className="truncate text-muted-foreground">{row.destinationAccountName ?? "—"}</div>
          </div>
        ),
      },
      {
        key: "amount",
        header: `مبلغ (${money.unitLabel})`,
        align: "end",
        numeric: true,
        cell: (row) => (
          <div>
            <div className="font-medium">{money.formatText(row.amount)}</div>
            {row.feeAmount !== "0" ? (
              <div className="text-xs text-muted-foreground">
                کارمزد {money.formatText(row.feeAmount)} —{" "}
                {TRANSFER_FEE_PAYER_LABELS[row.feePayer]}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        key: "branch",
        header: "شعبه / ثبت‌کننده",
        muted: true,
        desktopOnly: true,
        cell: (row) => (
          <div className="text-xs">
            <div>{row.locationName ?? "همهٔ شعبه‌ها"}</div>
            <div className="text-muted-foreground">{row.createdByName ?? "—"}</div>
          </div>
        ),
      },
      {
        key: "actions",
        header: "دسترسی",
        align: "end",
        cell: (row) => (
          <div className="flex flex-wrap justify-end gap-1.5">
            <SecondaryButton onClick={() => void openDetail(row.id)}>جزئیات</SecondaryButton>
            {canManage && row.status === "posted" && row.postingMode === "transfer" ? (
              <SecondaryButton
                onClick={() => {
                  setReverseError("");
                  setReverseTarget(row);
                }}
              >
                برگشت سند
              </SecondaryButton>
            ) : null}
          </div>
        ),
      },
    ],
    [canManage, money, openDetail],
  );

  if (!data && !loadError) return <SectionCardSkeleton rows={5} />;
  if (!data && loadError) return <LedgerLoadFailed message={loadError} onRetry={load} />;

  const feeAccounts = chart.filter(
    (account) => account.type === "expense" && account.is_postable !== false,
  );

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <ErrorBox>{loadError}</ErrorBox>

      <KpiRow>
        <KpiCard
          label="جمع انتقال‌های فهرست"
          value={`${money.formatText(data!.totalAmount)} ${money.unitLabel}`}
          hint={`${toPersianDigits(String(data!.totalCount))} سند`}
          icon={ArrowLeftRightIcon}
        />
        <KpiCard
          label="کارمزد کل"
          value={`${money.formatText(data!.totalFee)} ${money.unitLabel}`}
          icon={WalletIcon}
        />
        <KpiCard
          label="در جریان"
          value={toPersianDigits(String(data!.postedCount))}
          hint="انتقال‌های برگشت‌نخورده"
        />
        <KpiCard
          label="برگشت‌خورده"
          value={toPersianDigits(String(data!.reversedCount))}
          hint="سند برگشتی"
        />
      </KpiRow>

      <SectionCard
        title="انتقال وجه"
        description="جابه‌جایی وجه بین حساب‌های مالی؛ هر انتقال یک سند دوطرفهٔ متوازن در دفتر می‌سازد."
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <SecondaryButton onClick={() => exportRegister("csv")} disabled={busy}>
              <ArrowDownToLineIcon className="size-4" aria-hidden="true" />
              خروجی CSV
            </SecondaryButton>
            <SecondaryButton onClick={() => exportRegister("xlsx")} disabled={busy}>
              خروجی Excel
            </SecondaryButton>
            {canManage ? (
              <PrimaryButton onClick={() => setForm(blankForm(todayIsoDate()))} disabled={busy}>
                <PlusIcon className="size-4" aria-hidden="true" />
                انتقال تازه
              </PrimaryButton>
            ) : null}
          </div>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="از تاریخ">
              <JalaliDatePicker value={from} onChange={setFrom} ariaLabel="از تاریخ" />
            </Field>
            <Field label="تا تاریخ">
              <JalaliDatePicker value={to} onChange={setTo} ariaLabel="تا تاریخ" />
            </Field>
            <Field label="حساب">
              <select
                className={inputClass}
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
              >
                <option value="">همهٔ حساب‌ها</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {financialAccountDisplayLabel(account)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="شعبه">
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
            </Field>
          </div>

          <FilterChipRow label="نوع حساب" className="flex-nowrap overflow-x-auto pb-1">
            <FilterChip selected={kind === ""} onClick={() => setKind("")}>
              همه
            </FilterChip>
            {(Object.keys(FINANCIAL_ACCOUNT_KIND_META) as FinancialAccountKind[]).map((candidate) => (
              <FilterChip key={candidate} selected={kind === candidate} onClick={() => setKind(candidate)}>
                {FINANCIAL_ACCOUNT_KIND_META[candidate].plural}
              </FilterChip>
            ))}
          </FilterChipRow>

          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1">
              <SearchField
                label="جست‌وجو در انتقال‌ها"
                value={search}
                onChange={setSearch}
                placeholder="شمارهٔ سند، شرح، شمارهٔ پیگیری یا نام حساب"
              />
            </div>
            <FilterChip selected={status === "posted"} onClick={() => setStatus(status === "posted" ? "" : "posted")}>
              ثبت‌شده
            </FilterChip>
            <FilterChip
              selected={status === "reversed"}
              onClick={() => setStatus(status === "reversed" ? "" : "reversed")}
            >
              برگشت‌خورده
            </FilterChip>
          </div>

          {data!.transfers.length === 0 ? (
            <EmptyState
              icon={ArrowLeftRightIcon}
              title="انتقالی با این فیلترها ثبت نشده است"
              action={
                canManage ? (
                  <PrimaryButton onClick={() => setForm(blankForm(todayIsoDate()))}>ثبت انتقال تازه</PrimaryButton>
                ) : undefined
              }
            >
              انتقال وجه برای جابه‌جایی بین حساب‌های مالی خودتان است — مثلاً واریز نقدی صندوق به بانک یا
              انتقال از کارت‌خوان به حساب بانکی. برای پرداخت به دیگران از «دریافت و پرداخت» استفاده کنید.
            </EmptyState>
          ) : (
            <DataCardTable
              columns={columns}
              rows={data!.transfers}
              rowKey={(row) => row.id}
              caption="فهرست انتقال‌های وجه"
              cardTitle={(row) => row.transferNumber}
              breakpoint="md"
            />
          )}
        </div>
      </SectionCard>

      {form ? (
        <TransferFormDialog
          form={form}
          setForm={setForm}
          accountOptions={accountOptions}
          accounts={accounts}
          feeAccounts={feeAccounts}
          projects={projects}
          preview={preview}
          money={money}
          saving={saving}
          error={formError}
          canBrowseMedia={canBrowseMedia}
          onPickMedia={() => setMediaOpen(true)}
          onSubmit={submit}
          onClose={() => {
            setForm(null);
            setFormError("");
          }}
        />
      ) : null}

      {mediaOpen ? (
        <MediaPickerDialog
          title="پیوست انتقال وجه"
          kind="document"
          canUpload={canBrowseMedia !== false}
          onPick={(asset) => {
            setMediaOpen(false);
            setForm((current) => (current ? { ...current, attachment: asset } : current));
          }}
          onClose={() => setMediaOpen(false)}
        />
      ) : null}

      {detail || detailError ? (
        <OverlayDialog
          headingId="transfer-detail-heading"
          sheet
          onClose={() => {
            setDetail(null);
            setDetailError("");
          }}
          className={`${overlayPanelClass} max-h-[92vh] w-full max-w-3xl overflow-y-auto p-4 sm:p-5`}
        >
          <h2 id="transfer-detail-heading" className="text-base font-semibold text-foreground">
            {detail ? `سند انتقال ${detail.transferNumber}` : "سند انتقال"}
          </h2>
          <ErrorBox>{detailError}</ErrorBox>
          {detail ? (
            <div className="mt-3 space-y-3">
              <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                <DetailStat label="تاریخ" value={fmtJalali(detail.transferDate)} />
                <DetailStat label="وضعیت" value={TRANSFER_STATUS_LABELS[detail.status]} />
                <DetailStat label="شعبه" value={detail.locationName ?? "همهٔ شعبه‌ها"} />
                <DetailStat label="از حساب" value={detail.sourceAccountName ?? "—"} />
                <DetailStat label="به حساب" value={detail.destinationAccountName ?? "—"} />
                <DetailStat
                  label={`مبلغ (${money.unitLabel})`}
                  value={money.formatText(detail.amount)}
                />
                {detail.feeAmount !== "0" ? (
                  <DetailStat
                    label="کارمزد"
                    value={`${money.formatText(detail.feeAmount)} — ${TRANSFER_FEE_PAYER_LABELS[detail.feePayer]}`}
                  />
                ) : null}
                {detail.referenceNumber ? (
                  <DetailStat label="شمارهٔ پیگیری" value={detail.referenceNumber} />
                ) : null}
                {detail.projectName ? <DetailStat label="پروژه" value={detail.projectName} /> : null}
                <DetailStat label="ثبت‌کننده" value={detail.createdByName ?? "—"} />
              </dl>
              {detail.description ? <InfoBox>{detail.description}</InfoBox> : null}
              {detail.status === "reversed" && detail.reversalTransferNumber ? (
                <InfoBox>
                  این انتقال با سند {detail.reversalTransferNumber} برگشت خورده است
                  {detail.reversalReason ? ` — دلیل: ${detail.reversalReason}` : ""}
                </InfoBox>
              ) : null}
              {detail.postingMode === "reversal" && detail.reversalReason ? (
                <InfoBox>
                  دلیل برگشت: {detail.reversalReason}
                  {detail.reversesTransferId ? ` — برگشت سند اصلی` : ""}
                </InfoBox>
              ) : null}
              {detail.attachmentAssetId ? (
                <a
                  className="text-sm text-primary underline-offset-4 hover:underline"
                  href={mediaFileUrl(detail.attachmentAssetId)}
                  target="_blank"
                  rel="noreferrer"
                >
                  مشاهدهٔ پیوست
                </a>
              ) : null}

              <div className="flex flex-wrap gap-1.5">
                <SecondaryButton
                  onClick={() =>
                    setPeek({ entryId: detail.journalEntryId, title: `سند انتقال ${detail.transferNumber}` })
                  }
                >
                  مشاهدهٔ سند حسابداری
                </SecondaryButton>
                <SecondaryButton onClick={() => window.print()}>
                  <PrinterIcon className="size-4" aria-hidden="true" />
                  چاپ / PDF
                </SecondaryButton>
              </div>

              <DataCardTable
                columns={[
                  {
                    key: "account",
                    header: "حساب",
                    cell: (line) => `${line.accountCode} — ${line.accountName}`,
                  },
                  {
                    key: "debit",
                    header: `بدهکار (${money.unitLabel})`,
                    align: "end",
                    numeric: true,
                    cell: (line) => (line.debit === "0" ? "—" : money.formatText(line.debit)),
                  },
                  {
                    key: "credit",
                    header: `بستانکار (${money.unitLabel})`,
                    align: "end",
                    numeric: true,
                    cell: (line) => (line.credit === "0" ? "—" : money.formatText(line.credit)),
                  },
                ]}
                rows={detail.journalLines}
                rowKey={(line) => line.accountId}
                caption="سطرهای سند انتقال"
              />
            </div>
          ) : null}
        </OverlayDialog>
      ) : null}

      {reverseTarget ? (
        <OverlayDialog
          headingId="transfer-reverse-heading"
          role="alertdialog"
          dismissible={!saving}
          onClose={() => setReverseTarget(null)}
          className={`${overlayPanelClass} max-h-[88vh] w-full max-w-lg overflow-y-auto p-4 sm:p-5`}
        >
          <h2 id="transfer-reverse-heading" className="text-base font-semibold text-foreground">
            برگشت سند انتقال {reverseTarget.transferNumber}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            برگشت سند، یک سند جدید و آینه‌ای می‌سازد؛ سند اصلی حذف یا ویرایش نمی‌شود و در فهرست
            می‌ماند. این کار اثر انتقال را در همان تاریخ برمی‌گرداند. مطمئن هستید؟
          </p>
          <div className="mt-3 space-y-3">
            <Field label="دلیل برگشت">
              <input
                className={inputClass}
                value={reverseReason}
                maxLength={TRANSFER_REVERSAL_REASON_MAX}
                onChange={(event) => setReverseReason(event.target.value)}
                placeholder="مثلاً: ثبت اشتباه مبلغ"
              />
            </Field>
            <Field label="تاریخ برگشت (اختیاری)" hint="خالی یعنی امروز.">
              <JalaliDatePicker value={reverseDate} onChange={setReverseDate} ariaLabel="تاریخ برگشت" />
            </Field>
          </div>
          <ErrorBox>{reverseError}</ErrorBox>
          <div className="mt-4 flex justify-end gap-2">
            <SecondaryButton onClick={() => setReverseTarget(null)} disabled={saving}>
              انصراف
            </SecondaryButton>
            <PrimaryButton onClick={reverse} disabled={saving || !reverseReason.trim()}>
              <UndoIcon className="size-4" aria-hidden="true" />
              {saving ? "در حال برگشت…" : "برگشت سند"}
            </PrimaryButton>
          </div>
        </OverlayDialog>
      ) : null}

      {peek ? (
        <JournalPeekDialog entryId={peek.entryId} title={peek.title} onClose={() => setPeek(null)} />
      ) : null}
    </div>
  );
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium text-foreground">{value}</dd>
    </div>
  );
}

/** The form's amount text as exact Rial text, in the business's display unit. */
function moneyTextField(input: string, unit: "toman" | "rial"): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return parseToRialText(trimmed, unit);
  } catch {
    return null;
  }
}

function TransferFormDialog({
  form,
  setForm,
  accountOptions,
  accounts,
  feeAccounts,
  projects,
  preview,
  money,
  saving,
  error,
  canBrowseMedia,
  onPickMedia,
  onSubmit,
  onClose,
}: {
  form: TransferForm;
  setForm: (next: TransferForm) => void;
  accountOptions: SelectOption[];
  accounts: FinancialAccountRecord[];
  feeAccounts: ChartAccount[];
  projects: ProjectOption[];
  preview: { problem: string | null; lines: ReturnType<typeof buildTransferLines> } | null;
  money: ReturnType<typeof useMoney>;
  saving: boolean;
  error: string;
  canBrowseMedia?: boolean;
  onPickMedia: () => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const set = <K extends keyof TransferForm>(key: K, value: TransferForm[K]) =>
    setForm({ ...form, [key]: value });
  const source = accounts.find((account) => account.id === form.sourceAccountId) ?? null;
  const destination = accounts.find((account) => account.id === form.destinationAccountId) ?? null;
  const mismatch = source && destination && source.currencyCode !== destination.currencyCode;
  const sameGl = source && destination && source.glAccountId === destination.glAccountId;
  const ready =
    Boolean(form.transferDate) &&
    Boolean(form.sourceAccountId) &&
    Boolean(form.destinationAccountId) &&
    form.sourceAccountId !== form.destinationAccountId &&
    Boolean(moneyTextField(form.amountInput, money.unit)) &&
    !mismatch &&
    !sameGl &&
    (preview ? preview.problem === null : false);

  return (
    <OverlayDialog
      headingId="transfer-form-heading"
      sheet
      dismissible={!saving}
      onClose={onClose}
      className={`${overlayPanelClass} max-h-[92vh] w-full max-w-3xl overflow-y-auto p-4 sm:p-5`}
    >
      <h2 id="transfer-form-heading" className="text-base font-semibold text-foreground">
        انتقال وجه تازه
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        مبلغ را در واحد نمایش کسب‌وکار ({money.unitLabel}) وارد کنید؛ پیش‌نمایش سند، همان سندی است که
        ثبت می‌شود.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="تاریخ انتقال">
          <JalaliDatePicker
            value={form.transferDate}
            onChange={(value) => set("transferDate", value)}
            ariaLabel="تاریخ انتقال"
            clearable={false}
          />
        </Field>
        <Field label="مبلغ">
          <PersianNumberInput
            className={inputClass}
            value={form.amountInput}
            inputMode="numeric"
            onChange={(event) => set("amountInput", event.target.value)}
            placeholder={`مبلغ به ${money.unitLabel}`}
          />
        </Field>
        <Field label="از حساب">
          <SearchableSelect
            value={form.sourceAccountId}
            onChange={(value) => set("sourceAccountId", value)}
            options={accountOptions}
            placeholder="حساب مبدأ"
            ariaLabel="حساب مبدأ"
          />
        </Field>
        <Field label="به حساب">
          <SearchableSelect
            value={form.destinationAccountId}
            onChange={(value) => set("destinationAccountId", value)}
            options={accountOptions}
            placeholder="حساب مقصد"
            ariaLabel="حساب مقصد"
          />
        </Field>
        <Field label="کارمزد (اختیاری)">
          <PersianNumberInput
            className={inputClass}
            value={form.feeInput}
            inputMode="numeric"
            onChange={(event) => set("feeInput", event.target.value)}
            placeholder={`کارمزد به ${money.unitLabel}`}
          />
        </Field>
        <Field label="پرداخت‌کنندهٔ کارمزد">
          <select
            className={inputClass}
            value={form.feePayer}
            onChange={(event) => set("feePayer", isTransferFeePayer(event.target.value) ? event.target.value : "source")}
          >
            {TRANSFER_FEE_PAYERS.map((payer) => (
              <option key={payer} value={payer}>
                {TRANSFER_FEE_PAYER_LABELS[payer]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="حساب هزینهٔ کارمزد" hint="هنگام ثبت کارمزد الزامی است.">
          <select
            className={inputClass}
            value={form.feeAccountId}
            onChange={(event) => set("feeAccountId", event.target.value)}
          >
            <option value="">بدون کارمزد</option>
            {feeAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} — {account.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="شمارهٔ پیگیری (اختیاری)">
          <input
            className={inputClass}
            value={form.referenceNumber}
            maxLength={TRANSFER_REFERENCE_MAX}
            onChange={(event) => set("referenceNumber", event.target.value)}
            dir="ltr"
          />
        </Field>
        {projects.length > 0 ? (
          <Field label="پروژه (اختیاری)">
            <select
              className={inputClass}
              value={form.projectId}
              onChange={(event) => set("projectId", event.target.value)}
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
        <Field label="شرح (اختیاری)">
          <input
            className={inputClass}
            value={form.description}
            maxLength={TRANSFER_DESCRIPTION_MAX}
            onChange={(event) => set("description", event.target.value)}
          />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <SecondaryButton onClick={onPickMedia} disabled={canBrowseMedia === false}>
          {form.attachment ? "تغییر پیوست" : "افزودن پیوست"}
        </SecondaryButton>
        {form.attachment ? (
          <span className="text-xs text-muted-foreground">{form.attachment.fileName}</span>
        ) : (
          <span className="text-xs text-muted-foreground">رسید یا فیش انتقال (اختیاری)</span>
        )}
      </div>

      {mismatch ? (
        <ErrorBox>
          ارز دو حساب یکسان نیست؛ انتقال بین دو ارز با این سند انجام نمی‌شود (تسویهٔ ارزی جداگانه است).
        </ErrorBox>
      ) : null}
      {sameGl ? <ErrorBox>دو حساب به یک سرفصل دفتر کل وصل‌اند؛ انتقال بین آن‌ها بی‌معناست.</ErrorBox> : null}

      {preview && preview.lines ? (
        <div className="mt-3">
          <h3 className="mb-1 text-sm font-medium text-foreground">پیش‌نمایش سند</h3>
          {preview.problem ? (
            <ErrorBox>{financialAccountErrorMessage(preview.problem) ?? errorMessageOrRaw(preview.problem)}</ErrorBox>
          ) : (
            <DataCardTable
              columns={[
                { key: "account", header: "حساب", cell: (line) => line.accountId },
                {
                  key: "debit",
                  header: `بدهکار (${money.unitLabel})`,
                  align: "end",
                  numeric: true,
                  cell: (line) => money.formatText(line.debit),
                },
                {
                  key: "credit",
                  header: `بستانکار (${money.unitLabel})`,
                  align: "end",
                  numeric: true,
                  cell: (line) => money.formatText(line.credit),
                },
              ]}
              rows={preview.lines.lines.map((line, index) => ({ ...line, key: String(index) }))}
              rowKey={(line) => line.key}
              caption="پیش‌نمایش سطرهای سند انتقال"
            />
          )}
        </div>
      ) : null}

      <ErrorBox>{error}</ErrorBox>
      <div className="mt-4 flex justify-end gap-2">
        <SecondaryButton onClick={onClose} disabled={saving}>
          انصراف
        </SecondaryButton>
        <PrimaryButton onClick={onSubmit} disabled={saving || !ready}>
          {saving ? "در حال ثبت…" : "ثبت انتقال"}
        </PrimaryButton>
      </div>
    </OverlayDialog>
  );
}
