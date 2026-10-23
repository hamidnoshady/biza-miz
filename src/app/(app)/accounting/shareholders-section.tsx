"use client";

/**
 * Shareholder Accounting workspace (issue #864).
 *
 * This screen is only a presentation of immutable ownership snapshots,
 * shareholder-attributed ledger facts, and distributions based on a closed
 * fiscal-year close. It never calculates an independent equity balance: cash
 * and equity live in the GL, and the reconciliation panel makes any
 * unattributed balance visible.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRightIcon, DownloadIcon, UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SearchableSelect, type SelectOption } from "@/components/ui/searchable-select";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { DataTable, DataTableBody, DataTableFoot, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { TabBar, TabPanel, type Tab } from "@/app/dashboard/page-chrome";
import { EmptyState, KpiCard, KpiRow, LoadingSkeleton, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, InfoBox, inputClass } from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
import { journalMemoForDisplay } from "@/lib/journal-memo";
import { PARTY_ROLE_LABELS, type PartyRole } from "@/lib/parties";
import { PERMISSIONS } from "@/lib/permissions";
import { formatJalali } from "@/lib/jalali";
import { formatOwnershipPercent, parseOwnershipPercent } from "@/lib/shareholder-accounting";
import type {
  ShareholderAccountStatement,
  ShareholderBalanceRow,
  ShareholderDistributionLinePage,
  ShareholderDistributionLineRow,
  ShareholderDistributionPage,
  ShareholderDistributionRow,
  ShareholderEventPage,
  ShareholderEventRow,
  ShareholderFiscalYearReconciliationRow,
  ShareholderPaymentPage,
  ShareholderPaymentRow,
  ShareholderWorkspace,
} from "@/lib/shareholder-service";
import type { AccountRow } from "./accounting-manager";
import { accountingSectionHref } from "./accounting-routes";

const WORKSPACE_URL = "/api/accounting/shareholders";
const TABS = [
  { key: "ownership", label: "مالکیت و رویدادها" },
  { key: "capital", label: "سرمایه و وام" },
  { key: "distributions", label: "تقسیم سود" },
  { key: "reconciliation", label: "تطبیق با دفتر کل" },
] as const satisfies readonly Tab<string>[];
type TabKey = (typeof TABS)[number]["key"];

type PartyOption = { id: string; name: string; role: string; roles?: string[] };
type ConfirmRequest = {
  title: string;
  description: string;
  confirmLabel: string;
  reasonRequired?: boolean;
  run: (reason: string) => Promise<void>;
};

type OwnershipMode = "event" | "transfer";
type SimpleOwnershipEvent = "shareholder_added" | "ownership_changed" | "shareholder_removed";
type ShareholderHistoryFilters = { dateFrom: string; dateTo: string; partyId: string; category: string; eventType: string };
type ShareholderDistributionFiltersUi = { fiscalYearId: string; status: string };
type ShareholderPaymentFiltersUi = { dateFrom: string; dateTo: string; partyId: string; paymentType: string };

const OWNERSHIP_EVENT_OPTIONS: readonly { value: SimpleOwnershipEvent; label: string }[] = [
  { value: "shareholder_added", label: "افزودن سهام‌دار" },
  { value: "ownership_changed", label: "تغییر درصد مالکیت" },
  { value: "shareholder_removed", label: "خروج کامل از مالکیت" },
];

const CAPITAL_CLASS_OPTIONS: readonly SelectOption[] = [
  { value: "equity", label: "سرمایهٔ سهام‌دار (۳۱۰۰)" },
  { value: "additional_paid_in_capital", label: "صرف سهام / سرمایهٔ پرداخت‌شدهٔ اضافی (۳۱۵۰)" },
  { value: "shareholder_loan", label: "وام پرداختنی به سهام‌دار (۲۵۱۰)" },
];

const DISTRIBUTION_STATUS: Record<string, { label: string; tone: "active" | "positive" | "neutral" | "danger" }> = {
  draft: { label: "پیش‌نویس", tone: "neutral" },
  approved: { label: "تأییدشده", tone: "active" },
  posted: { label: "ثبت‌شده", tone: "positive" },
  partially_paid: { label: "پرداخت بخشی", tone: "active" },
  paid: { label: "تسویه‌شده", tone: "positive" },
  reversed: { label: "برگشت‌خورده", tone: "danger" },
  cancelled: { label: "لغوشده", tone: "neutral" },
};

const EVENT_LABELS: Record<string, string> = {
  shareholder_added: "سهام‌دار افزوده شد",
  ownership_changed: "درصد مالکیت تغییر کرد",
  shareholder_removed: "سهام‌دار خارج شد",
  ownership_transfer_out: "انتقال سهم ـ مبدأ",
  ownership_transfer_in: "انتقال سهم ـ مقصد",
  capital_contribution: "آوردهٔ سرمایه",
  capital_withdrawal: "برداشت / بازپرداخت وام",
  capital_reversal: "برگشت رویداد سرمایه",
};

const ERROR_LABELS: Record<string, string> = {
  permission_required: "مجوز لازم برای این عملیات را ندارید.",
  cloud_authoritative_data: "اطلاعات سهام‌داران در نسخهٔ ابری ثبت می‌شود؛ این عملیات را از فضای ابری انجام دهید.",
  active_party_not_found: "شخص فعال و ثبت‌نشده‌ای با این شناسه پیدا نشد. از فهرست canonical اشخاص انتخاب کنید.",
  invalid_party_id: "شخص انتخاب‌شده معتبر نیست.",
  invalid_ownership_percent: "درصد مالکیت باید بین صفر تا ۱۰۰ و حداکثر با شش رقم اعشار باشد.",
  ownership_add_requires_inactive_shareholder: "این شخص در تاریخ انتخاب‌شده از قبل سهام‌دار است؛ رویداد تغییر مالکیت را انتخاب کنید.",
  ownership_change_requires_active_shareholder: "برای تغییر مالکیت، شخص باید در آن تاریخ سهام‌دار فعال باشد.",
  ownership_remove_requires_active_shareholder: "برای خروج، شخص باید در آن تاریخ مالکیت فعال داشته باشد.",
  ownership_transfer_pair_invalid: "انتقال باید دقیقاً یک رویداد خروج و یک رویداد ورود با شناسهٔ گروه و مبلغ درصد یکسان داشته باشد.",
  ownership_transfer_out_exceeds_current: "درصد انتقال خروج با مالکیت پیشین یا درصد پس از انتقال هم‌خوان نیست.",
  ownership_transfer_in_mismatch: "درصد انتقال ورودی با درصد پس از انتقال هم‌خوان نیست.",
  ownership_transfer_in_invalid: "درصد انتقال ورودی باید با مالکیت پیشین و درصد پس از انتقال سازگار باشد.",
  ownership_total_exceeded: "جمع مالکیت در این تاریخ از ۱۰۰٪ بیشتر می‌شود.",
  ownership_total_exceeds_100: "جمع مالکیت در این تاریخ از ۱۰۰٪ بیشتر می‌شود.",
  ownership_total_must_equal_100: "سیاست کسب‌وکار الزام می‌کند جمع مالکیت دقیقاً ۱۰۰٪ باشد.",
  duplicate_shareholder_event_date: "برای یک سهام‌دار در یک روز فقط یک رویداد مالکیت ثبت می‌شود.",
  ownership_snapshot_invalid: "توالی رویدادها یک snapshot معتبر مالکیت نمی‌سازد.",
  retroactive_permission_required: "ثبت رویداد با تاریخ گذشته به مجوز تغییرات عطف‌به‌ماسبق نیاز دارد.",
  invalid_transfer_percent: "درصد انتقال باید بزرگ‌تر از صفر باشد.",
  invalid_transfer_group: "برای انتقال، هر دو رویداد باید شناسهٔ گروه انتقال یکسان داشته باشند.",
  invalid_payment_account: "حساب پرداخت باید یک حساب فعال ریالی از نوع دارایی باشد.",
  ledger_account_missing: "حساب لازم در سرفصل‌ها یافت نشد؛ کد حساب را بررسی کنید.",
  ledger_account_type_mismatch: "نوع حساب سرفصل با نوع مورد انتظار هم‌خوان نیست.",
  fiscal_year_not_found: "سال مالی پیدا نشد.",
  fiscal_year_not_closed: "تقسیم سود فقط از نتیجهٔ یک سال مالی بسته‌شده ساخته می‌شود.",
  closing_entry_not_found: "سند اختتامیهٔ سال پیدا نشد؛ نتیجه را در بخش دوره‌های مالی بررسی کنید.",
  no_closed_year_profit: "سند اختتامیه برای این سال سود قابل‌تقسیمی ندارد.",
  snapshot_outside_fiscal_year: "تاریخ snapshot باید داخل همان سال مالی انتخاب‌شده باشد.",
  distribution_requires_100_percent_ownership: "برای تخصیص سود، مجموع مالکیت snapshot باید دقیقاً ۱۰۰٪ باشد.",
  distribution_requires_ownership_history: "در تاریخ انتخاب‌شده برای همهٔ مالکان، سابقهٔ مالکیت لازم است.",
  invalid_distributable_profit: "سود قابل‌تقسیم باید بیشتر از صفر و از سود بسته‌شده بیشتر نباشد.",
  invalid_distribution_adjustment: "تعدیل مالیات یا اندوخته نامعتبر است.",
  adjustment_reason_required: "برای هر تعدیل، دلیل مستند وارد کنید.",
  distribution_creator_cannot_approve: "ثبت‌کنندهٔ پیش‌نویس نمی‌تواند همان مورد را تأیید کند.",
  distribution_not_approvable: "این توزیع در وضعیت فعلی قابل تأیید نیست.",
  distribution_not_postable: "این توزیع ابتدا باید تأیید شود.",
  distribution_not_payable: "این توزیع در وضعیت فعلی قابل پرداخت نیست.",
  distribution_not_cancellable: "این توزیع پس از ثبت یا پرداخت قابل لغو نیست؛ از برگشت حسابداری استفاده کنید.",
  distribution_not_reversible: "این توزیع در وضعیت فعلی قابل برگشت نیست.",
  reverse_payments_before_distribution: "ابتدا پرداخت‌های توزیع را با سند برگشت جداگانه خنثی کنید.",
  payment_exceeds_shareholder_outstanding: "مبلغ پرداخت از ماندهٔ قابل‌پرداخت این سهام‌دار بیشتر است.",
  payment_already_reversed: "این پرداخت قبلاً برگشت خورده است.",
  capital_event_already_reversed: "این رویداد سرمایه قبلاً برگشت خورده است.",
  idempotency_key_conflict: "کلید تکرار با اطلاعات درخواست قبلی یکسان نیست؛ فرم را تازه کنید.",
  idempotency_key_required: "کلید یکتای ثبت تولید نشد؛ دوباره تلاش کنید.",
  invalid_request_body: "ساختار درخواست نامعتبر است.",
  network_error: "ارتباط با سرور برقرار نشد؛ اتصال را بررسی و دوباره تلاش کنید.",
  unauthorized: "نشست شما پایان یافته است؛ دوباره وارد شوید.",
  forbidden: "برای این عملیات دسترسی ندارید.",
};

function errorLabel(code: string | undefined): string {
  if (!code) return "خطای غیرمنتظره رخ داد؛ دوباره تلاش کنید.";
  return ERROR_LABELS[code] ?? `عملیات انجام نشد (${code}). اطلاعات را بررسی و دوباره تلاش کنید.`;
}

function dateLabel(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return toPersianDigits(formatJalali(value));
  } catch {
    return toPersianDigits(value);
  }
}

function percentLabel(value: string | null | undefined): string {
  if (value == null) return "—";
  const units = parseOwnershipPercent(value);
  return units === null ? "—" : `${toPersianDigits(formatOwnershipPercent(units))}٪`;
}

function roleLabel(value: string | null | undefined): string {
  if (!value) return "طرف‌حساب";
  const normalized = value.toLowerCase();
  const role = (Object.keys(PARTY_ROLE_LABELS) as PartyRole[]).find(
    (candidate) => candidate.toLowerCase() === normalized,
  );
  return role ? PARTY_ROLE_LABELS[role] : value;
}

function idempotencyKey(prefix: string): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}

function formatBalance(money: ReturnType<typeof useMoney>, amount: string): string {
  try {
    return money.formatText(amount);
  } catch {
    return `${toPersianDigits(amount)} ریال`;
  }
}

function journalHref(entryId: string): string {
  return `${accountingSectionHref("entries")}?entryId=${encodeURIComponent(entryId)}`;
}

function ownershipTotal(register: ShareholderWorkspace["register"]): string {
  const total = register.reduce((sum, row) => sum + (parseOwnershipPercent(row.ownershipPercent) ?? 0n), 0n);
  return formatOwnershipPercent(total);
}

function approvalCanPost(status: string): boolean {
  return status === "approved";
}

export function ShareholdersSection({
  accounts,
  permissions,
  currentUserId,
  refreshKey,
  onRefresh,
}: {
  accounts: AccountRow[];
  permissions: readonly string[];
  currentUserId: string;
  refreshKey: number;
  onRefresh: () => void;
}) {
  const money = useMoney();
  const permissionSet = useMemo(() => new Set(permissions), [permissions]);
  const canManageOwnership = permissionSet.has(PERMISSIONS.shareholdersManage);
  const canRecordCapital = permissionSet.has(PERMISSIONS.shareholdersCapitalPost);
  const canReverseCapital = permissionSet.has(PERMISSIONS.shareholdersCapitalReverse) && permissionSet.has(PERMISSIONS.ledgerApprove);
  const canManageDistributions = permissionSet.has(PERMISSIONS.shareholdersDistributionsManage);
  const canAdjustDistributions = permissionSet.has(PERMISSIONS.shareholdersDistributionsAdjust);
  const canApproveDistributions = permissionSet.has(PERMISSIONS.shareholdersDistributionsApprove);
  const canPostDistributions = permissionSet.has(PERMISSIONS.ledgerPost);
  const canPayDistributions = permissionSet.has(PERMISSIONS.shareholdersDistributionsPay);
  const canReverseDistributions = permissionSet.has(PERMISSIONS.shareholdersDistributionsReverse) && permissionSet.has(PERMISSIONS.ledgerApprove);
  const canEditPolicy = canManageOwnership;
  const canRecordHistoricalOwnership = permissionSet.has(PERMISSIONS.shareholdersRetroactive);

  const [workspace, setWorkspace] = useState<ShareholderWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [asOf, setAsOf] = useState("");
  const [tab, setTab] = useState<TabKey>("ownership");
  const [busy, setBusy] = useState(false);
  const [policyDraft, setPolicyDraft] = useState<"at_most_100" | "exactly_100">("at_most_100");
  const [partyOptions, setPartyOptions] = useState<PartyOption[]>([]);
  const [partySearchBusy, setPartySearchBusy] = useState(false);
  const [selectedDistributionId, setSelectedDistributionId] = useState("");
  const [confirmation, setConfirmation] = useState<ConfirmRequest | null>(null);
  const [confirmationReason, setConfirmationReason] = useState("");

  const [eventFilters, setEventFilters] = useState({ dateFrom: "", dateTo: "", partyId: "", category: "", eventType: "" });
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const [eventCursorHistory, setEventCursorHistory] = useState<Array<string | null>>([]);
  const [eventPage, setEventPage] = useState<ShareholderEventPage | null>(null);
  const [eventLoading, setEventLoading] = useState(false);
  const [eventError, setEventError] = useState("");
  const [eventRetry, setEventRetry] = useState(0);

  const [distributionFilters, setDistributionFilters] = useState({ fiscalYearId: "", status: "all" });
  const [distributionCursor, setDistributionCursor] = useState<string | null>(null);
  const [distributionCursorHistory, setDistributionCursorHistory] = useState<Array<string | null>>([]);
  const [distributionPage, setDistributionPage] = useState<ShareholderDistributionPage | null>(null);
  const [distributionLoading, setDistributionLoading] = useState(false);
  const [distributionError, setDistributionError] = useState("");
  const [distributionRetry, setDistributionRetry] = useState(0);
  const [distributionDetail, setDistributionDetail] = useState<ShareholderDistributionRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailRetry, setDetailRetry] = useState(0);
  const [linePage, setLinePage] = useState<ShareholderDistributionLinePage | null>(null);
  const [lineOffset, setLineOffset] = useState(0);
  const [linePartyId, setLinePartyId] = useState("");
  const [lineLoading, setLineLoading] = useState(false);
  const [lineError, setLineError] = useState("");
  const [lineRetry, setLineRetry] = useState(0);
  const [paymentPage, setPaymentPage] = useState<ShareholderPaymentPage | null>(null);
  const [paymentFilters, setPaymentFilters] = useState({ dateFrom: "", dateTo: "", partyId: "", paymentType: "" });
  const [paymentCursor, setPaymentCursor] = useState<string | null>(null);
  const [paymentCursorHistory, setPaymentCursorHistory] = useState<Array<string | null>>([]);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [paymentError, setPaymentError] = useState("");
  const [paymentRetry, setPaymentRetry] = useState(0);

  const loadWorkspace = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    const params = new URLSearchParams();
    if (asOf) params.set("asOf", asOf);
    const query = params.toString();
    const url = query ? `${WORKSPACE_URL}?${query}` : WORKSPACE_URL;
    const { ok, data, aborted } = await api<ShareholderWorkspace & { error?: string }>(url, { signal });
    if (aborted) return;
    if (!ok) {
      setError(errorLabel(data.error));
      setWorkspace(null);
      setLoading(false);
      return;
    }
    setError("");
    setWorkspace(data);
    setPolicyDraft(data.totalPolicy);
    if (!asOf) setAsOf(data.asOf);
    setLoading(false);
  }, [asOf]);

  useEffect(() => {
    const controller = new AbortController();
    void loadWorkspace(controller.signal);
    return () => controller.abort();
  }, [loadWorkspace, refreshKey]);

  const effectiveEventCategory = tab === "capital" ? "capital" : eventFilters.category;
  useEffect(() => {
    const capitalTypes = new Set(["capital_contribution", "capital_withdrawal", "capital_reversal"]);
    if (tab === "capital" && eventFilters.eventType && !capitalTypes.has(eventFilters.eventType)) {
      setEventFilters((current) => ({ ...current, eventType: "" }));
      setEventCursor(null);
      setEventCursorHistory([]);
    }
  }, [tab, eventFilters.eventType]);
  const eventRequestUrl = useMemo(() => {
    const params = new URLSearchParams({ limit: "50" });
    if (eventFilters.dateFrom) params.set("dateFrom", eventFilters.dateFrom);
    if (eventFilters.dateTo) params.set("dateTo", eventFilters.dateTo);
    if (eventFilters.partyId) params.set("partyId", eventFilters.partyId);
    if (effectiveEventCategory) params.set("category", effectiveEventCategory);
    if (eventFilters.eventType) params.set("eventType", eventFilters.eventType);
    if (eventCursor) params.set("cursor", eventCursor);
    return `${WORKSPACE_URL}/events?${params.toString()}`;
  }, [effectiveEventCategory, eventCursor, eventFilters.dateFrom, eventFilters.dateTo, eventFilters.eventType, eventFilters.partyId]);

  useEffect(() => {
    const controller = new AbortController();
    setEventLoading(true);
    setEventError("");
    void api<ShareholderEventPage & { error?: string }>(eventRequestUrl, { signal: controller.signal }).then(({ ok, data, aborted }) => {
      if (aborted) return;
      if (!ok) {
        setEventError(errorLabel(data.error));
        setEventPage(null);
      } else setEventPage(data);
      setEventLoading(false);
    });
    return () => controller.abort();
  }, [eventRequestUrl, eventRetry, refreshKey]);

  const distributionRequestUrl = useMemo(() => {
    const params = new URLSearchParams({ limit: "25" });
    if (distributionFilters.fiscalYearId) params.set("fiscalYearId", distributionFilters.fiscalYearId);
    if (distributionFilters.status !== "all") params.set("status", distributionFilters.status);
    if (distributionCursor) params.set("cursor", distributionCursor);
    return `${WORKSPACE_URL}/distributions?${params.toString()}`;
  }, [distributionCursor, distributionFilters.fiscalYearId, distributionFilters.status]);

  useEffect(() => {
    const controller = new AbortController();
    setDistributionLoading(true);
    setDistributionError("");
    void api<ShareholderDistributionPage & { error?: string }>(distributionRequestUrl, { signal: controller.signal }).then(({ ok, data, aborted }) => {
      if (aborted) return;
      if (!ok) {
        setDistributionError(errorLabel(data.error));
        setDistributionPage(null);
      } else setDistributionPage(data);
      setDistributionLoading(false);
    });
    return () => controller.abort();
  }, [distributionRequestUrl, distributionRetry, refreshKey]);

  useEffect(() => {
    if (!selectedDistributionId && distributionPage?.distributions[0]) {
      setSelectedDistributionId(distributionPage.distributions[0].id);
    }
  }, [distributionPage, selectedDistributionId]);

  useEffect(() => {
    if (!selectedDistributionId) {
      setDistributionDetail(null);
      setDetailError("");
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError("");
    void api<ShareholderDistributionRow & { error?: string }>(`${WORKSPACE_URL}/distributions/${encodeURIComponent(selectedDistributionId)}`, { signal: controller.signal }).then(({ ok, data, aborted }) => {
      if (aborted) return;
      if (!ok) {
        setDetailError(errorLabel(data.error));
        setDistributionDetail(null);
      } else setDistributionDetail(data);
      setDetailLoading(false);
    });
    return () => controller.abort();
  }, [selectedDistributionId, detailRetry, refreshKey]);

  useEffect(() => {
    if (!selectedDistributionId) {
      setLinePage(null);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: "25", offset: String(lineOffset) });
    if (linePartyId) params.set("partyId", linePartyId);
    setLineLoading(true);
    setLineError("");
    void api<ShareholderDistributionLinePage & { error?: string }>(`${WORKSPACE_URL}/distributions/${encodeURIComponent(selectedDistributionId)}/lines?${params.toString()}`, { signal: controller.signal }).then(({ ok, data, aborted }) => {
      if (aborted) return;
      if (!ok) {
        setLineError(errorLabel(data.error));
        setLinePage(null);
      } else setLinePage(data);
      setLineLoading(false);
    });
    return () => controller.abort();
  }, [selectedDistributionId, lineOffset, linePartyId, lineRetry, refreshKey]);

  const paymentRequestUrl = useMemo(() => {
    const params = new URLSearchParams({ limit: "25" });
    if (selectedDistributionId) params.set("distributionId", selectedDistributionId);
    if (paymentFilters.dateFrom) params.set("dateFrom", paymentFilters.dateFrom);
    if (paymentFilters.dateTo) params.set("dateTo", paymentFilters.dateTo);
    if (paymentFilters.partyId) params.set("partyId", paymentFilters.partyId);
    if (paymentFilters.paymentType) params.set("paymentType", paymentFilters.paymentType);
    if (paymentCursor) params.set("cursor", paymentCursor);
    return `${WORKSPACE_URL}/distributions/payments?${params.toString()}`;
  }, [paymentCursor, paymentFilters.dateFrom, paymentFilters.dateTo, paymentFilters.partyId, paymentFilters.paymentType, selectedDistributionId]);

  useEffect(() => {
    if (!selectedDistributionId) {
      setPaymentPage(null);
      return;
    }
    const controller = new AbortController();
    setPaymentLoading(true);
    setPaymentError("");
    void api<ShareholderPaymentPage & { error?: string }>(paymentRequestUrl, { signal: controller.signal }).then(({ ok, data, aborted }) => {
      if (aborted) return;
      if (!ok) {
        setPaymentError(errorLabel(data.error));
        setPaymentPage(null);
      } else setPaymentPage(data);
      setPaymentLoading(false);
    });
    return () => controller.abort();
  }, [paymentRequestUrl, paymentRetry, refreshKey, selectedDistributionId]);

  const loadPartyOptions = useCallback(async (query: string) => {
    setPartySearchBusy(true);
    const params = new URLSearchParams({ limit: "100" });
    if (query.trim()) params.set("q", query.trim());
    const { ok, data } = await api<{ parties: PartyOption[]; error?: string }>(`/api/parties?${params.toString()}`);
    if (ok) setPartyOptions(data.parties ?? []);
    setPartySearchBusy(false);
  }, []);

  useEffect(() => {
    void loadPartyOptions("");
  }, [loadPartyOptions]);

  const assetAccounts = useMemo(
    () => accounts.filter((account) => account.type === "asset" && account.currency_code == null && account.is_postable !== false),
    [accounts],
  );
  const assetAccountOptions = useMemo<SelectOption[]>(
    () => assetAccounts.map((account) => ({ value: account.id, label: `${account.code} — ${account.name}` })),
    [assetAccounts],
  );
  const registeredPartyOptions = useMemo<PartyOption[]>(() => {
    if (!workspace) return partyOptions;
    const union = new Map<string, PartyOption>();
    for (const party of partyOptions) union.set(party.id, party);
    for (const row of workspace.register) {
      if (!union.has(row.partyId)) union.set(row.partyId, { id: row.partyId, name: row.partyName, role: row.partyRole ?? "" });
    }
    return [...union.values()];
  }, [partyOptions, workspace]);
  const shareholderOptions = useMemo<SelectOption[]>(
    () => (workspace?.register ?? []).map((row) => ({
      value: row.partyId,
      label: `${row.partyName} — ${percentLabel(row.ownershipPercent)}`,
      searchString: `${row.partyName} ${row.partyRole ?? ""}`,
    })),
    [workspace],
  );
  const partySelectOptions = useMemo<SelectOption[]>(
    () => registeredPartyOptions.map((party) => ({
      value: party.id,
      label: `${party.name} — ${roleLabel(party.role)}`,
      searchString: `${party.name} ${party.role} ${(party.roles ?? []).join(" ")}`,
    })),
    [registeredPartyOptions],
  );

  async function mutate<T extends Record<string, unknown>>(
    path: string,
    method: "POST" | "PUT",
    body?: Record<string, unknown>,
    successMessage = "تغییر با موفقیت ثبت شد.",
  ): Promise<T | null> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { ok, data } = await api<T & { error?: string }>(path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!ok) {
        setError(errorLabel(data.error));
        return null;
      }
      setNotice(successMessage);
      onRefresh();
      return data;
    } catch {
      setError(errorLabel("network_error"));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function submitPolicy() {
    if (!workspace || policyDraft === workspace.totalPolicy) return;
    await mutate(`${WORKSPACE_URL}/policy`, "PUT", { totalPolicy: policyDraft }, "سیاست جمع مالکیت به‌روز شد.");
  }

  function updateEventFilters(patch: Partial<typeof eventFilters>) {
    setEventFilters((current) => ({ ...current, ...patch }));
    setEventCursor(null);
    setEventCursorHistory([]);
  }

  function updateDistributionFilters(patch: Partial<typeof distributionFilters>) {
    setDistributionFilters((current) => ({ ...current, ...patch }));
    setDistributionCursor(null);
    setDistributionCursorHistory([]);
  }

  function nextEventPage() {
    if (!eventPage?.nextCursor) return;
    setEventCursorHistory((current) => [...current, eventCursor]);
    setEventCursor(eventPage.nextCursor);
  }

  function previousEventPage() {
    if (eventCursorHistory.length === 0) return;
    setEventCursor(eventCursorHistory.at(-1) ?? null);
    setEventCursorHistory((current) => current.slice(0, -1));
  }

  function nextDistributionPage() {
    if (!distributionPage?.nextCursor) return;
    setDistributionCursorHistory((current) => [...current, distributionCursor]);
    setDistributionCursor(distributionPage.nextCursor);
  }

  function previousDistributionPage() {
    if (distributionCursorHistory.length === 0) return;
    setDistributionCursor(distributionCursorHistory.at(-1) ?? null);
    setDistributionCursorHistory((current) => current.slice(0, -1));
  }

  function nextPaymentPage() {
    if (!paymentPage?.nextCursor) return;
    setPaymentCursorHistory((current) => [...current, paymentCursor]);
    setPaymentCursor(paymentPage.nextCursor);
  }

  function previousPaymentPage() {
    if (paymentCursorHistory.length === 0) return;
    setPaymentCursor(paymentCursorHistory.at(-1) ?? null);
    setPaymentCursorHistory((current) => current.slice(0, -1));
  }

  function updatePaymentFilters(patch: Partial<ShareholderPaymentFiltersUi>) {
    setPaymentFilters((current) => ({ ...current, ...patch }));
    setPaymentCursor(null);
    setPaymentCursorHistory([]);
  }

  function selectDistribution(id: string) {
    setSelectedDistributionId(id);
    setLineOffset(0);
    setLinePartyId("");
    setPaymentCursor(null);
    setPaymentCursorHistory([]);
  }

  const eventExportUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (eventFilters.dateFrom) params.set("dateFrom", eventFilters.dateFrom);
    if (eventFilters.dateTo) params.set("dateTo", eventFilters.dateTo);
    if (eventFilters.partyId) params.set("partyId", eventFilters.partyId);
    if (effectiveEventCategory) params.set("category", effectiveEventCategory);
    if (eventFilters.eventType) params.set("eventType", eventFilters.eventType);
    const query = params.toString();
    return `${WORKSPACE_URL}/events/export${query ? `?${query}` : ""}`;
  }, [effectiveEventCategory, eventFilters.dateFrom, eventFilters.dateTo, eventFilters.eventType, eventFilters.partyId]);

  const register = workspace?.register ?? [];
  const activeOwners = register.filter((row) => row.active);
  const ownershipPercentTotal = workspace ? ownershipTotal(register) : "0";
  const selectedDistribution = distributionDetail;
  const distributionLines = linePage?.lines ?? [];
  const totalUndistributedRetained = workspace?.fiscalYearReconciliation.reduce(
    (sum, year) => sum + BigInt(year.undistributedRetainedProfitRial), 0n,
  ).toString() ?? "0";
  const totalUnpaidAllocated = workspace?.distributionSummary.outstandingRial ?? "0";

  if (loading && !workspace) return <SectionCardSkeleton rows={6} />;
  if (!workspace) {
    return (
      <div className="space-y-3">
        <ErrorBox>{error}</ErrorBox>
        <Button variant="outline" onClick={() => void loadWorkspace()}>تلاش دوباره</Button>
      </div>
    );
  }

  const tabs = TABS;

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>
      <InfoBox>{notice}</InfoBox>

      <KpiRow>
        <KpiCard label="سهام‌داران فعال در تاریخ انتخابی" value={toPersianDigits(String(activeOwners.length))} hint={`مجموع مالکیت ${percentLabel(ownershipPercentTotal)}`} icon={UsersIcon} />
        <KpiCard label="سیاست مالکیت" value={workspace.totalPolicy === "exactly_100" ? "دقیقاً ۱۰۰٪" : "حداکثر ۱۰۰٪"} hint={`نمای مالکیت تا ${dateLabel(workspace.asOf)}`} />
        <KpiCard label="سود نگه‌داشته‌شدهٔ تقسیم‌نشده" value={formatBalance(money, totalUndistributedRetained)} hint="نتیجهٔ بسته‌شده منهای تخصیص واقعی ثبت‌شده در GL" />
        <KpiCard label="تخصیص پرداخت‌نشده" value={formatBalance(money, totalUnpaidAllocated)} hint="بدهی سود سهام‌داران پس از کسر پرداخت‌های ثبت‌شده" />
        <KpiCard label="حساب‌های قابل تطبیق" value={toPersianDigits(String(workspace.glReconciliation.length))} hint={workspace.glReconciliation.every((row) => row.unattributedBalanceRial === "0") ? "مانده‌ها به اشخاص منتسب‌اند" : "برخی مانده‌ها نیازمند بررسی‌اند"} />
      </KpiRow>

      <TabBar<TabKey> idPrefix="shareholder-accounting" label="بخش‌های سهام‌داران" tabs={tabs} active={tab} onChange={setTab} />
      <TabPanel<TabKey> idPrefix="shareholder-accounting" active={tab}>
        {tab === "ownership" ? (
          <OwnershipPanel
            workspace={workspace}
            register={register}
            snapshotDate={asOf || workspace.asOf}
            onSnapshotDateChange={setAsOf}
            permissions={{ manage: canManageOwnership, retroactive: canRecordHistoricalOwnership, editPolicy: canEditPolicy }}
            policyDraft={policyDraft}
            setPolicyDraft={setPolicyDraft}
            onSavePolicy={() => void submitPolicy()}
            busy={busy}
            money={money}
            canReverseCapital={canReverseCapital}
            partyOptions={partySelectOptions}
            partiesLoading={partySearchBusy}
            searchParties={(query) => void loadPartyOptions(query)}
            events={eventPage?.events ?? []}
            eventPage={eventPage}
            historyFilters={eventFilters}
            historyLoading={eventLoading}
            historyError={eventError}
            eventExportUrl={eventExportUrl}
            onHistoryFilterChange={updateEventFilters}
            onPreviousEventPage={previousEventPage}
            onNextEventPage={nextEventPage}
            canPreviousEventPage={eventCursorHistory.length > 0}
            onRetryEvents={() => setEventRetry((current) => current + 1)}
            onReverseCapital={(event) => setConfirmation({
              title: "برگشت رویداد سرمایه؟",
              description: "برگشت، سند آینهٔ جدید می‌سازد و سند ثبت‌شده را حذف یا ویرایش نمی‌کند.",
              confirmLabel: "ثبت سند برگشت",
              run: async () => {
                await mutate(`${WORKSPACE_URL}/capital/${event.id}/reverse`, "POST", { idempotencyKey: idempotencyKey("shareholder-capital-reversal") }, "برگشت رویداد سرمایه با سند آینه ثبت شد.");
              },
            })}
            onSubmit={async (events, key) => {
              const result = await mutate<{ eventIds: string[]; replayed: boolean }>(`${WORKSPACE_URL}/ownership`, "POST", { events, idempotencyKey: key }, "رویداد مالکیت به‌صورت تغییرناپذیر ثبت شد.");
              return Boolean(result);
            }}
          />
        ) : null}
        {tab === "capital" ? (
          <CapitalPanel
            workspace={workspace}
            accounts={assetAccountOptions}
            permissions={{ record: canRecordCapital, reverse: canReverseCapital }}
            busy={busy}
            parties={shareholderOptions}
            events={eventPage?.events ?? []}
            eventPage={eventPage}
            historyFilters={eventFilters}
            historyLoading={eventLoading}
            historyError={eventError}
            eventExportUrl={eventExportUrl}
            historyPartyOptions={partySelectOptions}
            historyPartiesLoading={partySearchBusy}
            searchHistoryParties={(query) => void loadPartyOptions(query)}
            onHistoryFilterChange={updateEventFilters}
            onPreviousEventPage={previousEventPage}
            onNextEventPage={nextEventPage}
            canPreviousEventPage={eventCursorHistory.length > 0}
            onRetryEvents={() => setEventRetry((current) => current + 1)}
            onRecord={async (body) => Boolean(await mutate(`${WORKSPACE_URL}/capital`, "POST", body, "رویداد سرمایه و سند حسابداری ثبت شد."))}
            onReverse={(event) => setConfirmation({
              title: "برگشت رویداد سرمایه؟",
              description: "برگشت، سند آینهٔ جدید می‌سازد و سند ثبت‌شده را حذف یا ویرایش نمی‌کند.",
              confirmLabel: "ثبت سند برگشت",
              run: async () => {
                await mutate(`${WORKSPACE_URL}/capital/${event.id}/reverse`, "POST", { idempotencyKey: idempotencyKey("shareholder-capital-reversal") }, "برگشت رویداد سرمایه با سند آینه ثبت شد.");
              },
            })}
            money={money}
          />
        ) : null}
        {tab === "distributions" ? (
          <DistributionPanel
            workspace={workspace}
            distributions={distributionPage?.distributions ?? []}
            distributionPage={distributionPage}
            distributionLoading={distributionLoading}
            distributionError={distributionError}
            distributionFilters={distributionFilters}
            onDistributionFilterChange={updateDistributionFilters}
            onPreviousDistributionPage={previousDistributionPage}
            onNextDistributionPage={nextDistributionPage}
            canPreviousDistributionPage={distributionCursorHistory.length > 0}
            onRetryDistributions={() => setDistributionRetry((current) => current + 1)}
            selected={selectedDistribution}
            selectedId={selectedDistributionId}
            onSelect={selectDistribution}
            detailLoading={detailLoading}
            detailError={detailError}
            onRetryDetail={() => setDetailRetry((current) => current + 1)}
            lines={distributionLines}
            linePage={linePage}
            lineLoading={lineLoading}
            lineError={lineError}
            lineOffset={lineOffset}
            onLineOffsetChange={setLineOffset}
            linePartyId={linePartyId}
            onLinePartyChange={(partyId) => { setLinePartyId(partyId); setLineOffset(0); }}
            onRetryLines={() => setLineRetry((current) => current + 1)}
            payments={paymentPage?.payments ?? []}
            paymentPage={paymentPage}
            paymentFilters={paymentFilters}
            onPaymentFilterChange={updatePaymentFilters}
            paymentPartyOptions={partySelectOptions}
            paymentPartySearchBusy={partySearchBusy}
            searchPaymentParties={(query) => void loadPartyOptions(query)}
            paymentLoading={paymentLoading}
            paymentError={paymentError}
            onPreviousPaymentPage={previousPaymentPage}
            onNextPaymentPage={nextPaymentPage}
            canPreviousPaymentPage={paymentCursorHistory.length > 0}
            onRetryPayments={() => setPaymentRetry((current) => current + 1)}
            accountOptions={assetAccountOptions}
            permissions={{
              manage: canManageDistributions,
              adjust: canAdjustDistributions,
              approve: canApproveDistributions,
              post: canPostDistributions,
              pay: canPayDistributions,
              reverse: canReverseDistributions,
            }}
            currentUserId={currentUserId}
            busy={busy}
            money={money}
            onCreate={async (body) => {
              const result = await mutate<{ distribution: ShareholderDistributionRow }>(`${WORKSPACE_URL}/distributions`, "POST", body, "پیش‌نویس تقسیم سود با snapshot مالکیت ساخته شد.");
              if (result?.distribution?.id) selectDistribution(result.distribution.id);
              return Boolean(result);
            }}
            onAction={mutate}
            onConfirm={setConfirmation}
          />
        ) : null}
        {tab === "reconciliation" ? (
          <ReconciliationPanel workspace={workspace} money={money} />
        ) : null}
      </TabPanel>

      <Dialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmation(null);
            setConfirmationReason("");
          }
        }}
      >
        {confirmation ? (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{confirmation.title}</DialogTitle>
              <DialogDescription>{confirmation.description}</DialogDescription>
            </DialogHeader>
            {confirmation.reasonRequired ? (
              <Field label="دلیل مستند لغو" hint="این دلیل در سابقهٔ حسابرسی ثبت می‌شود.">
                <textarea className={`${inputClass} min-h-24 py-2`} value={confirmationReason} onChange={(event) => setConfirmationReason(event.target.value)} maxLength={500} required />
              </Field>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmation(null)}>انصراف</Button>
              <Button
                variant={confirmation.reasonRequired ? "destructive" : "default"}
                disabled={busy || (confirmation.reasonRequired ? !confirmationReason.trim() : false)}
                onClick={async () => {
                  const action = confirmation;
                  if (!action) return;
                  await action.run(confirmationReason.trim());
                  setConfirmation(null);
                  setConfirmationReason("");
                }}
              >
                {confirmation.confirmLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

function OwnershipPanel({
  workspace,
  register,
  snapshotDate,
  onSnapshotDateChange,
  permissions,
  policyDraft,
  setPolicyDraft,
  onSavePolicy,
  busy,
  money,
  canReverseCapital,
  partyOptions,
  partiesLoading,
  searchParties,
  events,
  eventPage,
  historyFilters,
  historyLoading,
  historyError,
  eventExportUrl,
  onHistoryFilterChange,
  onPreviousEventPage,
  onNextEventPage,
  canPreviousEventPage,
  onRetryEvents,
  onReverseCapital,
  onSubmit,
}: {
  workspace: ShareholderWorkspace;
  register: ShareholderWorkspace["register"];
  snapshotDate: string;
  onSnapshotDateChange: (value: string) => void;
  permissions: { manage: boolean; retroactive: boolean; editPolicy: boolean };
  policyDraft: "at_most_100" | "exactly_100";
  setPolicyDraft: (value: "at_most_100" | "exactly_100") => void;
  onSavePolicy: () => void;
  busy: boolean;
  money: ReturnType<typeof useMoney>;
  canReverseCapital: boolean;
  partyOptions: SelectOption[];
  partiesLoading: boolean;
  searchParties: (query: string) => void;
  events: ShareholderEventRow[];
  eventPage: ShareholderEventPage | null;
  historyFilters: ShareholderHistoryFilters;
  historyLoading: boolean;
  historyError: string;
  eventExportUrl: string;
  onHistoryFilterChange: (patch: Partial<ShareholderHistoryFilters>) => void;
  onPreviousEventPage: () => void;
  onNextEventPage: () => void;
  canPreviousEventPage: boolean;
  onRetryEvents: () => void;
  onReverseCapital: (event: ShareholderEventRow) => void;
  onSubmit: (events: Record<string, unknown>[], key: string) => Promise<boolean>;
}) {
  const asOf = snapshotDate;
  const [mode, setMode] = useState<OwnershipMode>("event");
  const [eventType, setEventType] = useState<SimpleOwnershipEvent>("shareholder_added");
  const [partyId, setPartyId] = useState("");
  const [transferFromPartyId, setTransferFromPartyId] = useState("");
  const [transferToPartyId, setTransferToPartyId] = useState("");
  const [ownershipPercent, setOwnershipPercent] = useState("");
  const [transferPercent, setTransferPercent] = useState("");
  const [transferFromAfter, setTransferFromAfter] = useState("");
  const [transferToAfter, setTransferToAfter] = useState("");
  const [shareUnits, setShareUnits] = useState("");
  const [reason, setReason] = useState("");
  const [sourceReference, setSourceReference] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState("");
  const past = Boolean(asOf && asOf < workspace.today);

  const afterPercent = eventType === "shareholder_removed" ? "0" : ownershipPercent;
  const isOnboarded = register.some((row) => row.partyId === partyId);

  async function submitOwnership(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    if (!permissions.manage) return;
    if (past && !permissions.retroactive) {
      setFormError("برای تاریخ گذشته، مجوز shareholders.retroactive لازم است.");
      return;
    }
    if (!reason.trim()) {
      setFormError("برای رویداد مالکیت، دلیل ثبت الزامی است.");
      return;
    }
    let events: Record<string, unknown>[];
    if (mode === "event") {
      if (!partyId) {
        setFormError("یک شخص از فهرست canonical اشخاص انتخاب کنید.");
        return;
      }
      if (eventType === "shareholder_added" && isOnboarded && register.find((row) => row.partyId === partyId)?.active) {
        setFormError("این شخص در تاریخ نمایشی از قبل سهام‌دار فعال است؛ تاریخ مؤثر یا نوع رویداد را بررسی کنید.");
        return;
      }
      if (eventType !== "shareholder_removed" && !ownershipPercent.trim()) {
        setFormError("درصد مالکیت پس از رویداد را وارد کنید.");
        return;
      }
      events = [{
        partyId,
        eventType,
        effectiveOn: asOf,
        ownershipPercent: afterPercent,
        shareUnits: eventType === "shareholder_removed" ? null : shareUnits || null,
        reason: reason.trim(),
        sourceReference: sourceReference.trim() || null,
        notes: notes.trim() || null,
      }];
    } else {
      if (!transferFromPartyId || !transferToPartyId || transferFromPartyId === transferToPartyId) {
        setFormError("سهام‌دار مبدأ و مقصد متفاوت انتخاب کنید.");
        return;
      }
      if (!transferPercent.trim() || !transferFromAfter.trim() || !transferToAfter.trim()) {
        setFormError("درصد انتقال و درصد مالکیت پس از انتقال برای هر دو طرف لازم است.");
        return;
      }
      const transferGroupId = globalThis.crypto.randomUUID();
      const shared = {
        effectiveOn: asOf,
        transferPercent,
        transferGroupId,
        reason: reason.trim(),
        sourceReference: sourceReference.trim() || null,
        notes: notes.trim() || null,
      };
      events = [
        { ...shared, partyId: transferFromPartyId, eventType: "ownership_transfer_out", ownershipPercent: transferFromAfter, shareUnits: null },
        { ...shared, partyId: transferToPartyId, eventType: "ownership_transfer_in", ownershipPercent: transferToAfter, shareUnits: null },
      ];
    }
    const ok = await onSubmit(events, idempotencyKey("shareholder-ownership"));
    if (ok) {
      setPartyId("");
      setTransferFromPartyId("");
      setTransferToPartyId("");
      setOwnershipPercent("");
      setTransferPercent("");
      setTransferFromAfter("");
      setTransferToAfter("");
      setShareUnits("");
      setReason("");
      setSourceReference("");
      setNotes("");
    }
  }

  const registerTotal = register.reduce((sum, row) => sum + (parseOwnershipPercent(row.ownershipPercent) ?? 0n), 0n);

  return (
    <div className="space-y-4">
      <SectionCard
        title="ثبت و سیاست مالکیت"
        description="هویت هر سهام‌دار از فهرست canonical اشخاص انتخاب می‌شود؛ تغییرات قبلی و درصدهای مؤثر بازنویسی نمی‌شوند."
        actions={
          <Link className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted" href={accountingSectionHref("directory")}>
            فهرست اشخاص <ArrowUpRightIcon className="size-4" aria-hidden="true" />
          </Link>
        }
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="rounded-xl border border-border/80 p-4">
            <h3 className="font-semibold">سیاست جمع مالکیت</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">«حداکثر ۱۰۰٪» برای مرحلهٔ راه‌اندازی یا مالکیت ناقص؛ «دقیقاً ۱۰۰٪» وقتی کل سهام باید تخصیص یافته باشد.</p>
            <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <select className={inputClass} value={policyDraft} disabled={!permissions.editPolicy || busy} onChange={(event) => setPolicyDraft(event.target.value as typeof policyDraft)} aria-label="سیاست جمع مالکیت">
                <option value="at_most_100">حداکثر ۱۰۰٪</option>
                <option value="exactly_100">دقیقاً ۱۰۰٪</option>
              </select>
              <Button variant="outline" disabled={!permissions.editPolicy || busy || policyDraft === workspace.totalPolicy} onClick={onSavePolicy}>ذخیرهٔ سیاست</Button>
            </div>
          </div>
          <div className="rounded-xl border border-border/80 p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h3 className="font-semibold">نمای مالکیت بر اساس تاریخ</h3>
                <p className="mt-1 text-xs text-muted-foreground">جمع snapshot: {percentLabel(formatOwnershipPercent(registerTotal))}</p>
              </div>
              <div className="w-full sm:w-56">
                <JalaliDatePicker value={asOf} onChange={onSnapshotDateChange} ariaLabel="تاریخ مؤثر snapshot مالکیت" />
              </div>
            </div>
          </div>
        </div>

        {!permissions.manage ? <p className="mt-4 rounded-xl bg-muted/60 p-3 text-sm text-muted-foreground">دسترسی شما فقط خواندنی است؛ برای ثبت تاریخچهٔ مالکیت به shareholders.manage نیاز است.</p> : null}
        <form className="mt-4 space-y-3 rounded-xl border border-border/80 p-4" onSubmit={(event) => void submitOwnership(event)}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">رویداد مؤثر مالکیت</h3>
            <div className="flex gap-2" role="group" aria-label="نوع تغییر مالکیت">
              <Button type="button" size="sm" variant={mode === "event" ? "default" : "outline"} disabled={!permissions.manage || busy} onClick={() => setMode("event")}>ثبت یا تغییر</Button>
              <Button type="button" size="sm" variant={mode === "transfer" ? "default" : "outline"} disabled={!permissions.manage || busy} onClick={() => setMode("transfer")}>انتقال جفت‌شده</Button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Field label="تاریخ مؤثر" hint={past && !permissions.retroactive ? "تاریخ گذشته نیازمند مجوز عطف‌به‌ماسبق است." : undefined}>
              <JalaliDatePicker value={asOf} onChange={onSnapshotDateChange} ariaLabel="تاریخ مؤثر رویداد مالکیت" />
            </Field>
            {mode === "event" ? (
              <>
                <Field label="رویداد">
                  <select className={inputClass} value={eventType} onChange={(event) => setEventType(event.target.value as SimpleOwnershipEvent)} disabled={!permissions.manage || busy}>
                    {OWNERSHIP_EVENT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </Field>
                <Field label="شخص (از اشخاص)" hint="اشخاص ادغام‌شده یا غیرفعال در جست‌وجو نمایش داده نمی‌شوند.">
                  <SearchableSelect value={partyId} onChange={setPartyId} options={partyOptions} loading={partiesLoading} onQueryChange={searchParties} placeholder="انتخاب شخص…" searchPlaceholder="نام یا مشخصات را جست‌وجو کنید" ariaLabel="انتخاب شخص از فهرست canonical اشخاص" disabled={!permissions.manage || busy} />
                </Field>
                <Field label={eventType === "shareholder_removed" ? "مالکیت پس از رویداد" : "مالکیت پس از رویداد (٪)"}>
                  <PersianNumberInput value={eventType === "shareholder_removed" ? "0" : ownershipPercent} onChange={(event) => setOwnershipPercent(event.target.value)} allowDecimal grouping={false} step="0.000001" disabled={!permissions.manage || busy || eventType === "shareholder_removed"} placeholder="مثلاً ۲۵٫۵" aria-label="درصد مالکیت پس از رویداد" />
                </Field>
              </>
            ) : (
              <>
                <Field label="سهام‌دار مبدأ"><SearchableSelect value={transferFromPartyId} onChange={setTransferFromPartyId} options={shareholderOptionsForTransfer(register)} placeholder="انتخاب مبدأ…" ariaLabel="سهام‌دار مبدأ انتقال" disabled={!permissions.manage || busy} /></Field>
                <Field label="سهام‌دار مقصد"><SearchableSelect value={transferToPartyId} onChange={setTransferToPartyId} options={partyOptions} loading={partiesLoading} onQueryChange={searchParties} placeholder="انتخاب مقصد…" searchPlaceholder="جست‌وجوی شخص مقصد" ariaLabel="سهام‌دار مقصد انتقال" disabled={!permissions.manage || busy} /></Field>
                <Field label="درصد انتقال (٪)"><PersianNumberInput value={transferPercent} onChange={(event) => setTransferPercent(event.target.value)} allowDecimal grouping={false} step="0.000001" disabled={!permissions.manage || busy} placeholder="مقدار انتقال" /></Field>
                <Field label="مالکیت مبدأ پس از انتقال (٪)"><PersianNumberInput value={transferFromAfter} onChange={(event) => setTransferFromAfter(event.target.value)} allowDecimal grouping={false} step="0.000001" disabled={!permissions.manage || busy} /></Field>
                <Field label="مالکیت مقصد پس از انتقال (٪)"><PersianNumberInput value={transferToAfter} onChange={(event) => setTransferToAfter(event.target.value)} allowDecimal grouping={false} step="0.000001" disabled={!permissions.manage || busy} /></Field>
              </>
            )}
            {mode === "event" ? <Field label="تعداد سهم (اختیاری)"><PersianNumberInput value={shareUnits} onChange={(event) => setShareUnits(event.target.value)} allowDecimal grouping={false} step="0.000001" disabled={!permissions.manage || busy} /></Field> : null}
            <Field label="شمارهٔ مصوبه / مرجع (اختیاری)"><input className={inputClass} value={sourceReference} onChange={(event) => setSourceReference(event.target.value)} maxLength={120} disabled={!permissions.manage || busy} /></Field>
            <Field label="دلیل ثبت" hint="در گزارش حسابرسی باقی می‌ماند."><input className={inputClass} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} disabled={!permissions.manage || busy} required /></Field>
            <Field label="یادداشت (اختیاری)"><input className={inputClass} value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} disabled={!permissions.manage || busy} /></Field>
          </div>
          {past && !permissions.retroactive ? <p className="text-sm text-amber-800 dark:text-amber-200">تاریخ گذشته انتخاب شده است؛ رویداد تا دریافت مجوز shareholders.retroactive ثبت نمی‌شود.</p> : null}
          <ErrorBox>{formError}</ErrorBox>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-2xl text-xs leading-5 text-muted-foreground">انتقال سهم یک معاملهٔ واحد است: مبدأ و مقصد در یک درخواست ثبت می‌شوند و جمع snapshot در همان تاریخ یک‌جا اعتبارسنجی می‌شود.</p>
            <Button type="submit" disabled={!permissions.manage || busy || (past && !permissions.retroactive) || !asOf}>{busy ? "در حال ثبت…" : "ثبت رویداد مالکیت"}</Button>
          </div>
        </form>
      </SectionCard>

      <SectionCard title={`فهرست مالکیت تا ${dateLabel(workspace.asOf)}`} description="درصد پس از رویداد نگهداری می‌شود؛ این نما آخرین snapshot معتبر تا تاریخ انتخاب‌شده را نشان می‌دهد." flush>
        {register.length === 0 ? <EmptyState title="هنوز سهام‌داری ثبت نشده است">برای شروع، رویداد «افزودن سهام‌دار» را با انتخاب یک شخص از فهرست اشخاص ثبت کنید.</EmptyState> : (
          <DataTable caption="فهرست مالکیت سهام‌داران">
            <DataTableHead><Th>سهام‌دار</Th><Th>نقش در اشخاص</Th><Th numeric>مالکیت</Th><Th numeric>تعداد سهم</Th><Th>مؤثر از</Th><Th>وضعیت</Th></DataTableHead>
            <DataTableBody>
              {register.map((row) => (
                <DataTableRow key={row.shareholderId}>
                  <Td><span className="font-medium">{row.partyName}</span></Td>
                  <Td muted>{roleLabel(row.partyRole)}</Td>
                  <Td numeric>{percentLabel(row.ownershipPercent)}</Td>
                  <Td numeric>{row.shareUnits ? toPersianDigits(row.shareUnits) : "—"}</Td>
                  <Td nowrap>{dateLabel(row.effectiveFrom)}</Td>
                  <Td><StatusBadge tone={row.active ? "positive" : "neutral"}>{row.active ? "فعال" : "بدون مالکیت"}</StatusBadge></Td>
                </DataTableRow>
              ))}
            </DataTableBody>
            <DataTableFoot><tr><Th scope="row">جمع مالکیت</Th><Td /><Td numeric>{percentLabel(ownershipTotal(register))}</Td><Td /><Td /><Td><StatusBadge tone={workspace.totalPolicy === "exactly_100" ? (ownershipTotal(register) === "100" ? "positive" : "danger") : "neutral"}>{workspace.totalPolicy === "exactly_100" ? "سیاست ۱۰۰٪" : "سقف ۱۰۰٪"}</StatusBadge></Td></tr></DataTableFoot>
          </DataTable>
        )}
      </SectionCard>

      <SectionCard title="تاریخچهٔ رویدادهای مالکیت و سرمایه" description="تاریخچه به‌ترتیب اثر زمانی و صفحه‌بندی‌شده است؛ خروجی CSV تمام نتایج فیلترشده را دریافت می‌کند." actions={<a className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted" href={eventExportUrl} download><DownloadIcon className="size-4" aria-hidden="true" /> خروجی کامل CSV</a>} flush>
        <HistoryFilters
          filters={historyFilters}
          categoryOptions
          partyOptions={partyOptions}
          partiesLoading={partiesLoading}
          searchParties={searchParties}
          onChange={onHistoryFilterChange}
        />
        <ErrorBox>{historyError}</ErrorBox>
        {historyLoading ? <LoadingSkeleton rows={2} compact label="در حال بارگذاری تاریخچه" className="px-4 py-2" /> : null}
        {!eventPage && historyError ? <Button variant="outline" size="sm" onClick={onRetryEvents}>تلاش دوباره</Button> : null}
        <EventHistoryTable events={events} money={money} canReverseCapital={canReverseCapital} onReverse={onReverseCapital} />
        <CursorPagination
          totalCount={eventPage?.totalCount ?? 0}
          limit={eventPage?.limit ?? 50}
          hasMore={eventPage?.hasMore ?? false}
          loading={historyLoading}
          canPrevious={canPreviousEventPage}
          onPrevious={onPreviousEventPage}
          onNext={onNextEventPage}
        />
      </SectionCard>
    </div>
  );
}

function shareholderOptionsForTransfer(register: ShareholderWorkspace["register"]): SelectOption[] {
  return register.filter((row) => row.active).map((row) => ({ value: row.partyId, label: `${row.partyName} — ${percentLabel(row.ownershipPercent)}` }));
}

function CapitalPanel({
  workspace,
  accounts,
  permissions,
  busy,
  parties,
  events,
  eventPage,
  historyFilters,
  historyLoading,
  historyError,
  eventExportUrl,
  historyPartyOptions,
  historyPartiesLoading,
  searchHistoryParties,
  onHistoryFilterChange,
  onPreviousEventPage,
  onNextEventPage,
  canPreviousEventPage,
  onRetryEvents,
  onRecord,
  onReverse,
  money,
}: {
  workspace: ShareholderWorkspace;
  accounts: SelectOption[];
  permissions: { record: boolean; reverse: boolean };
  busy: boolean;
  parties: SelectOption[];
  events: ShareholderEventRow[];
  eventPage: ShareholderEventPage | null;
  historyFilters: ShareholderHistoryFilters;
  historyLoading: boolean;
  historyError: string;
  eventExportUrl: string;
  historyPartyOptions: SelectOption[];
  historyPartiesLoading: boolean;
  searchHistoryParties: (query: string) => void;
  onHistoryFilterChange: (patch: Partial<ShareholderHistoryFilters>) => void;
  onPreviousEventPage: () => void;
  onNextEventPage: () => void;
  canPreviousEventPage: boolean;
  onRetryEvents: () => void;
  onRecord: (body: Record<string, unknown>) => Promise<boolean>;
  onReverse: (event: ShareholderEventRow) => void;
  money: ReturnType<typeof useMoney>;
}) {
  const [partyId, setPartyId] = useState("");
  const [eventType, setEventType] = useState<"capital_contribution" | "capital_withdrawal">("capital_contribution");
  const [capitalClass, setCapitalClass] = useState("equity");
  const [amount, setAmount] = useState("");
  const [paymentAccountId, setPaymentAccountId] = useState("");
  const [effectiveOn, setEffectiveOn] = useState(workspace.today);
  const [reason, setReason] = useState("");
  const [sourceReference, setSourceReference] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState("");
  const capitalEvents = events.filter((event) => event.amountRial !== null && ["capital_contribution", "capital_withdrawal", "capital_reversal"].includes(event.eventType));

  useEffect(() => setEffectiveOn(workspace.today), [workspace.today]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    if (!permissions.record) return;
    if (!partyId || !amount.trim() || !paymentAccountId || !reason.trim()) {
      setFormError("سهام‌دار، مبلغ، حساب پرداخت و دلیل ثبت را کامل کنید.");
      return;
    }
    let amountRial: string;
    try {
      amountRial = money.parseText(amount);
    } catch {
      setFormError("مبلغ را به‌صورت عدد صحیح وارد کنید.");
      return;
    }
    if (BigInt(amountRial) <= 0n) {
      setFormError("مبلغ باید بزرگ‌تر از صفر باشد.");
      return;
    }
    const ok = await onRecord({
      partyId,
      eventType,
      capitalClass,
      amountRial,
      paymentAccountId,
      effectiveOn,
      sourceReference: sourceReference.trim() || null,
      reason: reason.trim(),
      notes: notes.trim() || null,
      idempotencyKey: idempotencyKey("shareholder-capital"),
    });
    if (ok) {
      setAmount("");
      setReason("");
      setSourceReference("");
      setNotes("");
    }
  }

  return (
    <div className="space-y-4">
      <SectionCard title="ثبت آورده، برداشت یا وام سهام‌دار" description="پست دوطرفه در دفتر کل ساخته می‌شود و حساب طرف مقابل به شخص سهام‌دار منتسب است.">
        {!permissions.record ? <p className="mb-4 rounded-xl bg-muted/60 p-3 text-sm text-muted-foreground">برای ثبت رویداد سرمایه به مجوز shareholders.capital_post نیاز است.</p> : null}
        <form className="grid gap-x-4 sm:grid-cols-2 xl:grid-cols-4" onSubmit={(event) => void submit(event)}>
          <Field label="سهام‌دار"><SearchableSelect value={partyId} onChange={setPartyId} options={parties} placeholder="انتخاب سهام‌دار…" ariaLabel="انتخاب سهام‌دار برای رویداد سرمایه" disabled={!permissions.record || busy} /></Field>
          <Field label="نوع رویداد"><select className={inputClass} value={eventType} onChange={(event) => setEventType(event.target.value as typeof eventType)} disabled={!permissions.record || busy}><option value="capital_contribution">آوردهٔ سرمایه</option><option value="capital_withdrawal">برداشت یا بازپرداخت وام</option></select></Field>
          <Field label="طبقهٔ حساب"><SearchableSelect value={capitalClass} onChange={setCapitalClass} options={[...CAPITAL_CLASS_OPTIONS]} ariaLabel="طبقهٔ حساب سرمایه یا وام" disabled={!permissions.record || busy} /></Field>
          <Field label={`مبلغ (${money.unitLabel})`} hint="عدد صحیح؛ مبلغ نهایی به ریال صحیح تبدیل و ثبت می‌شود."><PersianNumberInput value={amount} onChange={(event) => setAmount(event.target.value)} disabled={!permissions.record || busy} /></Field>
          <Field label="حساب دریافت / پرداخت"><SearchableSelect value={paymentAccountId} onChange={setPaymentAccountId} options={accounts} disabled={!permissions.record || busy} placeholder="حساب دارایی ریالی…" ariaLabel="حساب دارایی ریالی دریافت یا پرداخت" /></Field>
          <Field label="تاریخ مؤثر"><JalaliDatePicker value={effectiveOn} onChange={setEffectiveOn} ariaLabel="تاریخ رویداد سرمایه" disabled={!permissions.record || busy} /></Field>
          <Field label="مرجع یا شمارهٔ سند (اختیاری)"><input className={inputClass} value={sourceReference} onChange={(event) => setSourceReference(event.target.value)} maxLength={120} disabled={!permissions.record || busy} /></Field>
          <Field label="دلیل ثبت"><input className={inputClass} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} disabled={!permissions.record || busy} required /></Field>
          <div className="sm:col-span-2 xl:col-span-4"><Field label="یادداشت (اختیاری)"><input className={inputClass} value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} disabled={!permissions.record || busy} /></Field></div>
          <div className="sm:col-span-2 xl:col-span-4"><ErrorBox>{formError}</ErrorBox><Button type="submit" disabled={!permissions.record || busy}>{busy ? "در حال ثبت…" : "ثبت رویداد و سند حسابداری"}</Button></div>
        </form>
        {eventType === "capital_withdrawal" ? <p className="mt-2 text-xs leading-5 text-muted-foreground">برداشت از حساب ۳۱۰۰/۳۱۵۰ و بازپرداخت وام از حساب ۲۵۱۰ بدهکار می‌شود؛ حساب پرداخت انتخاب‌شده بستانکار خواهد شد.</p> : null}
      </SectionCard>

      <SectionCard title="ماندهٔ حساب‌های سهام‌داران" description="مانده‌ها از خطوط دفتر کل و انتساب طرف‌حساب محاسبه می‌شوند؛ این جدول منبع مستقل مانده نیست." flush>
        <ShareholderBalanceTable rows={workspace.shareholderBalances} money={money} />
      </SectionCard>

      <SectionCard title="رویدادهای سرمایه ثبت‌شده" description="تاریخچهٔ کامل با فیلتر و صفحه‌بندی؛ خروجی CSV همهٔ نتایج فیلترشده را شامل می‌شود." actions={<a className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted" href={eventExportUrl} download><DownloadIcon className="size-4" aria-hidden="true" /> خروجی CSV</a>} flush>
        <HistoryFilters filters={historyFilters} forcedCategory="capital" partyOptions={historyPartyOptions} partiesLoading={historyPartiesLoading} searchParties={searchHistoryParties} onChange={onHistoryFilterChange} />
        <ErrorBox>{historyError}</ErrorBox>
        {historyLoading ? <LoadingSkeleton rows={2} compact label="در حال بارگذاری رویدادهای سرمایه" className="px-4 py-2" /> : null}
        {!eventPage && historyError ? <Button variant="outline" size="sm" onClick={onRetryEvents}>تلاش دوباره</Button> : null}
        {capitalEvents.length === 0 && !historyLoading ? <EmptyState title="رویداد سرمایه‌ای در این فیلتر ثبت نشده است">آورده یا برداشت سهام‌دار را از فرم بالا ثبت کنید یا فیلترها را تغییر دهید.</EmptyState> : (
          <DataTable caption="رویدادهای سرمایهٔ سهام‌داران">
            <DataTableHead><Th>تاریخ</Th><Th>سهام‌دار</Th><Th>نوع</Th><Th>طبقه</Th><Th numeric>مبلغ</Th><Th>سند دفتر کل</Th><Th>دلیل</Th><Th>عملیات</Th></DataTableHead>
            <DataTableBody>
              {capitalEvents.map((event) => {
                const alreadyReversed = event.isReversed;
                return <DataTableRow key={event.id}>
                  <Td nowrap>{dateLabel(event.effectiveOn)}</Td><Td>{event.partyName}</Td><Td>{EVENT_LABELS[event.eventType] ?? event.eventType}</Td><Td>{capitalClassLabel(event.capitalClass)}</Td><Td numeric>{formatBalance(money, event.amountRial ?? "0")}</Td>
                  <Td>{event.journalEntryId ? <Link className="text-primary underline-offset-4 hover:underline" href={journalHref(event.journalEntryId)}>{event.journalVoucher ? `سند ${toPersianDigits(event.journalVoucher)}` : "مشاهدهٔ سند"}</Link> : "—"}</Td>
                  <Td className="max-w-64 truncate" title={event.reason ?? undefined}>{event.reason ?? "—"}</Td>
                  <Td>{permissions.reverse && !alreadyReversed && !event.reversesEventId && event.eventType !== "capital_reversal" ? <Button variant="outline" size="sm" disabled={busy} onClick={() => onReverse(event)}>برگشت</Button> : event.reversesEventId ? <StatusBadge tone="neutral">رویداد برگشت</StatusBadge> : alreadyReversed ? <StatusBadge tone="neutral">برگشت‌شده</StatusBadge> : "—"}</Td>
                </DataTableRow>;
              })}
            </DataTableBody>
          </DataTable>
        )}
        <CursorPagination totalCount={eventPage?.totalCount ?? 0} limit={eventPage?.limit ?? 50} hasMore={eventPage?.hasMore ?? false} loading={historyLoading} canPrevious={canPreviousEventPage} onPrevious={onPreviousEventPage} onNext={onNextEventPage} />
      </SectionCard>
    </div>
  );
}

function capitalClassLabel(value: string | null): string {
  switch (value) {
    case "equity": return "سرمایه (۳۱۰۰)";
    case "additional_paid_in_capital": return "صرف سهام (۳۱۵۰)";
    case "shareholder_loan": return "وام (۲۵۱۰)";
    default: return "—";
  }
}

function ShareholderBalanceTable({ rows, money }: { rows: ShareholderBalanceRow[]; money: ReturnType<typeof useMoney> }) {
  if (rows.length === 0) return <EmptyState title="ماندهٔ منتسبی وجود ندارد">اسناد مالی ثبت‌شده به شخص در حساب‌های مرتبط با سهام‌داران نمایش داده می‌شوند.</EmptyState>;
  return (
    <DataTable caption="ماندهٔ حساب‌های دفتر کل به تفکیک سهام‌دار">
      <DataTableHead><Th>سهام‌دار</Th><Th numeric>سرمایه</Th><Th numeric>صرف سهام</Th><Th numeric>برداشت‌ها</Th><Th numeric>وام پرداختنی</Th><Th numeric>سود پرداختنی</Th></DataTableHead>
      <DataTableBody>{rows.map((row) => <DataTableRow key={row.shareholderId}><Td>{row.partyName}</Td><Td numeric>{formatBalance(money, row.capitalRial)}</Td><Td numeric>{formatBalance(money, row.additionalPaidInCapitalRial)}</Td><Td numeric>{formatBalance(money, row.withdrawalsRial)}</Td><Td numeric>{formatBalance(money, row.shareholderLoanRial)}</Td><Td numeric>{formatBalance(money, row.distributionsPayableRial)}</Td></DataTableRow>)}</DataTableBody>
    </DataTable>
  );
}

function distributionPartyOptions(
  workspace: ShareholderWorkspace,
  lines: readonly ShareholderDistributionLineRow[],
): SelectOption[] {
  const parties = new Map<string, string>();
  for (const row of workspace.register) parties.set(row.partyId, row.partyName);
  for (const row of workspace.shareholderBalances) parties.set(row.partyId, row.partyName);
  for (const row of lines) parties.set(row.partyId, row.partyName);
  return [...parties].map(([value, name]) => ({ value, label: name, searchString: name }));
}

function DistributionPanel({
  workspace,
  distributions,
  distributionPage,
  distributionLoading,
  distributionError,
  distributionFilters,
  onDistributionFilterChange,
  onPreviousDistributionPage,
  onNextDistributionPage,
  canPreviousDistributionPage,
  onRetryDistributions,
  selected,
  selectedId,
  onSelect,
  detailLoading,
  detailError,
  onRetryDetail,
  lines,
  linePage,
  lineLoading,
  lineError,
  lineOffset,
  onLineOffsetChange,
  linePartyId,
  onLinePartyChange,
  onRetryLines,
  payments,
  paymentPage,
  paymentFilters,
  onPaymentFilterChange,
  paymentPartyOptions,
  paymentPartySearchBusy,
  searchPaymentParties,
  paymentLoading,
  paymentError,
  onPreviousPaymentPage,
  onNextPaymentPage,
  canPreviousPaymentPage,
  onRetryPayments,
  accountOptions,
  permissions,
  currentUserId,
  busy,
  money,
  onCreate,
  onAction,
  onConfirm,
}: {
  workspace: ShareholderWorkspace;
  distributions: ShareholderDistributionRow[];
  distributionPage: ShareholderDistributionPage | null;
  distributionLoading: boolean;
  distributionError: string;
  distributionFilters: ShareholderDistributionFiltersUi;
  onDistributionFilterChange: (patch: Partial<ShareholderDistributionFiltersUi>) => void;
  onPreviousDistributionPage: () => void;
  onNextDistributionPage: () => void;
  canPreviousDistributionPage: boolean;
  onRetryDistributions: () => void;
  selected: ShareholderDistributionRow | null;
  selectedId: string;
  onSelect: (id: string) => void;
  detailLoading: boolean;
  detailError: string;
  onRetryDetail: () => void;
  lines: ShareholderDistributionLineRow[];
  linePage: ShareholderDistributionLinePage | null;
  lineLoading: boolean;
  lineError: string;
  lineOffset: number;
  onLineOffsetChange: (offset: number) => void;
  linePartyId: string;
  onLinePartyChange: (partyId: string) => void;
  onRetryLines: () => void;
  payments: ShareholderPaymentRow[];
  paymentPage: ShareholderPaymentPage | null;
  paymentFilters: ShareholderPaymentFiltersUi;
  onPaymentFilterChange: (patch: Partial<ShareholderPaymentFiltersUi>) => void;
  paymentPartyOptions: SelectOption[];
  paymentPartySearchBusy: boolean;
  searchPaymentParties: (query: string) => void;
  paymentLoading: boolean;
  paymentError: string;
  onPreviousPaymentPage: () => void;
  onNextPaymentPage: () => void;
  canPreviousPaymentPage: boolean;
  onRetryPayments: () => void;
  accountOptions: SelectOption[];
  permissions: { manage: boolean; adjust: boolean; approve: boolean; post: boolean; pay: boolean; reverse: boolean };
  currentUserId: string;
  busy: boolean;
  money: ReturnType<typeof useMoney>;
  onCreate: (body: Record<string, unknown>) => Promise<boolean>;
  onAction: <T extends Record<string, unknown>>(path: string, method: "POST" | "PUT", body?: Record<string, unknown>, successMessage?: string) => Promise<T | null>;
  onConfirm: (request: ConfirmRequest) => void;
}) {
  const closedYears = workspace.fiscalYears.filter((year) => year.closedAt && year.closingEntryId && BigInt(year.closingProfitRial) > 0n);
  const [fiscalYearId, setFiscalYearId] = useState(closedYears[0]?.id ?? "");
  const [snapshotOn, setSnapshotOn] = useState(closedYears[0]?.endsOn ?? workspace.today);
  const [taxAdjustment, setTaxAdjustment] = useState("0");
  const [reserveAdjustment, setReserveAdjustment] = useState("0");
  const [manualAdjustment, setManualAdjustment] = useState("0");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [sourceReference, setSourceReference] = useState("");
  const [formError, setFormError] = useState("");
  const [payShareholderId, setPayShareholderId] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(workspace.today);
  const [payAccountId, setPayAccountId] = useState("");
  const [paymentNote, setPaymentNote] = useState("");

  const selectedYear = workspace.fiscalYears.find((year) => year.id === fiscalYearId) ?? null;
  useEffect(() => {
    if (!workspace.fiscalYears.some((year) => year.id === fiscalYearId)) {
      const first = closedYears[0];
      setFiscalYearId(first?.id ?? "");
      setSnapshotOn(first?.endsOn ?? workspace.today);
    }
  }, [workspace.fiscalYears, fiscalYearId, workspace.today, closedYears]);
  useEffect(() => {
    setPayDate(workspace.today);
  }, [workspace.today]);
  useEffect(() => {
    if (!lines.some((line) => line.shareholderId === payShareholderId && BigInt(line.outstandingRial) > 0n)) {
      setPayShareholderId(lines.find((line) => BigInt(line.outstandingRial) > 0n)?.shareholderId ?? "");
    }
  }, [lines, payShareholderId]);

  const preview = useMemo(() => {
    if (!selectedYear) return null;
    try {
      const source = BigInt(selectedYear.closingProfitRial);
      const tax = BigInt(money.parseText(taxAdjustment || "0"));
      const reserve = BigInt(money.parseText(reserveAdjustment || "0"));
      const manual = BigInt(money.parseText(manualAdjustment || "0"));
      const distributable = source - tax - reserve + manual;
      return { source, tax, reserve, manual, distributable, valid: distributable > 0n && distributable <= source };
    } catch {
      return null;
    }
  }, [selectedYear, taxAdjustment, reserveAdjustment, manualAdjustment, money]);

  const linesTotal = linePage?.totalAllocatedRial ?? "0";
  const linePartyOptions = distributionPartyOptions(workspace, lines);
  const outstandingLines = lines.filter((line) => BigInt(line.outstandingRial) > 0n);
  const payOptions = outstandingLines.map((line) => ({ value: line.shareholderId, label: `${line.partyName} — مانده ${formatBalance(money, line.outstandingRial)}` }));
  const selectedLine = lines.find((line) => line.shareholderId === payShareholderId) ?? null;

  async function createDistribution(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    if (!permissions.manage || !selectedYear || !snapshotOn) return;
    const hasAdjustments = [taxAdjustment, reserveAdjustment, manualAdjustment].some((value) => {
      try { return BigInt(money.parseText(value || "0")) !== 0n; } catch { return true; }
    });
    if (hasAdjustments && !permissions.adjust) {
      setFormError("برای تعدیل سود، مجوز shareholders.distributions_adjust لازم است.");
      return;
    }
    if (hasAdjustments && !adjustmentReason.trim()) {
      setFormError("برای هر تعدیل، دلیل مستند وارد کنید.");
      return;
    }
    if (!preview?.valid) {
      setFormError("سود قابل‌تقسیم باید از صفر بیشتر و از سود سال بسته‌شده بیشتر نباشد.");
      return;
    }
    let taxRial: string;
    let reserveRial: string;
    let manualRial: string;
    try {
      taxRial = money.parseText(taxAdjustment || "0");
      reserveRial = money.parseText(reserveAdjustment || "0");
      manualRial = money.parseText(manualAdjustment || "0");
    } catch {
      setFormError("مقادیر تعدیل باید عدد صحیح باشند.");
      return;
    }
    await onCreate({
      fiscalYearId,
      snapshotOn,
      taxAdjustmentRial: taxRial,
      reserveAdjustmentRial: reserveRial,
      manualAdjustmentRial: manualRial,
      adjustmentReason: adjustmentReason.trim() || null,
      sourceReference: sourceReference.trim() || null,
      idempotencyKey: idempotencyKey("shareholder-distribution"),
    });
  }

  async function payDistribution(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    if (!selected || !permissions.pay || !selectedLine || !payAccountId || !payAmount.trim()) return;
    let amountRial: string;
    try {
      amountRial = money.parseText(payAmount);
    } catch {
      setFormError("مبلغ پرداخت را به‌صورت عدد صحیح وارد کنید.");
      return;
    }
    if (BigInt(amountRial) <= 0n) {
      setFormError("مبلغ پرداخت باید بزرگ‌تر از صفر باشد.");
      return;
    }
    const result = await onAction(`${WORKSPACE_URL}/distributions/${selected.id}/pay`, "POST", {
      shareholderId: selectedLine.shareholderId,
      amountRial,
      paidOn: payDate,
      paymentAccountId: payAccountId,
      note: paymentNote.trim() || null,
      idempotencyKey: idempotencyKey("shareholder-distribution-payment"),
    }, "پرداخت سهم سود با سند حسابداری ثبت شد.");
    if (result) {
      setPayAmount("");
      setPaymentNote("");
    }
  }

  return (
    <div className="space-y-4">
      <SectionCard title="ساخت توزیع سود از سال مالی بسته‌شده" description="مبنای سود فقط سند اختتامیهٔ موجود است؛ این بخش سند بستن یا ماندهٔ سود را دوباره محاسبه نمی‌کند.">
        {!permissions.manage ? <p className="mb-4 rounded-xl bg-muted/60 p-3 text-sm text-muted-foreground">برای ساخت پیش‌نویس به مجوز shareholders.distributions_manage نیاز است.</p> : null}
        {closedYears.length === 0 ? <p className="mb-4 rounded-xl border border-amber-300/50 bg-amber-50/60 p-3 text-sm leading-6 text-amber-950 dark:bg-amber-500/10 dark:text-amber-100">سال مالی بسته‌شده با سند اختتامیه و سود مثبت پیدا نشد. ابتدا از بخش «دوره‌های مالی» سال مالی را ببندید.</p> : null}
        <form className="grid gap-x-4 sm:grid-cols-2 xl:grid-cols-4" onSubmit={(event) => void createDistribution(event)}>
          <Field label="سال مالی بسته‌شده">
            <SearchableSelect value={fiscalYearId} onChange={(value) => {
              setFiscalYearId(value);
              const year = workspace.fiscalYears.find((candidate) => candidate.id === value);
              if (year) setSnapshotOn(year.endsOn);
            }} options={closedYears.map((year) => ({ value: year.id, label: `${year.label} — سود ${formatBalance(money, year.closingProfitRial)}` }))} disabled={!permissions.manage || busy || closedYears.length === 0} placeholder="انتخاب سال…" ariaLabel="انتخاب سال مالی بسته‌شده برای توزیع سود" />
          </Field>
          <Field label="تاریخ snapshot مالکیت" hint="این تاریخ باید در محدودهٔ سال مالی بسته‌شده باشد."><JalaliDatePicker value={snapshotOn} onChange={setSnapshotOn} disabled={!permissions.manage || busy || !selectedYear} ariaLabel="تاریخ snapshot مالکیت سود" /></Field>
          <Field label={`تعدیل مالیات (${money.unitLabel})`}><PersianNumberInput value={taxAdjustment} onChange={(event) => setTaxAdjustment(event.target.value)} disabled={!permissions.manage || !permissions.adjust || busy} /></Field>
          <Field label={`اندوخته (${money.unitLabel})`}><PersianNumberInput value={reserveAdjustment} onChange={(event) => setReserveAdjustment(event.target.value)} disabled={!permissions.manage || !permissions.adjust || busy} /></Field>
          <Field label={`تعدیل دستی (${money.unitLabel})`} hint="مقدار منفی سود قابل‌تقسیم را کاهش می‌دهد."><PersianNumberInput value={manualAdjustment} onChange={(event) => setManualAdjustment(event.target.value)} allowNegative disabled={!permissions.manage || !permissions.adjust || busy} /></Field>
          <Field label="دلیل تعدیل" hint="برای هر تعدیل، دلیل در سابقهٔ حسابرسی ثبت می‌شود."><input className={inputClass} value={adjustmentReason} onChange={(event) => setAdjustmentReason(event.target.value)} maxLength={500} disabled={!permissions.manage || !permissions.adjust || busy} /></Field>
          <Field label="مرجع مصوبه (اختیاری)"><input className={inputClass} value={sourceReference} onChange={(event) => setSourceReference(event.target.value)} maxLength={120} disabled={!permissions.manage || busy} /></Field>
          {selectedYear && preview ? (
            <div className="sm:col-span-2 xl:col-span-4 grid gap-3 rounded-xl border border-border/80 bg-muted/30 p-4 sm:grid-cols-4">
              <div><span className="block text-xs text-muted-foreground">سود بسته‌شده از ۳۸۰۰</span><strong className="mt-1 block tabular-nums">{formatBalance(money, preview.source.toString())}</strong></div>
              <div><span className="block text-xs text-muted-foreground">مالیات و اندوخته</span><strong className="mt-1 block tabular-nums">{formatBalance(money, (preview.tax + preview.reserve).toString())}</strong></div>
              <div><span className="block text-xs text-muted-foreground">تعدیل دستی</span><strong className="mt-1 block tabular-nums">{formatBalance(money, preview.manual.toString())}</strong></div>
              <div><span className="block text-xs text-muted-foreground">سود قابل‌تقسیم</span><strong className={preview.valid ? "mt-1 block tabular-nums text-foreground" : "mt-1 block tabular-nums text-destructive"}>{formatBalance(money, preview.distributable.toString())}</strong></div>
            </div>
          ) : null}
          {!permissions.adjust ? <p className="sm:col-span-2 xl:col-span-4 text-xs leading-5 text-muted-foreground">بدون مجوز تعدیل، فقط تقسیم کل سود بسته‌شده بدون تغییر مالیات، اندوخته یا تعدیل دستی ممکن است.</p> : null}
          <div className="sm:col-span-2 xl:col-span-4"><ErrorBox>{formError}</ErrorBox><Button type="submit" disabled={!permissions.manage || busy || closedYears.length === 0 || !preview?.valid}>{busy ? "در حال ساخت…" : "ساخت پیش‌نویس و snapshot تخصیص"}</Button></div>
        </form>
      </SectionCard>

      <FiscalYearDistributionReconciliation rows={workspace.fiscalYearReconciliation} money={money} />

      <SectionCard title="توزیع‌های سود" description="مبالغ هر خط با مالکیت snapshot ثابت شده‌اند؛ پرداخت‌ها جداگانه در حساب ۲۵۲۰ و حساب پرداخت ثبت می‌شوند." flush>
        <div className="grid gap-3 border-b border-border/70 p-4 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="فیلتر سال مالی">
            <select className={inputClass} value={distributionFilters.fiscalYearId} onChange={(event) => onDistributionFilterChange({ fiscalYearId: event.target.value })}>
              <option value="">همهٔ سال‌ها</option>
              {workspace.fiscalYears.map((year) => <option key={year.id} value={year.id}>{year.label}</option>)}
            </select>
          </Field>
          <Field label="فیلتر وضعیت">
            <select className={inputClass} value={distributionFilters.status} onChange={(event) => onDistributionFilterChange({ status: event.target.value })}>
              <option value="all">همهٔ وضعیت‌ها</option>
              {Object.entries(DISTRIBUTION_STATUS).map(([value, status]) => <option key={value} value={value}>{status.label}</option>)}
            </select>
          </Field>
          <div className="sm:col-span-2 flex flex-wrap items-end gap-3 text-sm text-muted-foreground">
            <span>تعداد در فیلتر: <strong className="text-foreground">{toPersianDigits(String(distributionPage?.totalCount ?? 0))}</strong></span>
            <span>رزرو فعال: <strong className="text-foreground">{formatBalance(money, distributionPage?.summary.reservedRial ?? "0")}</strong></span>
            <span>در انتظار ثبت: <strong className="text-foreground">{formatBalance(money, distributionPage?.summary.pendingPostingRial ?? "0")}</strong></span>
            <span>پرداخت‌نشده: <strong className="text-foreground">{formatBalance(money, distributionPage?.summary.outstandingRial ?? "0")}</strong></span>
          </div>
        </div>
        <ErrorBox>{distributionError}</ErrorBox>
        {distributionLoading ? <LoadingSkeleton rows={2} compact label="در حال بارگذاری توزیع‌ها" className="px-4 py-2" /> : null}
        {!distributionPage && distributionError ? <div className="p-4"><Button variant="outline" size="sm" onClick={onRetryDistributions}>تلاش دوباره</Button></div> : null}
        {distributionPage?.totalCount === 0 && !distributionLoading ? <EmptyState title="توزیعی با این فیلترها پیدا نشد">سال مالی یا وضعیت دیگری انتخاب کنید، یا پیش‌نویس جدید بسازید.</EmptyState> : null}
        {distributions.length > 0 ? (
          <DataTable caption="توزیع‌های سود سهام‌داران">
            <DataTableHead><Th>سال مالی</Th><Th>Snapshot</Th><Th>وضعیت</Th><Th numeric>سود مبنا</Th><Th numeric>قابل‌تقسیم</Th><Th numeric>پرداخت‌شده</Th><Th numeric>مانده</Th><Th>جزئیات</Th></DataTableHead>
            <DataTableBody>{distributions.map((distribution) => {
              const status = DISTRIBUTION_STATUS[distribution.status] ?? { label: distribution.status, tone: "neutral" as const };
              return <DataTableRow key={distribution.id} selected={distribution.id === selectedId} onClick={() => onSelect(distribution.id)}>
                <Td>{distribution.fiscalYearLabel}</Td><Td nowrap>{dateLabel(distribution.snapshotOn)}</Td><Td><StatusBadge tone={status.tone}>{status.label}</StatusBadge></Td><Td numeric>{formatBalance(money, distribution.sourceProfitRial)}</Td><Td numeric>{formatBalance(money, distribution.distributableRial)}</Td><Td numeric>{formatBalance(money, distribution.paidRial)}</Td><Td numeric>{formatBalance(money, distribution.outstandingRial)}</Td><Td><Button type="button" variant="outline" size="sm" onClick={(event) => { event.stopPropagation(); onSelect(distribution.id); }}>نمایش</Button></Td>
              </DataTableRow>;
            })}</DataTableBody>
            <DataTableFoot><tr><Th scope="row" colSpan={6}>جمع نتایج فیلترشده، مستقل از صفحه</Th><Td numeric>{formatBalance(money, distributionPage?.summary.outstandingRial ?? "0")}</Td><Td /></tr></DataTableFoot>
          </DataTable>
        ) : null}
        <CursorPagination
          totalCount={distributionPage?.totalCount ?? 0}
          limit={distributionPage?.limit ?? 25}
          hasMore={distributionPage?.hasMore ?? false}
          loading={distributionLoading}
          canPrevious={canPreviousDistributionPage}
          onPrevious={onPreviousDistributionPage}
          onNext={onNextDistributionPage}
        />
      </SectionCard>

      {detailLoading && selectedId ? <SectionCard title="بارگذاری توزیع انتخاب‌شده"><p className="py-4 text-sm text-muted-foreground" role="status">جزئیات مستقل توزیع در حال بارگذاری است…</p></SectionCard> : null}
      {detailError ? <SectionCard title="جزئیات توزیع در دسترس نیست"><ErrorBox>{detailError}</ErrorBox><Button variant="outline" size="sm" onClick={onRetryDetail}>تلاش دوباره</Button></SectionCard> : null}
      {selected ? (
        <>
          <SectionCard title={`توزیع ${selected.fiscalYearLabel}`} description={`Snapshot مالکیت: ${dateLabel(selected.snapshotOn)} · سود مبنا از سند اختتامیه: ${formatBalance(money, selected.sourceProfitRial)}`} actions={<StatusBadge tone={(DISTRIBUTION_STATUS[selected.status] ?? { tone: "neutral" }).tone}>{DISTRIBUTION_STATUS[selected.status]?.label ?? selected.status}</StatusBadge>}>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <DetailValue label="سند اختتامیه"><Link href={journalHref(selected.closingEntryId)} className="text-primary underline-offset-4 hover:underline">مشاهدهٔ سند</Link></DetailValue>
              <DetailValue label="تعدیل مالیات">{formatBalance(money, selected.taxAdjustmentRial)}</DetailValue>
              <DetailValue label="اندوخته">{formatBalance(money, selected.reserveAdjustmentRial)}</DetailValue>
              <DetailValue label="تعدیل دستی">{formatBalance(money, selected.manualAdjustmentRial)}</DetailValue>
              <DetailValue label="ثبت‌کننده">{selected.createdByName ?? "—"}</DetailValue>
              <DetailValue label="تأییدکننده">{selected.approvedByName ?? "—"}</DetailValue>
              <DetailValue label="ثبت‌کنندهٔ سند">{selected.postedByName ?? "—"}</DetailValue>
              <DetailValue label="دلیل تعدیل">{selected.adjustmentReason || "بدون تعدیل"}</DetailValue>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {selected.status === "draft" && permissions.approve ? <Button variant="outline" disabled={busy || selected.createdById === currentUserId} onClick={() => onConfirm({ title: "تأیید پیش‌نویس تقسیم سود؟", description: "تأییدکننده باید با ثبت‌کننده متفاوت باشد. پس از تأیید، توزیع برای ثبت در دفتر کل آماده می‌شود.", confirmLabel: "تأیید توزیع", run: async () => { await onAction(`${WORKSPACE_URL}/distributions/${selected.id}/approve`, "POST", undefined, "توزیع سود تأیید شد."); } })}>تأیید پیش‌نویس</Button> : null}
              {selected.status === "draft" && permissions.approve && selected.createdById === currentUserId ? <span className="self-center text-xs text-muted-foreground">ثبت‌کننده نمی‌تواند پیش‌نویس خود را تأیید کند.</span> : null}
              {approvalCanPost(selected.status) && permissions.post ? <Button disabled={busy} onClick={() => onConfirm({ title: "ثبت توزیع سود در دفتر کل؟", description: "سود انباشتهٔ ۳۸۰۰ بدهکار و سود پرداختنی ۲۵۲۰ به تفکیک شخص بستانکار می‌شود. این سند پس از ثبت فقط با سند آینه برگشت می‌خورد.", confirmLabel: "ثبت در دفتر کل", run: async () => { await onAction(`${WORKSPACE_URL}/distributions/${selected.id}/post`, "POST", undefined, "توزیع سود به دفتر کل ثبت شد."); } })}>ثبت در دفتر کل</Button> : null}
              {(selected.status === "draft" || selected.status === "approved") && permissions.manage ? <Button variant="destructive" disabled={busy} onClick={() => onConfirm({ title: "لغو پیش‌نویس تقسیم سود؟", description: "لغو فقط پیش‌نویس یا مورد تأییدشده را می‌پذیرد. دلیل لغو به‌صورت دائمی در رویدادهای حسابرسی ثبت می‌شود.", confirmLabel: "لغو توزیع", reasonRequired: true, run: async (reason) => { await onAction(`${WORKSPACE_URL}/distributions/${selected.id}/cancel`, "POST", { reason }, "توزیع سود با دلیل ثبت‌شده لغو شد."); } })}>لغو پیش‌نویس</Button> : null}
              {permissions.reverse && ["posted", "partially_paid", "paid"].includes(selected.status) && BigInt(selected.paidRial) === 0n ? <Button variant="destructive" disabled={busy} onClick={() => onConfirm({ title: "برگشت سند توزیع؟", description: "فقط پس از برگشت تمام پرداخت‌ها ممکن است. سامانه یک سند آینه از سند توزیع می‌سازد و snapshot تاریخی را نگه می‌دارد.", confirmLabel: "ثبت سند برگشت", run: async () => { await onAction(`${WORKSPACE_URL}/distributions/${selected.id}/reverse`, "POST", { idempotencyKey: idempotencyKey("shareholder-distribution-reversal") }, "توزیع سود با سند آینه برگشت خورد."); } })}>برگشت سند توزیع</Button> : null}
            </div>
          </SectionCard>

          <SectionCard title="خطوط تخصیص snapshot" description="مبالغ ثابت و تغییرناپذیرند؛ این جدول فقط صفحهٔ درخواستی را نشان می‌دهد و جمع کل از همهٔ خطوط محاسبه می‌شود." flush>
            <div className="grid gap-3 border-b border-border/70 p-4 sm:grid-cols-2">
              <Field label="فیلتر سهام‌دار">
                <SearchableSelect value={linePartyId} onChange={onLinePartyChange} options={linePartyOptions} placeholder="همهٔ سهام‌داران" searchPlaceholder="جست‌وجوی نام سهام‌دار" ariaLabel="فیلتر خطوط تخصیص بر اساس سهام‌دار" />
              </Field>
              <div className="flex items-end gap-3 text-sm text-muted-foreground">
                <span>کل خطوط: <strong className="text-foreground">{toPersianDigits(String(linePage?.totalCount ?? 0))}</strong></span>
                <span>تخصیص: <strong className="text-foreground">{formatBalance(money, linesTotal)}</strong></span>
                <span>پرداخت‌نشده: <strong className="text-foreground">{formatBalance(money, linePage?.totalOutstandingRial ?? "0")}</strong></span>
              </div>
            </div>
            <ErrorBox>{lineError}</ErrorBox>
            {lineLoading ? <LoadingSkeleton rows={2} compact label="در حال بارگذاری خطوط تخصیص" className="px-4 py-2" /> : null}
            {!linePage && lineError ? <div className="p-4"><Button variant="outline" size="sm" onClick={onRetryLines}>تلاش دوباره</Button></div> : null}
            {linePage?.totalCount === 0 && !lineLoading ? <EmptyState title="خط تخصیصی با این فیلتر پیدا نشد">فیلتر سهام‌دار را پاک کنید یا جزئیات را دوباره بارگذاری کنید.</EmptyState> : null}
            {lines.length > 0 ? (
              <DataTable caption="مالکیت و مبلغ تخصیص‌یافته برای هر سهام‌دار">
                <DataTableHead><Th>سهام‌دار</Th><Th numeric>مالکیت در snapshot</Th><Th numeric>تعداد سهم</Th><Th numeric>تخصیص</Th><Th numeric>پرداخت‌شده</Th><Th numeric>ماندهٔ سهم</Th></DataTableHead>
                <DataTableBody>{lines.map((line) => <DataTableRow key={`${line.distributionId}:${line.shareholderId}`}><Td>{line.partyName}</Td><Td numeric>{percentLabel(line.ownershipPercent)}</Td><Td numeric>{line.shareUnits ? toPersianDigits(line.shareUnits) : "—"}</Td><Td numeric>{formatBalance(money, line.allocatedRial)}</Td><Td numeric>{formatBalance(money, line.paidRial)}</Td><Td numeric>{formatBalance(money, line.outstandingRial)}</Td></DataTableRow>)}</DataTableBody>
                <DataTableFoot><tr><Th scope="row" colSpan={3}>جمع کل، مستقل از صفحه</Th><Td numeric>{formatBalance(money, linePage?.totalAllocatedRial ?? "0")}</Td><Td numeric>{formatBalance(money, linePage?.totalPaidRial ?? "0")}</Td><Td numeric>{formatBalance(money, linePage?.totalOutstandingRial ?? "0")}</Td></tr></DataTableFoot>
              </DataTable>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 p-3">
              <span className="text-xs text-muted-foreground">صفحهٔ {toPersianDigits(String(Math.floor(lineOffset / (linePage?.limit ?? 25)) + 1))}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={lineLoading || lineOffset === 0} onClick={() => onLineOffsetChange(Math.max(0, lineOffset - (linePage?.limit ?? 25)))}>قبلی</Button>
                <Button variant="outline" size="sm" disabled={lineLoading || linePage?.nextOffset === null || linePage?.nextOffset === undefined} onClick={() => { if (linePage?.nextOffset !== null && linePage?.nextOffset !== undefined) onLineOffsetChange(linePage.nextOffset); }}>بعدی</Button>
              </div>
            </div>
          </SectionCard>

          {selected.status === "posted" || selected.status === "partially_paid" ? (
            <SectionCard title="ثبت پرداخت سهم سود" description="هر پرداخت، بدهکار حساب ۲۵۲۰ برای همان شخص و بستانکار حساب دارایی انتخابی را ثبت می‌کند.">
              {!permissions.pay ? <p className="mb-4 rounded-xl bg-muted/60 p-3 text-sm text-muted-foreground">برای پرداخت به مجوز shareholders.distributions_pay نیاز است.</p> : null}
              {outstandingLines.length === 0 ? <p className="mb-4 rounded-xl border border-border/80 bg-muted/30 p-3 text-sm text-muted-foreground">برای این snapshot ماندهٔ پرداختنی وجود ندارد.</p> : null}
              <form className="grid gap-x-4 sm:grid-cols-2 xl:grid-cols-4" onSubmit={(event) => void payDistribution(event)}>
                <Field label="سهام‌دار"><SearchableSelect value={payShareholderId} onChange={setPayShareholderId} options={payOptions} disabled={!permissions.pay || busy || payOptions.length === 0} placeholder="انتخاب سهم پرداختنی…" ariaLabel="انتخاب سهام‌دار برای پرداخت سود" /></Field>
                <Field label={`مبلغ پرداخت (${money.unitLabel})`} hint={selectedLine ? `مانده: ${formatBalance(money, selectedLine.outstandingRial)}` : undefined}><PersianNumberInput value={payAmount} onChange={(event) => setPayAmount(event.target.value)} disabled={!permissions.pay || busy || !selectedLine} /></Field>
                <Field label="حساب پرداخت"><SearchableSelect value={payAccountId} onChange={setPayAccountId} options={accountOptions} disabled={!permissions.pay || busy} placeholder="حساب دارایی ریالی…" ariaLabel="انتخاب حساب دارایی ریالی پرداخت سود" /></Field>
                <Field label="تاریخ پرداخت"><JalaliDatePicker value={payDate} onChange={setPayDate} disabled={!permissions.pay || busy} ariaLabel="تاریخ پرداخت سود سهام‌دار" /></Field>
                <div className="sm:col-span-2 xl:col-span-4"><Field label="شرح پرداخت (اختیاری)"><input className={inputClass} value={paymentNote} onChange={(event) => setPaymentNote(event.target.value)} maxLength={1000} disabled={!permissions.pay || busy} /></Field></div>
                <div className="sm:col-span-2 xl:col-span-4"><ErrorBox>{formError}</ErrorBox><Button type="submit" disabled={!permissions.pay || busy || !selectedLine || !payAccountId}>{busy ? "در حال ثبت…" : "ثبت پرداخت و سند حسابداری"}</Button></div>
              </form>
            </SectionCard>
          ) : null}

          <SectionCard title="پرداخت‌ها و برگشت پرداخت" description="پرداخت‌ها با تاریخ و Party فیلتر و صفحه‌بندی می‌شوند؛ ماندهٔ خالص مستقل از صفحه محاسبه می‌شود." flush>
            <div className="grid gap-3 border-b border-border/70 p-4 sm:grid-cols-2 xl:grid-cols-4">
              <Field label="از تاریخ"><JalaliDatePicker value={paymentFilters.dateFrom} onChange={(value) => onPaymentFilterChange({ dateFrom: value })} ariaLabel="فیلتر پرداخت‌ها از تاریخ" /></Field>
              <Field label="تا تاریخ"><JalaliDatePicker value={paymentFilters.dateTo} onChange={(value) => onPaymentFilterChange({ dateTo: value })} ariaLabel="فیلتر پرداخت‌ها تا تاریخ" /></Field>
              <Field label="سهام‌دار"><SearchableSelect value={paymentFilters.partyId} onChange={(value) => onPaymentFilterChange({ partyId: value })} options={paymentPartyOptions} loading={paymentPartySearchBusy} onQueryChange={searchPaymentParties} placeholder="همهٔ اشخاص" ariaLabel="فیلتر پرداخت‌ها بر اساس سهام‌دار" /></Field>
              <Field label="نوع ثبت"><select className={inputClass} value={paymentFilters.paymentType} onChange={(event) => onPaymentFilterChange({ paymentType: event.target.value })}><option value="">پرداخت و برگشت</option><option value="payment">پرداخت</option><option value="reversal">برگشت</option></select></Field>
              <div className="sm:col-span-2 xl:col-span-4 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
                <span>تعداد: <strong className="text-foreground">{toPersianDigits(String(paymentPage?.totalCount ?? 0))}</strong></span>
                <span>خالص پرداخت: <strong className="text-foreground">{formatBalance(money, paymentPage?.netPaidRial ?? "0")}</strong></span>
              </div>
            </div>
            <ErrorBox>{paymentError}</ErrorBox>
            {paymentLoading ? <LoadingSkeleton rows={2} compact label="در حال بارگذاری پرداخت‌ها" className="px-4 py-2" /> : null}
            {!paymentPage && paymentError ? <div className="p-4"><Button variant="outline" size="sm" onClick={onRetryPayments}>تلاش دوباره</Button></div> : null}
            {paymentPage?.totalCount === 0 && !paymentLoading ? <EmptyState title="پرداختی با این فیلتر ثبت نشده است">پس از ثبت توزیع در دفتر کل، پرداخت‌ها در این بخش ظاهر می‌شوند.</EmptyState> : null}
            {payments.length > 0 ? (
              <DataTable caption="پرداخت‌ها و برگشت‌های سود سهام‌داران">
                <DataTableHead><Th>تاریخ</Th><Th>سهام‌دار</Th><Th>نوع</Th><Th numeric>مبلغ</Th><Th>حساب پرداخت</Th><Th>سند دفتر کل</Th><Th>عملیات</Th></DataTableHead>
                <DataTableBody>{payments.map((payment) => (
                  <DataTableRow key={payment.id}>
                    <Td nowrap>{dateLabel(payment.paidOn)}</Td><Td>{payment.partyName}</Td><Td>{payment.paymentType === "payment" ? "پرداخت" : "برگشت"}</Td><Td numeric>{formatBalance(money, payment.amountRial)}</Td><Td>{payment.paymentAccountName}</Td><Td><Link className="text-primary underline-offset-4 hover:underline" href={journalHref(payment.journalEntryId)}>{payment.journalVoucher ? `سند ${toPersianDigits(payment.journalVoucher)}` : "مشاهدهٔ سند"}</Link></Td><Td>{payment.paymentType === "payment" && permissions.reverse && !payment.isReversed && selected.status !== "reversed" && selected.status !== "cancelled" ? <Button variant="outline" size="sm" disabled={busy} onClick={() => onConfirm({ title: "برگشت پرداخت سهام‌دار؟", description: "مبلغ به حساب توزیع پرداختنی برمی‌گردد؛ پرداخت اصلی و سند قبلی دست‌نخورده می‌مانند.", confirmLabel: "ثبت برگشت پرداخت", run: async () => { await onAction(`${WORKSPACE_URL}/distributions/payments/${payment.id}/reverse`, "POST", { idempotencyKey: idempotencyKey("shareholder-payment-reversal") }, "برگشت پرداخت با سند آینه ثبت شد."); } })}>برگشت پرداخت</Button> : payment.paymentType === "reversal" ? <StatusBadge tone="neutral">برگشت</StatusBadge> : payment.isReversed ? <StatusBadge tone="neutral">برگشت‌شده</StatusBadge> : "—"}</Td>
                  </DataTableRow>
                ))}</DataTableBody>
              </DataTable>
            ) : null}
            <CursorPagination
              totalCount={paymentPage?.totalCount ?? 0}
              limit={paymentPage?.limit ?? 25}
              hasMore={paymentPage?.hasMore ?? false}
              loading={paymentLoading}
              canPrevious={canPreviousPaymentPage}
              onPrevious={onPreviousPaymentPage}
              onNext={onNextPaymentPage}
            />
          </SectionCard>
        </>
      ) : null}
    </div>
  );
}

function FiscalYearDistributionReconciliation({ rows, money }: { rows: ShareholderFiscalYearReconciliationRow[]; money: ReturnType<typeof useMoney> }) {
  return (
    <SectionCard title="تطبیق تقسیم سود با نتیجهٔ سال بسته‌شده" description="سود نگه‌داشته‌شده از GL و بدهی تخصیص‌شدهٔ پرداخت‌نشده دو ماندهٔ جدا هستند؛ اختلاف سندها و GL آشکار نمایش داده می‌شود." flush>
      {rows.length === 0 ? <EmptyState title="سال مالی بسته‌شده برای تطبیق وجود ندارد">تطبیق پس از ثبت سند اختتامیه در دفتر کل نمایش داده می‌شود.</EmptyState> : (
        <DataTable caption="تطبیق توزیع سود هر سال مالی بسته‌شده">
          <DataTableHead><Th>سال مالی</Th><Th>سند اختتامیه</Th><Th numeric>سود مبنا</Th><Th numeric>تخصیص در GL</Th><Th numeric>سود نگه‌داشته‌شده</Th><Th numeric>در دسترس برای تخصیص</Th><Th numeric>بدهی پرداخت‌نشدهٔ GL</Th><Th numeric>اختلاف تخصیص / بدهی</Th></DataTableHead>
          <DataTableBody>{rows.map((row) => {
            const balanced = row.distributionVarianceRial === "0" && row.payableVarianceRial === "0";
            return <DataTableRow key={row.fiscalYearId}>
              <Td>{row.fiscalYearLabel}</Td>
              <Td><Link className="text-primary underline-offset-4 hover:underline" href={journalHref(row.closingEntryId)}>مشاهدهٔ سند</Link></Td>
              <Td numeric>{formatBalance(money, row.sourceProfitRial)}</Td>
              <Td numeric>{formatBalance(money, row.glDistributedRial)}</Td>
              <Td numeric>{formatBalance(money, row.undistributedRetainedProfitRial)}</Td>
              <Td numeric>{formatBalance(money, row.availableToAllocateRial)}</Td>
              <Td numeric>{formatBalance(money, row.glUnpaidRial)}</Td>
              <Td numeric><StatusBadge tone={balanced ? "positive" : "danger"}>{balanced ? "تطبیق" : `اختلاف ${formatBalance(money, row.distributionVarianceRial)} / ${formatBalance(money, row.payableVarianceRial)}`}</StatusBadge></Td>
            </DataTableRow>;
          })}</DataTableBody>
        </DataTable>
      )}
    </SectionCard>
  );
}

function DetailValue({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0 rounded-xl border border-border/70 bg-muted/20 p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 truncate text-sm font-medium" title={typeof children === "string" ? children : undefined}>{children}</div></div>;
}

function ReconciliationPanel({ workspace, money }: { workspace: ShareholderWorkspace; money: ReturnType<typeof useMoney> }) {
  const balanced = workspace.glReconciliation.every((row) => row.unattributedBalanceRial === "0");
  const download = () => {
    const rows = [
      ["کد حساب", "نام حساب", "نوع", "بدهکار", "بستانکار", "مانده دفتر کل", "مانده منتسب به سهام‌دار", "ماندهٔ بدون انتساب"],
      ...workspace.glReconciliation.map((row) => [row.accountCode, row.accountName, row.accountType, row.debitRial, row.creditRial, row.ledgerBalanceRial, row.attributedBalanceRial, row.unattributedBalanceRial]),
    ];
    downloadCsv("shareholder-gl-reconciliation.csv", rows);
  };
  return (
    <div className="space-y-4">
      <InfoBox>{balanced ? "برای همهٔ سرفصل‌های نمایش‌داده‌شده، ماندهٔ دفتر کل و ماندهٔ منتسب به Party تطبیق دارد." : "ماندهٔ بدون انتساب نشان می‌دهد چه مقدار از ماندهٔ حساب در خطوط دفتر کل به هیچ سهام‌دار منتسب نیست؛ پیش از بستن گزارش آن را بررسی کنید."}</InfoBox>
      <SectionCard title="تطبیق سرفصل‌های سهام‌داری با دفتر کل" description="مبالغ از journal_lines و حساب‌های ۳۱۰۰، ۳۱۵۰، ۳۲۰۰، ۲۵۱۰، ۲۵۲۰ و ۳۸۰۰ استخراج می‌شوند؛ ستونِ بدون انتساب اختلاف قابل پیگیری را نشان می‌دهد." actions={<Button variant="outline" size="sm" onClick={download}><DownloadIcon className="size-4" aria-hidden="true" /> خروجی CSV</Button>} flush>
        {workspace.glReconciliation.length === 0 ? <EmptyState title="حساب مرتبطی در سرفصل‌ها پیدا نشد">قالب حسابداری باید حساب‌های سهام‌داری را داشته باشد؛ جدول سرفصل‌ها را بررسی کنید.</EmptyState> : (
          <DataTable caption="تطبیق ماندهٔ حساب‌های سهام‌داری با دفتر کل">
            <DataTableHead><Th>کد</Th><Th>حساب</Th><Th>نوع</Th><Th numeric>بدهکار</Th><Th numeric>بستانکار</Th><Th numeric>ماندهٔ دفتر کل</Th><Th numeric>ماندهٔ منتسب</Th><Th numeric>بدون انتساب</Th></DataTableHead>
            <DataTableBody>{workspace.glReconciliation.map((row) => <DataTableRow key={row.accountCode}><Td>{toPersianDigits(row.accountCode)}</Td><Td>{row.accountName}</Td><Td>{row.accountType === "equity" ? "حقوق صاحبان سهام" : row.accountType === "liability" ? "بدهی" : row.accountType === "asset" ? "دارایی" : row.accountType}</Td><Td numeric>{formatBalance(money, row.debitRial)}</Td><Td numeric>{formatBalance(money, row.creditRial)}</Td><Td numeric>{formatBalance(money, row.ledgerBalanceRial)}</Td><Td numeric>{formatBalance(money, row.attributedBalanceRial)}</Td><Td numeric className={row.unattributedBalanceRial === "0" ? "text-emerald-700 dark:text-emerald-300" : "text-amber-800 dark:text-amber-200"}>{formatBalance(money, row.unattributedBalanceRial)}</Td></DataTableRow>)}</DataTableBody>
          </DataTable>
        )}
      </SectionCard>
      <SectionCard title="مانده‌های منتسب به هر سهام‌دار" description="این خلاصه نیز از خطوط GL با party_id ساخته شده است، نه از یک تراز موازی.»" flush>
        <ShareholderBalanceTable rows={workspace.shareholderBalances} money={money} />
      </SectionCard>
      <ShareholderAccountStatementPanel workspace={workspace} money={money} />
    </div>
  );
}

function ShareholderAccountStatementPanel({ workspace, money }: { workspace: ShareholderWorkspace; money: ReturnType<typeof useMoney> }) {
  const [accountId, setAccountId] = useState("");
  const [partyId, setPartyId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [statement, setStatement] = useState<ShareholderAccountStatement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const accounts = useMemo(() => workspace.glReconciliation.map((row) => ({ value: row.accountId, label: `${row.accountCode} — ${row.accountName}` })), [workspace.glReconciliation]);
  const parties = useMemo(() => {
    const result = new Map<string, string>();
    for (const row of workspace.register) result.set(row.partyId, row.partyName);
    for (const row of workspace.shareholderBalances) result.set(row.partyId, row.partyName);
    return [...result].map(([value, name]) => ({ value, label: name, searchString: name }));
  }, [workspace.register, workspace.shareholderBalances]);

  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].value);
    else if (accountId && !accounts.some((option) => option.value === accountId)) setAccountId(accounts[0]?.value ?? "");
  }, [accountId, accounts]);

  const requestUrl = useMemo(() => {
    if (!accountId) return "";
    const params = new URLSearchParams({ limit: "50", offset: String(offset) });
    if (partyId) params.set("partyId", partyId);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    return `${WORKSPACE_URL}/accounts/${encodeURIComponent(accountId)}/statement?${params.toString()}`;
  }, [accountId, dateFrom, dateTo, offset, partyId]);

  useEffect(() => {
    if (!requestUrl) {
      setStatement(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api<ShareholderAccountStatement & { error?: string }>(requestUrl, { signal: controller.signal }).then(({ ok, data, aborted }) => {
      if (aborted) return;
      if (!ok) {
        setError(errorLabel(data.error));
        setStatement(null);
      } else setStatement(data);
      setLoading(false);
    });
    return () => controller.abort();
  }, [requestUrl, retry]);

  return (
    <SectionCard title="کارت حساب دفتر کل سهام‌داران" description="افتتاحیه و مانده‌های جاری از journal_lines محاسبه می‌شوند؛ گردش هر سند به تفکیک Party و تاریخ، با ماندهٔ جاری و پیوند به سند مبدأ نمایش داده می‌شود." flush>
      <div className="grid gap-3 border-b border-border/70 p-4 sm:grid-cols-2 xl:grid-cols-4">
        <Field label="سرفصل دفتر کل"><select className={inputClass} value={accountId} onChange={(event) => { setAccountId(event.target.value); setOffset(0); }}><option value="">انتخاب حساب…</option>{accounts.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>
        <Field label="طرف‌حساب / سهام‌دار"><SearchableSelect value={partyId} onChange={(value) => { setPartyId(value); setOffset(0); }} options={parties} placeholder="همهٔ اشخاص" ariaLabel="فیلتر کارت حساب بر اساس Party" /></Field>
        <Field label="از تاریخ"><JalaliDatePicker value={dateFrom} onChange={(value) => { setDateFrom(value); setOffset(0); }} ariaLabel="تاریخ شروع کارت حساب" /></Field>
        <Field label="تا تاریخ"><JalaliDatePicker value={dateTo} onChange={(value) => { setDateTo(value); setOffset(0); }} ariaLabel="تاریخ پایان کارت حساب" /></Field>
      </div>
      <ErrorBox>{error}</ErrorBox>
      {loading ? <LoadingSkeleton rows={3} compact label="در حال بارگذاری کارت حساب" className="px-4 py-2" /> : null}
      {!statement && error ? <div className="p-4"><Button variant="outline" size="sm" onClick={() => setRetry((current) => current + 1)}>تلاش دوباره</Button></div> : null}
      {!accountId && !loading ? <EmptyState title="سرفصل قابل نمایش نیست">حساب‌های سهام‌داری مرتبط در دفتر کل پیدا نشدند.</EmptyState> : null}
      {statement ? (
        <>
          <div className="grid gap-3 border-b border-border/70 p-4 sm:grid-cols-2 xl:grid-cols-4">
            <DetailValue label="ماندهٔ افتتاحیه">{formatBalance(money, statement.openingBalanceRial)}</DetailValue>
            <DetailValue label="جمع بدهکار دوره">{formatBalance(money, statement.totalDebitRial)}</DetailValue>
            <DetailValue label="جمع بستانکار دوره">{formatBalance(money, statement.totalCreditRial)}</DetailValue>
            <DetailValue label="ماندهٔ پایانی">{formatBalance(money, statement.closingBalanceRial)}</DetailValue>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 px-4 py-2 text-xs text-muted-foreground">
            <span>{statement.accountCode} — {statement.accountName}</span>
            <span>ماهیت عادی: {statement.normalBalance === "debit" ? "بدهکار" : "بستانکار"}</span>
            <span>تعداد سطرها: {toPersianDigits(String(statement.totalCount))}</span>
          </div>
          {statement.lines.length === 0 ? <EmptyState title="گردشی در این بازه پیدا نشد">ماندهٔ افتتاحیه در بالا نمایش داده شده است؛ تاریخ یا طرف‌حساب دیگری انتخاب کنید.</EmptyState> : (
            <DataTable caption="گردش روزانهٔ سرفصل دفتر کل سهام‌داران">
              <DataTableHead><Th>تاریخ</Th><Th>شماره سند / شرح</Th><Th>طرف‌حساب</Th><Th numeric>بدهکار</Th><Th numeric>بستانکار</Th><Th numeric>ماندهٔ جاری</Th><Th>منبع</Th></DataTableHead>
              <DataTableBody>{statement.lines.map((line) => <DataTableRow key={`${line.entryId}:${line.partyId ?? "none"}`}>
                <Td nowrap>{dateLabel(line.date)}</Td>
                <Td><div className="font-medium">{line.voucherNumber ? `سند ${toPersianDigits(line.voucherNumber)}` : "سند دفتر کل"}</div><div className="max-w-64 truncate text-xs text-muted-foreground" title={journalMemoForDisplay(line.memo, line.sourceType) ?? undefined}><bdi>{journalMemoForDisplay(line.memo, line.sourceType) ?? "—"}</bdi></div></Td>
                <Td>{line.partyName ?? "بدون انتساب"}</Td>
                <Td numeric>{formatBalance(money, line.debitRial)}</Td>
                <Td numeric>{formatBalance(money, line.creditRial)}</Td>
                <Td numeric>{formatBalance(money, line.balanceRial)}</Td>
                <Td><Link className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline" href={journalHref(line.entryId)}>مشاهدهٔ سند <ArrowUpRightIcon className="size-3.5" aria-hidden="true" /></Link><div className="text-xs text-muted-foreground">{line.sourceType ?? "manual"}</div></Td>
              </DataTableRow>)}</DataTableBody>
            </DataTable>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 p-3">
            <span className="text-xs text-muted-foreground">صفحهٔ {toPersianDigits(String(Math.floor(offset / statement.limit) + 1))} · {toPersianDigits(String(statement.totalCount))} سطر</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={loading || offset === 0} onClick={() => setOffset((current) => Math.max(0, current - (statement?.limit ?? 50)))}>قبلی</Button>
              <Button variant="outline" size="sm" disabled={loading || statement.nextOffset === null} onClick={() => { if (statement.nextOffset !== null) setOffset(statement.nextOffset); }}>بعدی</Button>
            </div>
          </div>
        </>
      ) : null}
    </SectionCard>
  );
}

function HistoryFilters({
  filters,
  categoryOptions = false,
  forcedCategory,
  partyOptions,
  partiesLoading,
  searchParties,
  onChange,
}: {
  filters: ShareholderHistoryFilters;
  categoryOptions?: boolean;
  forcedCategory?: "ownership" | "capital";
  partyOptions: SelectOption[];
  partiesLoading: boolean;
  searchParties: (query: string) => void;
  onChange: (patch: Partial<ShareholderHistoryFilters>) => void;
}) {
  const category = forcedCategory ?? filters.category;
  const eventOptions = [
    { value: "shareholder_added", label: EVENT_LABELS.shareholder_added, category: "ownership" },
    { value: "ownership_changed", label: EVENT_LABELS.ownership_changed, category: "ownership" },
    { value: "shareholder_removed", label: EVENT_LABELS.shareholder_removed, category: "ownership" },
    { value: "ownership_transfer_out", label: EVENT_LABELS.ownership_transfer_out, category: "ownership" },
    { value: "ownership_transfer_in", label: EVENT_LABELS.ownership_transfer_in, category: "ownership" },
    { value: "capital_contribution", label: EVENT_LABELS.capital_contribution, category: "capital" },
    { value: "capital_withdrawal", label: EVENT_LABELS.capital_withdrawal, category: "capital" },
    { value: "capital_reversal", label: EVENT_LABELS.capital_reversal, category: "capital" },
  ].filter((option) => !category || option.category === category);
  return (
    <div className="grid gap-3 border-b border-border/70 p-4 sm:grid-cols-2 xl:grid-cols-5">
      <Field label="از تاریخ"><JalaliDatePicker value={filters.dateFrom} onChange={(value) => onChange({ dateFrom: value })} ariaLabel="فیلتر تاریخچه از تاریخ" /></Field>
      <Field label="تا تاریخ"><JalaliDatePicker value={filters.dateTo} onChange={(value) => onChange({ dateTo: value })} ariaLabel="فیلتر تاریخچه تا تاریخ" /></Field>
      <Field label="Party / سهام‌دار"><SearchableSelect value={filters.partyId} onChange={(value) => onChange({ partyId: value })} options={partyOptions} loading={partiesLoading} onQueryChange={searchParties} placeholder="همهٔ اشخاص" ariaLabel="فیلتر تاریخچه بر اساس Party" /></Field>
      {categoryOptions ? <Field label="دستهٔ رویداد"><select className={inputClass} value={filters.category} onChange={(event) => onChange({ category: event.target.value, eventType: "" })}><option value="">همهٔ رویدادها</option><option value="ownership">مالکیت</option><option value="capital">سرمایه</option></select></Field> : null}
      <Field label="نوع رویداد"><select className={inputClass} value={filters.eventType} onChange={(event) => onChange({ eventType: event.target.value })}><option value="">همهٔ انواع</option>{eventOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>
    </div>
  );
}

function CursorPagination({
  totalCount,
  limit,
  hasMore,
  loading,
  canPrevious,
  onPrevious,
  onNext,
}: {
  totalCount: number;
  limit: number;
  hasMore: boolean;
  loading: boolean;
  canPrevious: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 p-3" aria-live="polite">
      <span className="text-xs text-muted-foreground">{toPersianDigits(String(totalCount))} نتیجه · حداکثر {toPersianDigits(String(limit))} سطر در هر صفحه</span>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled={loading || !canPrevious} onClick={onPrevious}>قبلی</Button>
        <Button type="button" variant="outline" size="sm" disabled={loading || !hasMore} onClick={onNext}>بعدی</Button>
      </div>
    </div>
  );
}

function EventHistoryTable({ events, money, canReverseCapital, onReverse }: { events: ShareholderEventRow[]; money: ReturnType<typeof useMoney>; canReverseCapital: boolean; onReverse: (event: ShareholderEventRow) => void }) {
  if (events.length === 0) return <EmptyState title="رویدادی ثبت نشده است">رویدادهای مالکیت و سرمایه پس از ثبت به این تاریخچه افزوده می‌شوند.</EmptyState>;
  return (
    <DataTable caption="تاریخچهٔ تغییرناپذیر مالکیت و سرمایهٔ سهام‌داران">
      <DataTableHead><Th>تاریخ</Th><Th>سهام‌دار</Th><Th>رویداد</Th><Th numeric>مالکیت پس از رویداد</Th><Th numeric>مبلغ</Th><Th>دلیل / مرجع</Th><Th>سند</Th><Th>عملیات</Th></DataTableHead>
      <DataTableBody>{events.map((event) => <DataTableRow key={event.id}><Td nowrap>{dateLabel(event.effectiveOn)}</Td><Td>{event.partyName}</Td><Td>{EVENT_LABELS[event.eventType] ?? event.eventType}</Td><Td numeric>{percentLabel(event.ownershipPercent)}</Td><Td numeric>{event.amountRial ? formatBalance(money, event.amountRial) : "—"}</Td><Td className="max-w-64 truncate" title={[event.reason, event.sourceReference].filter(Boolean).join(" · ")}>{[event.reason, event.sourceReference].filter(Boolean).join(" · ") || "—"}</Td><Td>{event.journalEntryId ? <Link className="text-primary underline-offset-4 hover:underline" href={journalHref(event.journalEntryId)}>{event.journalVoucher ? `سند ${toPersianDigits(event.journalVoucher)}` : "مشاهده"}</Link> : "—"}</Td><Td>{canReverseCapital && event.amountRial && ["capital_contribution", "capital_withdrawal"].includes(event.eventType) && !event.reversesEventId && !event.isReversed ? <Button variant="outline" size="sm" onClick={() => onReverse(event)}>برگشت سرمایه</Button> : event.isReversed ? <StatusBadge tone="neutral">برگشت‌شده</StatusBadge> : event.reversesEventId ? <StatusBadge tone="neutral">رویداد برگشت</StatusBadge> : "—"}</Td></DataTableRow>)}</DataTableBody>
    </DataTable>
  );
}

function downloadCsv(filename: string, rows: readonly (readonly string[])[]) {
  const content = `\uFEFF${rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n")}`;
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
