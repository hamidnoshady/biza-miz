"use client";

/**
 * «اسناد و شماره‌گذاری» — the voucher register and its numbering (issue
 * #867).
 *
 * Every posted document wears one stable fiscal-year number (RJ/MJ/OP/SV —
 * one book per source kind, one sequence per book per year). This screen is
 * the register by number, the gap report, the privileged renumber (with its
 * audit trail) and the summary vouchers — aggregate documents over a defined
 * source set that never touch the journal detail.
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import printStyles from "./vouchers-print.module.css";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  VOUCHER_DOCUMENT_TYPES,
  VOUCHER_DOCUMENT_TYPE_SPECS,
  voucherNumberDisplay,
  voucherNumberFor,
  type VoucherDocumentType,
} from "@/lib/voucher-numbering";
import { ledgerSourceLabel } from "@/lib/ledger-source-labels";
import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import {
  api,
  ErrorBox,
  Field,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "@/app/dashboard/ui";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";

const rials = new Intl.NumberFormat("fa-IR");

interface RegisterRow {
  id: string;
  voucherNumber: string | null;
  sequenceNo: number | null;
  fiscalYearLabel: string;
  documentType: VoucherDocumentType;
  voucherReference: string | null;
  entryDate: string;
  sourceType: string | null;
  sourceId: string | null;
  postingKind: string | null;
  memo: string | null;
  totalDebit: string;
  totalCredit: string;
  reversesEntryId: string | null;
  reversedAt: string | null;
  postedAt: string;
  createdByName: string | null;
}

interface RegisterPage {
  rows: RegisterRow[];
  nextCursor: { voucherNumber: string | null; entryDate: string; id: string } | null;
  total: number;
}

interface GapReport {
  documentType: VoucherDocumentType;
  fiscalYearLabel: string;
  presentCount: number;
  maxSequenceNo: number;
  gapCount: number;
  missing: number[];
  missingTruncated: boolean;
  counterMax: number;
}

interface RenumberLogRow {
  id: string;
  entryId: string;
  fiscalYearLabel: string;
  documentType: string;
  previousNumber: string | null;
  newNumber: string;
  reason: string;
  performedByName: string | null;
  createdAt: string;
}

interface SummaryVoucher {
  id: string;
  voucherNumber: string;
  label: string;
  scope: { entryIds?: string[]; sourceTypes?: string[]; from?: string; to?: string };
  entryCount: number;
  totalDebit: string;
  totalCredit: string;
  fiscalYearLabel: string;
  createdAt: string;
  createdByName: string | null;
}

interface SummarySource {
  journalEntryId: string;
  entryDate: string;
  sourceType: string | null;
  entryVoucherNumber: string | null;
  totalDebit: string;
  totalCredit: string;
}

/** The source kinds an accountant aggregates; the full table lives in ledger-source-labels. */
const SUMMARY_SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: "order", label: "فروش سفارش" },
  { value: "retail_invoice", label: "فاکتور فروش" },
  { value: "purchase", label: "خرید" },
  { value: "ar_receipt", label: "دریافت از مشتری" },
  { value: "ap_payment", label: "پرداخت به تأمین‌کننده" },
  { value: "cheque", label: "چک" },
  { value: "expense", label: "هزینه" },
  { value: "payroll_payment", label: "پرداخت حقوق" },
  { value: "fixed_asset_acquisition", label: "خرید دارایی ثابت" },
  { value: "fixed_asset_depreciation", label: "استهلاک دارایی ثابت" },
  { value: "manual", label: "سند دستی" },
];

function errorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    invalid_date: "تاریخ معتبر نیست.",
    invalid_cursor: "نشانهٔ صفحهٔ قبلی نامعتبر است؛ فهرست را از اول باز کنید.",
    unknown_document_type: "نوع دفتر شناخته‌شده نیست.",
    invalid_fiscal_year_label: "سال مالی باید چهار رقم باشد.",
    invalid_sequence: "شمارهٔ ترتیب باید عدد صحیح مثبت باشد.",
    reason_required: "دلیل شماره‌گذاری دوباره الزامی است (تا ۵۰۰ حرف).",
    voucher_reference_invalid: "شمارهٔ مرجع فقط حرف، عدد و . _ / - می‌خواهد (تا ۶۴ حرف).",
    entry_not_found: "سند یافت نشد؛ فهرست را دوباره بارگذاری کنید.",
    entry_not_numbered: "این سند هنوز شماره ندارد؛ فهرست را دوباره بارگذاری کنید.",
    voucher_number_taken: "این شماره در همان دفتر و سال مشغول است؛ شماره دیگری انتخاب کنید.",
    label_required: "عنوان سند خلاصه الزامی است (تا ۲۰۰ حرف).",
    invalid_idempotency_key: "کلید تکرارشوندگی نامعتبر است.",
    scope_invalid: "دامنه باید مجموعهٔ مشخصی از اسناد را تعریف کند (منبع یا بازهٔ تاریخ).",
    scope_empty: "هیچ سندی با این فیلترها نیست.",
    scope_not_balanced: "مجموع اسندِ انتخاب‌شده برابرسند نیست؛ دامنه را بررسی کنید.",
    entries_already_summarised:
      "چند سند انتخاب‌شده از قبل در یک سند خلاصه دیگر جا گرفته‌اند؛ هر سند فقط یک بار خلاصه می‌شود.",
    idempotency_conflict: "این کلید تکرارشوندگی پیش‌تر برای مجموعهٔ دیگری استفاده شده است.",
    summary_voucher_not_found: "سند خلاصه یافت نشد.",
    unauthorized: "وارد نشده‌اید.",
    forbidden: "دسترسی مجاز نیست.",
    bad_request: "درخواست نامعتبر بود.",
    request_failed: "ارتباط با سرور برقرار نشد. اتصال را بررسی و دوباره تلاش کنید.",
  };
  return map[code ?? ""] ?? "خطای غیرمنتظره رخ داد. دوباره تلاش کنید.";
}

export function VouchersSection({
  busy,
  refreshKey,
  canApprove,
}: {
  busy: boolean;
  refreshKey: number;
  /** `ledger.approve` — the renumber half of the numbering (privileged). */
  canApprove: boolean;
}) {
  // ------------------------------------------------------------ the register
  const [rows, setRows] = useState<RegisterRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<RegisterPage["nextCursor"]>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState<"csv" | "xlsx" | null>(null);
  const [book, setBook] = useState<"all" | VoucherDocumentType>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");

  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mutation, setMutation] = useState<string | null>(null);
  const isMutating = busy || mutation !== null;

  // The print sheet is portalled onto <body>; there is no body to portal onto
  // during the server render, and on screen the sheet stays display:none.
  const [portalReady, setPortalReady] = useState(false);
  useEffect(() => {
    setPortalReady(true);
  }, []);

  // ----------------------------------------------------------------- renumber
  const [renumberTarget, setRenumberTarget] = useState<RegisterRow | null>(null);
  const [newSequence, setNewSequence] = useState("");
  const [newReference, setNewReference] = useState("");
  const [renumberReason, setRenumberReason] = useState("");

  // ------------------------------------------------------------ gap report
  const [gapYear, setGapYear] = useState("");
  const [gapBook, setGapBook] = useState<VoucherDocumentType>("journal");
  const [gapReport, setGapReport] = useState<GapReport | null>(null);

  // ------------------------------------------------------------- renumber log
  const [renumberLog, setRenumberLog] = useState<RenumberLogRow[] | null>(null);

  // --------------------------------------------------------- summary vouchers
  const [summaries, setSummaries] = useState<SummaryVoucher[] | null>(null);
  const [summaryLabel, setSummaryLabel] = useState("");
  const [summarySource, setSummarySource] = useState("");
  const [summaryFrom, setSummaryFrom] = useState("");
  const [summaryTo, setSummaryTo] = useState("");
  const [openSummaryId, setOpenSummaryId] = useState<string | null>(null);
  const [summaryDetail, setSummaryDetail] = useState<(SummaryVoucher & { sources: SummarySource[] }) | null>(null);

  function filterParams(target: URLSearchParams) {
    if (book !== "all") target.set("documentType", book);
    if (from) target.set("from", from);
    if (to) target.set("to", to);
    if (search.trim()) target.set("search", search.trim());
  }

  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    const params = new URLSearchParams();
    filterParams(params);
    api<RegisterPage>(`/api/ledger/vouchers?${params}`)
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (!ok) {
          setLoadFailed(true);
          setRows((current) => current ?? []);
          return;
        }
        setRows(data.rows);
        setNextCursor(data.nextCursor);
        setTotal(data.total);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadFailed(true);
        setRows((current) => current ?? []);
      });
    return () => {
      cancelled = true;
    };
    // The register reloads on the manager's refresh and on its own filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, book, from, to, search]);

  useEffect(() => {
    let cancelled = false;
    api<RenumberLogRow[]>("/api/ledger/vouchers/renumber-log")
      .then(({ ok, data }) => {
        if (!cancelled && ok) setRenumberLog(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    api<SummaryVoucher[]>("/api/ledger/summary-vouchers")
      .then(({ ok, data }) => {
        if (!cancelled && ok) setSummaries(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    setSummaryDetail(null);
    if (!openSummaryId) return () => {
      cancelled = true;
    };
    api<SummaryVoucher & { sources: SummarySource[] }>(`/api/ledger/summary-vouchers/${openSummaryId}`)
      .then(({ ok, data }) => {
        if (!cancelled && ok) setSummaryDetail(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [openSummaryId]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const params = new URLSearchParams();
      filterParams(params);
      params.set("cursor", JSON.stringify(nextCursor));
      const { ok, data } = await api<RegisterPage & { error?: string }>(`/api/ledger/vouchers?${params}`);
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      setRows((current) => [...(current ?? []), ...data.rows]);
      setNextCursor(data.nextCursor);
    } catch {
      setError(errorMessage("request_failed"));
    } finally {
      setLoadingMore(false);
    }
  }

  async function exportRegister(format: "csv" | "xlsx") {
    setExporting(format);
    setError("");
    try {
      const params = new URLSearchParams();
      filterParams(params);
      params.set("format", format);
      const res = await fetch(`/api/ledger/vouchers?${params}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(errorMessage(data.error));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `voucher-register.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError(errorMessage("request_failed"));
    } finally {
      setExporting(null);
    }
  }

  // ------------------------------------------------------------ print/PDF —
  // The sheet is the *complete* filtered register (the export's rule), not
  // just the pages loaded on screen, so printing walks the keyset to the end
  // — capped, with the sheet saying when it stopped.
  const PRINT_CAP = 2000;
  const [printData, setPrintData] = useState<{
    rows: RegisterRow[];
    total: number;
    truncated: boolean;
  } | null>(null);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    if (!printData) return;
    // Let the portal paint before the dialog opens, then hand over to the
    // browser's print/PDF and clear the sheet when it closes.
    const timer = window.setTimeout(() => window.print(), 60);
    const clear = () => setPrintData(null);
    window.addEventListener("afterprint", clear);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", clear);
    };
  }, [printData]);

  async function printRegister() {
    if (printing) return;
    setPrinting(true);
    setError("");
    try {
      const rows: RegisterRow[] = [];
      let total = 0;
      let cursor: RegisterPage["nextCursor"] = null;
      for (let page = 0; page < 40 && rows.length < PRINT_CAP; page++) {
        const params = new URLSearchParams();
        filterParams(params);
        params.set("limit", "50");
        if (cursor) params.set("cursor", JSON.stringify(cursor));
        const res = await fetch(`/api/ledger/vouchers?${params}`);
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(errorMessage(data.error));
          return;
        }
        const data: RegisterPage = await res.json();
        total = data.total;
        rows.push(...data.rows);
        cursor = data.nextCursor;
        if (!cursor) break;
      }
      setPrintData({ rows: rows.slice(0, PRINT_CAP), total, truncated: rows.length >= PRINT_CAP && cursor !== null });
    } catch {
      setError(errorMessage("request_failed"));
    } finally {
      setPrinting(false);
    }
  }

  async function loadGapReport() {
    setError("");
    setGapReport(null);
    const { ok, data } = await api<GapReport & { error?: string }>(
      `/api/ledger/vouchers/gaps?fiscalYearLabel=${encodeURIComponent(gapYear)}&documentType=${gapBook}`,
    );
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setGapReport(data);
  }

  function openRenumber(row: RegisterRow) {
    setRenumberTarget(row);
    setNewSequence(String(row.sequenceNo ?? ""));
    setNewReference(row.voucherReference ?? "");
    setRenumberReason("");
  }

  async function confirmRenumber() {
    if (!renumberTarget || isMutating) return;
    const sequence = Number(newSequence);
    if (!Number.isInteger(sequence) || sequence < 1) {
      setError(errorMessage("invalid_sequence"));
      return;
    }
    setMutation("renumber");
    setError("");
    try {
      const { ok, data } = await api<{ error?: string }>(`/api/ledger/vouchers/renumber`, {
        method: "POST",
        body: JSON.stringify({
          entryId: renumberTarget.id,
          newSequenceNo: sequence,
          newReference: newReference.trim() || null,
          reason: renumberReason,
        }),
      });
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      setRenumberTarget(null);
      setNotice("شمارهٔ سند تغییر کرد و در دفتر شماره‌گذاری ثبت شد.");
      setRows(null);
      setRenumberLog(null);
      setSummaries(null);
      bumpRefresh();
    } catch {
      setError(errorMessage("request_failed"));
    } finally {
      setMutation(null);
    }
  }

  async function generateSummary() {
    if (isMutating) return;
    const scope: { sourceTypes?: string[]; from?: string; to?: string } = {};
    if (summarySource) scope.sourceTypes = [summarySource];
    if (summaryFrom) scope.from = summaryFrom;
    if (summaryTo) scope.to = summaryTo;
    setMutation("summary");
    setError("");
    try {
      const { ok, data } = await api<{ error?: string }>(`/api/ledger/summary-vouchers`, {
        method: "POST",
        body: JSON.stringify({ label: summaryLabel, scope }),
      });
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      setSummaryLabel("");
      setNotice("سند خلاصه ساخته شد؛ اسناد پایه دست‌نخورده ماندند.");
      setSummaries(null);
      bumpRefresh();
    } catch {
      setError(errorMessage("request_failed"));
    } finally {
      setMutation(null);
    }
  }

  function toggleSummary(id: string) {
    setOpenSummaryId((current) => (current === id ? null : id));
  }

  // The manager owns the refreshKey; these reloads ask the API directly.
  function bumpRefresh() {
    void api<RegisterPage>("/api/ledger/vouchers").then(({ ok, data }) => {
      if (ok) {
        setRows(data.rows);
        setNextCursor(data.nextCursor);
        setTotal(data.total);
      }
    });
    void api<RenumberLogRow[]>("/api/ledger/vouchers/renumber-log").then(({ ok, data }) => {
      if (ok) setRenumberLog(data);
    });
    void api<SummaryVoucher[]>("/api/ledger/summary-vouchers").then(({ ok, data }) => {
      if (ok) setSummaries(data);
    });
  }

  // What the register's print sheet answers for: the filters it was read with.
  const registerFilterLabel = useMemo(() => {
    const parts: string[] = [];
    if (book !== "all") parts.push(VOUCHER_DOCUMENT_TYPE_SPECS[book].label);
    if (from || to) parts.push(`${from ? formatJalali(from) : "آغاز"} تا ${to ? formatJalali(to) : "اکنون"}`);
    if (search.trim()) parts.push(`جست‌وجو: «${search.trim()}»`);
    return parts.length ? parts.join(" — ") : "همهٔ اسناد ثبت‌شده";
  }, [book, from, to, search]);

  const summaryScopeLabel = useMemo(() => {
    if (!summaryDetail) return "";
    const parts: string[] = [];
    if (summaryDetail.scope.sourceTypes?.length) {
      parts.push(summaryDetail.scope.sourceTypes.map((s) => ledgerSourceLabel(s)).join("، "));
    }
    if (summaryDetail.scope.from || summaryDetail.scope.to) {
      parts.push(
        `${summaryDetail.scope.from ? formatJalali(summaryDetail.scope.from) : "آغاز"} تا ${summaryDetail.scope.to ? formatJalali(summaryDetail.scope.to) : "اکنون"}`,
      );
    }
    if (summaryDetail.scope.entryIds?.length) parts.push(`${toPersianDigits(summaryDetail.scope.entryIds.length)} سند مشخص‌شده`);
    return parts.join(" — ");
  }, [summaryDetail]);

  return (
    <section className="space-y-4" aria-label="اسناد و شماره‌گذاری">
      <ErrorBox>{error}</ErrorBox>
      <ErrorBox>{loadFailed ? "بارگذاری دفتر اسناد ناموفق بود." : ""}</ErrorBox>
      {notice ? (
        <p role="status" className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm leading-6 text-foreground">
          {notice}
        </p>
      ) : null}

      {/* ------------------------------------------------------------- register */}
      <SectionCard
        title="دفتر اسناد"
        description="هر سند ثبت‌شده با شمارهٔ پایدار سال مالی‌اش (دفتر روزنامه RJ، سند دستی MJ، افتتاحیه OP، خلاصه SV)، مرتب به شماره — با امکان فیلتر به دفتر، منبع و تاریخ."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isMutating || !rows || rows.length === 0}
              onClick={() => void exportRegister("csv")}
            >
              {exporting === "csv" ? "در حال تهیه…" : "خروجی CSV"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isMutating || !rows || rows.length === 0}
              onClick={() => void exportRegister("xlsx")}
            >
              {exporting === "xlsx" ? "در حال تهیه…" : "خروجی اکسل"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isMutating || !rows || rows.length === 0 || printing}
              onClick={() => void printRegister()}
            >
              {printing ? "در حال تهیه…" : "چاپ / PDF"}
            </Button>
          </div>
        }
      >
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="دفتر">
            <select className={inputClass} value={book} onChange={(event) => setBook(event.target.value as never)}>
              <option value="all">همهٔ دفاتر</option>
              {VOUCHER_DOCUMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {VOUCHER_DOCUMENT_TYPE_SPECS[type].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="از تاریخ">
            <input className={inputClass} type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="تا تاریخ">
            <input className={inputClass} type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          <Field label="جست‌وجو" hint="در شرح و شمارهٔ مرجع">
            <input
              className={inputClass}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="مثلاً «بابت…»"
            />
          </Field>
        </div>

        {rows === null ? (
          <LoadingSkeleton rows={5} label="در حال بارگذاری دفتر اسناد" />
        ) : rows.length === 0 ? (
          <EmptyState>سندی با این فیلترها نیست؛ فیلترها را کم کنید.</EmptyState>
        ) : (
          <>
            <DataTable caption="دفتر اسناد به ترتیب شماره" className="hidden lg:block">
              <DataTableHead>
                <Th>شماره سند</Th>
                <Th>دفتر</Th>
                <Th>تاریخ</Th>
                <Th>منبع</Th>
                <Th>شرح</Th>
                <Th>جمع</Th>
                <Th>وضعیت</Th>
                {canApprove ? <Th>اقدام</Th> : null}
              </DataTableHead>
              <DataTableBody>
                {rows.map((row) => (
                  <DataTableRow key={row.id}>
                    <Td className="font-mono text-xs" dir="ltr">
                      {voucherNumberDisplay(row)}
                      {row.voucherReference ? (
                        <span className="block text-[10px] text-muted-foreground">{row.voucherReference}</span>
                      ) : null}
                    </Td>
                    <Td className="text-muted-foreground">{VOUCHER_DOCUMENT_TYPE_SPECS[row.documentType].label}</Td>
                    <Td className="text-muted-foreground">{formatJalali(row.entryDate)}</Td>
                    <Td className="text-muted-foreground">{ledgerSourceLabel(row.sourceType)}</Td>
                    <Td className="max-w-56 truncate" title={row.memo ?? ""}>
                      {row.memo ?? "—"}
                    </Td>
                    <Td className="text-muted-foreground">{toPersianDigits(rials.format(Number(row.totalDebit)))}</Td>
                    <Td>
                      {row.reversedAt ? (
                        <StatusBadge tone="danger">برگشته</StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">فعال</StatusBadge>
                      )}
                    </Td>
                    {canApprove ? (
                      <Td>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={isMutating}
                          onClick={() => openRenumber(row)}
                        >
                          شماره‌گذاری دوباره
                        </Button>
                      </Td>
                    ) : null}
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>

            <div className="space-y-2 lg:hidden">
              {rows.map((row) => (
                <article key={row.id} className="rounded-xl border border-border/80 bg-muted/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs" dir="ltr">
                      {voucherNumberDisplay(row)}
                    </span>
                    <StatusBadge tone={row.reversedAt ? "danger" : "neutral"}>
                      {row.reversedAt ? "برگشته" : "فعال"}
                    </StatusBadge>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {VOUCHER_DOCUMENT_TYPE_SPECS[row.documentType].label} — {formatJalali(row.entryDate)} —{" "}
                    {ledgerSourceLabel(row.sourceType)}
                  </p>
                  {row.memo ? <p className="mt-1 text-xs text-foreground">{row.memo}</p> : null}
                  <p className="mt-1 text-xs text-muted-foreground">
                    جمع {toPersianDigits(rials.format(Number(row.totalDebit)))}
                    {row.voucherReference ? ` — مرجع: ${row.voucherReference}` : ""}
                  </p>
                  {canApprove ? (
                    <div className="mt-2 border-t border-border pt-2">
                      <Button type="button" variant="outline" size="sm" disabled={isMutating} onClick={() => openRenumber(row)}>
                        شماره‌گذاری دوباره
                      </Button>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {total !== null ? `${toPersianDigits(rows.length)} از ${toPersianDigits(total)} سند` : `${toPersianDigits(rows.length)} سند`}
              </p>
              {nextCursor ? (
                <SecondaryButton disabled={loadingMore || isMutating} onClick={() => void loadMore()}>
                  {loadingMore ? "در حال بارگذاری…" : "بیشتر"}
                </SecondaryButton>
              ) : null}
            </div>
          </>
        )}
      </SectionCard>

      {/* ------------------------------------------------------------- gaps */}
      <SectionCard
        title="گزارش شماره‌های جا افتاده"
        description="شماره‌هایی که کنتور هر دفتر در هر سال جلو رفته اما هیچ سندی با آن‌ها ثبت نشده — اثر اسناد باطل‌شده یا شماره‌گذاری دوباره."
      >
        <div className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-end">
          <Field label="سال مالی" hint="چهار رقم">
            <input
              className={inputClass}
              inputMode="numeric"
              maxLength={4}
              value={gapYear}
              onChange={(event) => setGapYear(event.target.value.replace(/\D/g, ""))}
              placeholder="۱۴۰۴"
            />
          </Field>
          <Field label="دفتر">
            <select className={inputClass} value={gapBook} onChange={(event) => setGapBook(event.target.value as VoucherDocumentType)}>
              {VOUCHER_DOCUMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {VOUCHER_DOCUMENT_TYPE_SPECS[type].label}
                </option>
              ))}
            </select>
          </Field>
          <div className="w-full sm:w-[10rem]">
            <PrimaryButton
              type="button"
              disabled={isMutating || gapYear.length !== 4}
              onClick={() => void loadGapReport()}
            >
              گزارش
            </PrimaryButton>
          </div>
        </div>

        {gapReport ? (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap gap-2">
              <StatusBadge tone={gapReport.gapCount === 0 ? "positive" : "active"} dot>
                {gapReport.gapCount === 0
                  ? "زنجیرهٔ شماره‌ها بی‌درز است"
                  : `${toPersianDigits(gapReport.gapCount)} شماره جا افتاده`}
              </StatusBadge>
              <span className="text-xs text-muted-foreground">
                {toPersianDigits(gapReport.presentCount)} سند ثبت‌شده — بیشترین شمارهٔ کنتور: {toPersianDigits(gapReport.counterMax)}
              </span>
            </div>
            {gapReport.missing.length > 0 ? (
              <p className="max-h-32 overflow-y-auto rounded-xl border border-border/80 bg-muted/40 p-3 font-mono text-xs leading-6 text-foreground" dir="ltr">
                {gapReport.missing.map((n) => `${VOUCHER_DOCUMENT_TYPE_SPECS[gapReport.documentType].prefix}-${gapReport.fiscalYearLabel}-${String(n).padStart(6, "0")}`).join("  ")}
                {gapReport.missingTruncated ? `  … و ${toPersianDigits(gapReport.gapCount - gapReport.missing.length)} شمارهٔ دیگر` : ""}
              </p>
            ) : null}
          </div>
        ) : null}
      </SectionCard>

      {/* ------------------------------------------------------- summary vouchers */}
      <SectionCard
        title="اسناد خلاصه"
        description="سندِ جمع‌بندی روی یک مجموعهٔ مشخص از اسناد (مثلاً همهٔ دریافت‌های یک ماه) — با شمارهٔ خود از دفتر SV، با ردیف‌بندی به هر سند پایه. اسناد پایه هرگز دست نمی‌خورند و هر سند فقط در یک سند خلاصه جا می‌گیرد."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="عنوان" hint="تا ۲۰۰ حرف">
            <input className={inputClass} value={summaryLabel} maxLength={200} onChange={(event) => setSummaryLabel(event.target.value)} placeholder="مثلاً «دریافت‌های فروردین»" />
          </Field>
          <Field label="منبع اسناد">
            <select className={inputClass} value={summarySource} onChange={(event) => setSummarySource(event.target.value)}>
              <option value="">— انتخاب منبع —</option>
              {SUMMARY_SOURCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="از تاریخ">
            <input className={inputClass} type="date" value={summaryFrom} onChange={(event) => setSummaryFrom(event.target.value)} />
          </Field>
          <Field label="تا تاریخ">
            <input className={inputClass} type="date" value={summaryTo} onChange={(event) => setSummaryTo(event.target.value)} />
          </Field>
          <div className="flex items-end">
            <PrimaryButton
              type="button"
              disabled={isMutating || summaryLabel.trim().length === 0 || (!summarySource && !summaryFrom && !summaryTo)}
              onClick={() => void generateSummary()}
            >
              {mutation === "summary" ? "در حال ساخت…" : "ساخت سند خلاصه"}
            </PrimaryButton>
          </div>
        </div>

        {summaries === null ? (
          <LoadingSkeleton rows={2} compact label="در حال بارگذاری اسناد خلاصه" className="mt-4" />
        ) : summaries.length === 0 ? (
          <div className="mt-4">
            <EmptyState>هنوز سند خلاصه‌ای ساخته نشده است.</EmptyState>
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {summaries.map((summary) => (
              <div key={summary.id} className="rounded-xl border border-border/80 bg-muted/40">
                <button
                  type="button"
                  onClick={() => toggleSummary(summary.id)}
                  aria-expanded={openSummaryId === summary.id}
                  className="w-full px-4 py-3 text-right"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="font-mono text-xs" dir="ltr">
                        {summary.voucherNumber}
                      </span>
                      <span className="text-sm font-semibold text-foreground">{summary.label}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {toPersianDigits(summary.entryCount)} سند — {toPersianDigits(rials.format(Number(summary.totalDebit)))}
                      {summary.createdByName ? ` — ${summary.createdByName}` : ""}
                    </span>
                  </div>
                </button>
                {openSummaryId === summary.id ? (
                  <div className="border-t border-border/60 px-4 py-3">
                    {summaryDetail === null ? (
                      <LoadingSkeleton rows={2} compact label="در حال بارگذاری ردیف‌ها" />
                    ) : (
                      <>
                        <p className="mb-2 text-xs text-muted-foreground">{summaryScopeLabel}</p>
                        <div className="max-h-64 overflow-y-auto">
                          <table className="w-full min-w-[36rem] text-xs">
                            <thead>
                              <tr className="text-right text-muted-foreground">
                                <th className="pb-2 pr-2 font-medium">شماره سند پایه</th>
                                <th className="pb-2 pr-2 font-medium">تاریخ</th>
                                <th className="pb-2 pr-2 font-medium">منبع</th>
                                <th className="pb-2 pr-2 font-medium">جمع</th>
                              </tr>
                            </thead>
                            <tbody>
                              {summaryDetail.sources.map((source) => (
                                <tr key={source.journalEntryId} className="border-t border-border/60">
                                  <td className="py-2 pr-2 font-mono" dir="ltr">
                                    {source.entryVoucherNumber ?? "—"}
                                  </td>
                                  <td className="py-2 pr-2 text-muted-foreground">{formatJalali(source.entryDate)}</td>
                                  <td className="py-2 pr-2 text-muted-foreground">{ledgerSourceLabel(source.sourceType)}</td>
                                  <td className="py-2 pr-2 text-muted-foreground">
                                    {toPersianDigits(rials.format(Number(source.totalDebit)))}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* ------------------------------------------------------ renumber log */}
      <SectionCard
        title="دفتر شماره‌گذاری دوباره"
        description="هر شماره‌گذاری دوبارهٔ انجام‌شده، با شمارهٔ قبلی و جدید، دلیل و انجام‌دهنده — پیوسته، قابل بازبینی و قابل گزارش."
      >
        {renumberLog === null ? (
          <LoadingSkeleton rows={2} compact label="در حال بارگذاری" />
        ) : renumberLog.length === 0 ? (
          <EmptyState>هنوز شماره‌گذاری دوباره‌ای ثبت نشده است.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="text-right text-xs text-muted-foreground">
                  <th className="pb-2 pr-2 font-medium">تاریخ</th>
                  <th className="pb-2 pr-2 font-medium">شمارهٔ قبلی</th>
                  <th className="pb-2 pr-2 font-medium">شمارهٔ جدید</th>
                  <th className="pb-2 pr-2 font-medium">دلیل</th>
                  <th className="pb-2 pr-2 font-medium">انجام‌دهنده</th>
                </tr>
              </thead>
              <tbody>
                {renumberLog.map((row) => (
                  <tr key={row.id} className="border-t border-border/60">
                    <td className="py-2 pr-2 text-muted-foreground">{formatJalali(row.createdAt, { withTime: true })}</td>
                    <td className="py-2 pr-2 font-mono text-xs" dir="ltr">
                      {row.previousNumber ?? "—"}
                    </td>
                    <td className="py-2 pr-2 font-mono text-xs" dir="ltr">
                      {row.newNumber}
                    </td>
                    <td className="max-w-72 truncate py-2 pr-2" title={row.reason}>
                      {row.reason}
                    </td>
                    <td className="py-2 pr-2 text-muted-foreground">{row.performedByName ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* -------------------------------------------------------- renumber dialog */}
      <Dialog
        open={renumberTarget !== null}
        onOpenChange={(open) => {
          if (!open && !isMutating) setRenumberTarget(null);
        }}
      >
        {renumberTarget ? (
          <DialogContent showCloseButton={!isMutating}>
            <DialogHeader>
              <DialogTitle>شماره‌گذاری دوبارهٔ {voucherNumberDisplay(renumberTarget)}</DialogTitle>
              <DialogDescription>
                این کار تنها با مجوز تصمیم‌گیری ممکن است و همیشه در «دفتر شماره‌گذاری دوباره» ثبت می‌شود. شمارهٔ جدید در
                همان دفتر و همان سال مالی باید آزاد باشد.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="شمارهٔ ترتیب جدید" hint="در همان دفتر و سال مالی این سند">
                <input
                  className={inputClass}
                  inputMode="numeric"
                  value={newSequence}
                  onChange={(event) => setNewSequence(event.target.value.replace(/\D/g, ""))}
                />
              </Field>
              <Field label="شمارهٔ مرجع (اختیاری)" hint="مثلاً شمارهٔ سیستم قبلی؛ حرف، عدد و . _ / -">
                <input
                  className={inputClass}
                  dir="ltr"
                  maxLength={64}
                  value={newReference}
                  onChange={(event) => setNewReference(event.target.value)}
                />
              </Field>
            </div>
            <Field label="دلیل" hint="۱ تا ۵۰۰ حرف">
              <textarea
                className={`${inputClass} h-24 resize-none py-2`}
                maxLength={500}
                value={renumberReason}
                onChange={(event) => setRenumberReason(event.target.value)}
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={isMutating} onClick={() => setRenumberTarget(null)}>
                انصراف
              </Button>
              <Button
                type="button"
                disabled={
                  isMutating ||
                  newSequence.trim().length === 0 ||
                  Number(newSequence) < 1 ||
                  renumberReason.trim().length === 0
                }
                onClick={() => void confirmRenumber()}
              >
                {mutation === "renumber" ? "در حال ثبت…" : "تأیید شماره‌گذاری دوباره"}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>

      {portalReady && printData
        ? createPortal(
          <div id="print-sheet-root" className={printStyles.sheet} aria-hidden="true">
            <header>
              <h1>دفتر اسناد</h1>
              <p>{registerFilterLabel} — {toPersianDigits(String(printData.total))} سند در مجموع</p>
              <p>تاریخ تولید: {toPersianDigits(formatJalali(new Date(), { withMonthName: true }))}</p>
              {printData.truncated ? (
                <p>
                  {toPersianDigits(String(printData.rows.length))} ردیف اول چاپ شد؛ برای کل، خروجی CSV یا اکسل بگیرید.
                </p>
              ) : null}
            </header>
            <table>
              <thead>
                <tr>
                  <th>شماره سند</th>
                  <th>دفتر</th>
                  <th>تاریخ</th>
                  <th>منبع</th>
                  <th>شرح</th>
                  <th>بدهکار</th>
                  <th>بستانکار</th>
                  <th>مرجع</th>
                </tr>
              </thead>
              <tbody>
                {printData.rows.map((row) => (
                  <tr key={row.id}>
                    <td className={printStyles.num} dir="ltr">
                      {voucherNumberDisplay(row)}
                    </td>
                    <td>{VOUCHER_DOCUMENT_TYPE_SPECS[row.documentType].label}</td>
                    <td>{formatJalali(row.entryDate)}</td>
                    <td>{row.sourceType ? ledgerSourceLabel(row.sourceType) : "—"}</td>
                    <td>{row.memo ?? ""}</td>
                    <td className={printStyles.num}>{toPersianDigits(rials.format(Number(row.totalDebit)))}</td>
                    <td className={printStyles.num}>{toPersianDigits(rials.format(Number(row.totalCredit)))}</td>
                    <td className={printStyles.num}>{row.voucherReference ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {gapReport ? (
              <>
                <h2>
                  گزارش شکاف شماره‌گذاری — {VOUCHER_DOCUMENT_TYPE_SPECS[gapReport.documentType].label}{" "}
                  {toPersianDigits(gapReport.fiscalYearLabel)}
                </h2>
                <p>
                  {toPersianDigits(String(gapReport.presentCount))} شماره در کار — بیشترین شماره{" "}
                  {toPersianDigits(String(gapReport.maxSequenceNo))} —{" "}
                  {gapReport.gapCount === 0
                    ? "بدون شکاف"
                    : `${toPersianDigits(String(gapReport.gapCount))} شماره جا افتاده`}
                  {gapReport.missingTruncated ? " (فهرست ناپدیده‌ها بریده شده)" : ""}
                </p>
                {gapReport.missing.length > 0 ? (
                  <p>
                    شماره‌های ناپدیده:{" "}
                    {gapReport.missing
                      .map((n) => voucherNumberFor(gapReport.documentType, gapReport.fiscalYearLabel, n))
                      .join("، ")}
                  </p>
                ) : null}
              </>
            ) : null}

            {summaryDetail ? (
              <>
                <h2>
                  سند خلاصه {summaryDetail.voucherNumber} — {summaryDetail.label}
                </h2>
                <p>
                  {summaryScopeLabel || "دامنه مشخص‌شده"} — {toPersianDigits(String(summaryDetail.entryCount))} سند
                  پایه
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>شماره سند پایه</th>
                      <th>تاریخ</th>
                      <th>منبع</th>
                      <th>بدهکار</th>
                      <th>بستانکار</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summaryDetail.sources.map((source) => (
                      <tr key={source.journalEntryId}>
                        <td className={printStyles.num} dir="ltr">
                          {source.entryVoucherNumber ?? "—"}
                        </td>
                        <td>{formatJalali(source.entryDate)}</td>
                        <td>{source.sourceType ? ledgerSourceLabel(source.sourceType) : "—"}</td>
                        <td className={printStyles.num}>{toPersianDigits(rials.format(Number(source.totalDebit)))}</td>
                        <td className={printStyles.num}>{toPersianDigits(rials.format(Number(source.totalCredit)))}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th colSpan={3}>جمع</th>
                      <td className={printStyles.num}>
                        {toPersianDigits(rials.format(Number(summaryDetail.totalDebit)))}
                      </td>
                      <td className={printStyles.num}>
                        {toPersianDigits(rials.format(Number(summaryDetail.totalCredit)))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </>
            ) : null}
          </div>,
          document.body,
        )
        : null}
    </section>
  );
}
