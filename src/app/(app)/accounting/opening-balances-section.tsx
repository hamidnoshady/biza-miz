"use client";

/**
 * «ترازات افتتاحیه» — the accountant's opening-balance workspace (issue
 * #867).
 *
 * Sets live their own life here, outside the setup wizard: draft (edit lines,
 * import with a preview) → review → approved (the carry-forward set must also
 * reconcile to the prior close) → posted (one ordinary journal entry, dated
 * at the effective date) → reversed (a mirror entry, only while the books
 * have not moved on). Every action is the same capability split the manual
 * journal uses: `ledger.post` moves a draft forward, `ledger.approve`
 * decides.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
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
import type { AccountRow } from "./accounting-manager";
import { createPortal } from "react-dom";
import printStyles from "./opening-balances-print.module.css";

const rials = new Intl.NumberFormat("fa-IR");

type SetStatus = "draft" | "review" | "approved" | "posted" | "reversed";

interface OpeningSet {
  id: string;
  fiscalYearLabel: string;
  fiscalYearId: string | null;
  effectiveDate: string;
  status: SetStatus;
  source: "manual" | "import" | "carry_forward";
  carryForwardFromYearId: string | null;
  journalEntryId: string | null;
  reversalEntryId: string | null;
  totalDebit: string;
  totalCredit: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  postedAt: string | null;
  reversedAt: string | null;
  reversedReason: string | null;
  createdByName: string | null;
}

interface OpeningLine {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
  partyType: string | null;
  partyId: string | null;
  partyName: string | null;
  reference: string | null;
  sourceNote: string | null;
}

interface FiscalYear {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  closedAt: string | null;
}

interface ReconciliationRow {
  key: string;
  label: string;
  expectedDebit: string;
  expectedCredit: string;
  actualDebit: string;
  actualCredit: string;
  difference: string;
  matched: boolean;
}

interface Reconciliation {
  matched: boolean;
  rows: ReconciliationRow[];
  notes: string[];
  totals: {
    expectedDebit: string;
    expectedCredit: string;
    actualDebit: string;
    actualCredit: string;
  };
}

interface ImportPreview {
  valid: boolean;
  problem: string | null;
  totalDebit: string;
  totalCredit: string;
  lineCount: number;
  accounts: { accountId: string; code: string; name: string; debit: string; credit: string }[];
}

interface DraftLine {
  accountId: string;
  debit: string;
  credit: string;
  reference: string;
  sourceNote: string;
}

const STATUS_LABELS: Record<SetStatus, string> = {
  draft: "پیش‌نویس",
  review: "در بازبینی",
  approved: "تأییدشده",
  posted: "ثبت‌شده",
  reversed: "برگشته",
};

const STATUS_TONES: Record<SetStatus, "neutral" | "active" | "positive" | "danger"> = {
  draft: "neutral",
  review: "active",
  approved: "active",
  posted: "positive",
  reversed: "danger",
};

const SOURCE_LABELS: Record<OpeningSet["source"], string> = {
  manual: "دستی",
  import: "در‌آورده",
  carry_forward: "انتقال سال",
};

function errorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    invalid_fiscal_year: "سال مالی باید چهار رقم شمسی باشد (مثلاً ۱۴۰۵).",
    invalid_effective_date: "تاریخ مؤثر معتبر نیست.",
    effective_date_outside_fiscal_year: "تاریخ مؤثر باید داخل همان سال مالی باشد که نام آن را برداشته است.",
    set_not_found: "مجموعهٔ ترازات یافت نشد؛ فهرست را دوباره بارگذاری کنید.",
    set_not_editable: "این مجموعه دیگر قابل ویرایش نیست؛ خطوط پس از ثبت در بازبینی منجمد می‌شوند.",
    invalid_status: "وضعیت این مجموعه با این اقدام جور در نمی‌آید؛ فهرست را بررسی کنید.",
    not_balanced: "مجموع بدهکار و بستانکار برابرسند نیست.",
    no_lines: "مجموعه خالی است؛ حداقل دو خط با مبلغ وارد کنید.",
    too_many_lines: "تعداد خطوط بیش از سقف مجاز است.",
    invalid_line: "یکی از خطوط نامعتبر است: هر خط فقط یک طرف (بدهکار یا بستانکار) و مبلغ صحیح می‌خواهد.",
    too_few_lines: "مجموعه باید حداقل دو خط داشته باشد.",
    single_account_set: "مجموعه باید از چندین حساب تشکیل شود، نه یک حساب در برابر خودش.",
    account_missing_or_archived: "یکی از حساب‌ها در سرفصل نیست یا بایگانی شده است.",
    opening_set_already_posted: "برای این سال مالی از قبل ترازات افتتاحیه ثبت شده است؛ سال دوم افتتاح ندارد.",
    opening_entry_exists_for_year: "برای این سال مالی از قبل سند افتتاحیه (مثلاً از راه راه‌اندازی) ثبت شده است.",
    set_has_no_lines: "این مجموعه خطی برای ثبت ندارد.",
    reason_required: "دلیل برگشت الزامی است (تا ۵۰۰ حرف).",
    dependent_postings_exist:
      "پس از تاریخ مؤثر این ترازات، اسناد دیگری ثبت شده‌اند؛ دیگر نمی‌توان آن را برگرداند و اصلاح باید با سند جریانی باشد.",
    prior_year_not_closed: "سال قبل هنوز بسته نشده است؛ دوره‌های آن را به‌صورت موقت ببندید و سپس سال را ببندید.",
    years_not_consecutive: "سال مقصد باید بلافاصله پس از سال مبدأ باشد.",
    fiscal_year_not_found: "سال مالی یافت نشد.",
    prior_close_not_balanced: "تراز پایانی سال قبل برابرسند نیست؛ ابتدا تراز آزمایشی سال قبل را بررسی کنید.",
    reconciliation_failed: "پیشنهاد انتقال سال با تراز پایانی سال قبل هم‌خوانی ندارد؛ فهرست را دوباره تولید کنید.",
    unauthorized: "وارد نشده‌اید.",
    forbidden: "دسترسی مجاز نیست.",
    bad_request: "درخواست نامعتبر بود.",
    request_failed: "ارتباط با سرور برقرار نشد. اتصال را بررسی و دوباره تلاش کنید.",
  };
  return map[code ?? ""] ?? "خطای غیرمنتظره رخ داد. دوباره تلاش کنید.";
}

function emptyDraftLine(): DraftLine {
  return { accountId: "", debit: "", credit: "", reference: "", sourceNote: "" };
}

export function OpeningBalancesSection({
  accounts,
  busy,
  run,
  refreshKey,
  canApprove,
}: {
  accounts: AccountRow[];
  busy: boolean;
  run: (fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => Promise<boolean>;
  refreshKey: number;
  /** `ledger.approve` — the approve/post/reverse half of the set's life. */
  canApprove: boolean;
}) {
  const [sets, setSets] = useState<OpeningSet[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ set: OpeningSet; lines: OpeningLine[] } | null>(null);
  const [years, setYears] = useState<FiscalYear[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mutation, setMutation] = useState<string | null>(null);
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);

  // The print sheet is portalled onto <body>; there is no body to portal onto
  // during the server render, and on screen the sheet stays display:none.
  const [portalReady, setPortalReady] = useState(false);
  useEffect(() => {
    setPortalReady(true);
  }, []);
  const [printData, setPrintData] = useState<{
    set: OpeningSet;
    lines: OpeningLine[];
    reconciliation: Reconciliation | null;
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

  // Carry-forward card
  const [fromYearId, setFromYearId] = useState("");
  const [toYearId, setToYearId] = useState("");

  // Reversal confirmation (a reason is mandatory — a reversal without one is a disappearance)
  const [reversalOpen, setReversalOpen] = useState(false);
  const [reversalReason, setReversalReason] = useState("");

  // Draft editor
  const [editorOpen, setEditorOpen] = useState(false);
  const [draftLines, setDraftLines] = useState<DraftLine[]>([emptyDraftLine()]);
  const [draftNote, setDraftNote] = useState("");

  // Import / preview
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importYear, setImportYear] = useState("");
  const [importDate, setImportDate] = useState("");
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    api<{ sets: OpeningSet[] }>("/api/ledger/opening-balances")
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (!ok) {
          setLoadFailed(true);
          setSets((current) => current ?? []);
          return;
        }
        setSets(data.sets);
        setSelectedId((current) =>
          current && data.sets.some((s) => s.id === current) ? current : data.sets[0]?.id ?? null,
        );
      })
      .catch(() => {
        if (cancelled) return;
        setLoadFailed(true);
        setSets((current) => current ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    api<{ fiscalYears: FiscalYear[] }>("/api/ledger/fiscal-years")
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (ok) {
          const sorted = [...data.fiscalYears].sort((a, b) => a.label.localeCompare(b.label));
          setYears(sorted);
          setFromYearId((current) => current ?? sorted[sorted.length - 2]?.id ?? "");
          setToYearId((current) => current ?? sorted[sorted.length - 1]?.id ?? "");
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setReconciliation(null);
    if (!selectedId) return () => {
      cancelled = true;
    };
    api<{ set: OpeningSet; lines: OpeningLine[] }>(`/api/ledger/opening-balances/${selectedId}`)
      .then(({ ok, data }) => {
        if (cancelled || !ok) return;
        setDetail({ set: data.set, lines: data.lines });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedId, refreshKey]);

  const accountOptions = useMemo(
    () =>
      accounts
        .slice()
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
    [accounts],
  );

  async function act(fn: () => Promise<{ ok: boolean; data: { error?: string } }>, label: string) {
    setError("");
    setNotice("");
    const ok = await run(fn);
    if (ok) setNotice(label);
  }

  function requestSubmit() {
    if (!detail) return;
    void act(
      () => api(`/api/ledger/opening-balances/${detail.set.id}/submit`, { method: "POST" }),
      "مجموعه به بازبینی رفت؛ خطوط دیگر قابل ویرایش نیستند.",
    );
  }

  function requestApprove() {
    if (!detail) return;
    void act(
      () => api(`/api/ledger/opening-balances/${detail.set.id}/approve`, { method: "POST" }),
      "مجموعه تأیید شد.",
    );
  }

  function requestPost() {
    if (!detail) return;
    void act(
      () => api(`/api/ledger/opening-balances/${detail.set.id}/post`, { method: "POST" }),
      "ترازات افتتاحیه در دفتر ثبت شد.",
    );
  }

  function requestReverse() {
    if (!detail) return;
    setReversalReason("");
    setReversalOpen(true);
  }

  async function confirmReverse() {
    if (!detail || mutation) return;
    setReversalOpen(false);
    await act(
      () =>
        api(`/api/ledger/opening-balances/${detail.set.id}/reverse`, {
          method: "POST",
          body: JSON.stringify({ reason: reversalReason }),
        }),
      "ترازات افتتاحیه برگشت خورد؛ سندی آینه‌ای با تاریخ امروز ثبت شد.",
    );
  }

  async function generateCarryForward() {
    if (!fromYearId || !toYearId || mutation) return;
    setError("");
    setNotice("");
    setMutation("carry-forward");
    try {
      const { ok, data, status } = await api<{ setId: string; idempotent: boolean; error?: string }>(
        "/api/ledger/opening-balances/carry-forward",
        { method: "POST", body: JSON.stringify({ fromYearId, toYearId }) },
      );
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      setNotice(
        status === 201
          ? "پیشنهاد انتقال سال تولید شد؛ بررسی، تطبیق و ثبت آن را از فهرست ادامه دهید."
          : "این انتقال از قبل تولید شده بود؛ همان مجموعه بازگردانده شد.",
      );
      setSelectedId(data.setId);
      setRefreshKeySafe();
    } catch {
      setError(errorMessage("request_failed"));
    } finally {
      setMutation(null);
    }
  }

  // The section does not own its refreshKey (the manager does); this reloads
  // the set list directly.
  const setRefreshKeySafe = () => {
    void api<{ sets: OpeningSet[] }>("/api/ledger/opening-balances").then(({ ok, data }) => {
      if (ok) setSets(data.sets);
    });
  };

  function openEditor() {
    if (!detail) return;
    setDraftLines(
      detail.lines.length > 0
        ? detail.lines.map((l) => ({
            accountId: l.accountId,
            debit: l.debit === "0" ? "" : l.debit,
            credit: l.credit === "0" ? "" : l.credit,
            reference: l.reference ?? "",
            sourceNote: l.sourceNote ?? "",
          }))
        : [emptyDraftLine()],
    );
    setDraftNote(detail.set.note ?? "");
    setEditorOpen(true);
  }

  function parseAmount(value: string): number {
    const digits = value.replace(/[٠-۹]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/\D/g, "");
    const n = Number(digits);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  }

  async function saveEditor() {
    if (!detail || mutation) return;
    const lines = draftLines
      .filter((l) => l.accountId !== "" || parseAmount(l.debit) !== 0 || parseAmount(l.credit) !== 0)
      .map((l) => ({
        accountId: l.accountId,
        debit: parseAmount(l.debit),
        credit: parseAmount(l.credit),
        reference: l.reference.trim() || null,
        sourceNote: l.sourceNote.trim() || null,
      }));
    setMutation("save-lines");
    setError("");
    try {
      const { ok, data } = await api<{ error?: string }>(`/api/ledger/opening-balances/${detail.set.id}`, {
        method: "PUT",
        body: JSON.stringify({ lines, note: draftNote.trim() || null }),
      });
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      setEditorOpen(false);
      setNotice("خطوط مجموعه به‌روزرسانی شد.");
      setRefreshKeySafe();
    } catch {
      setError(errorMessage("request_failed"));
    } finally {
      setMutation(null);
    }
  }

  async function previewImport() {
    setError("");
    setImportPreview(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
    } catch {
      setError("متن واردشده باید یک آرایهٔ JSON از خطوط باشد.");
      return;
    }
    const { ok, data } = await api<ImportPreview & { error?: string }>("/api/ledger/opening-balances/import", {
      method: "POST",
      body: JSON.stringify({ fiscalYearLabel: importYear, effectiveDate: importDate || null, lines: parsed }),
    });
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setImportPreview(data);
  }

  async function createFromImport() {
    if (!importPreview?.valid || mutation) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
    } catch {
      return;
    }
    setMutation("import");
    setError("");
    try {
      const { ok, data } = await api<{ setId: string; error?: string }>(
        "/api/ledger/opening-balances",
        {
          method: "POST",
          body: JSON.stringify({
            fiscalYearLabel: importYear,
            effectiveDate: importDate || null,
            lines: parsed,
            note: "در‌آورده شده از فایل",
          }),
        },
      );
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      setImportOpen(false);
      setImportPreview(null);
      setImportText("");
      setNotice("پیش‌نویس از دادهٔ در‌آورده‌شده ساخته شد.");
      setSelectedId(data.setId);
      setRefreshKeySafe();
    } catch {
      setError(errorMessage("request_failed"));
    } finally {
      setMutation(null);
    }
  }

  async function exportSet(format: "csv" | "xlsx") {
    if (!detail) return;
    const res = await fetch(`/api/ledger/opening-balances/${detail.set.id}/export?format=${format}`);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(errorMessage(data.error));
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `opening-balances-${detail.set.fiscalYearLabel}.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function loadReconciliation() {
    if (!detail) return;
    const { ok, data } = await api<Reconciliation & { error?: string }>(
      `/api/ledger/opening-balances/${detail.set.id}/reconciliation`,
    );
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setReconciliation(data);
  }

  // The opening-balance report: the set with its lines, and — for a
  // carry-forward set — the prior-close vs next-open reconciliation that
  // stands behind it. If the reconciliation has not been loaded yet, the
  // print fetches it, so the paper carries both reports, not one.
  async function printSet() {
    if (!detail || printing) return;
    setPrinting(true);
    setError("");
    try {
      let report = reconciliation;
      if (detail.set.source === "carry_forward" && !report) {
        const { ok, data } = await api<Reconciliation & { error?: string }>(
          `/api/ledger/opening-balances/${detail.set.id}/reconciliation`,
        );
        if (!ok) {
          setError(errorMessage(data.error));
          return;
        }
        report = data;
      }
      setPrintData({ set: detail.set, lines: detail.lines, reconciliation: report });
    } catch {
      setError(errorMessage("request_failed"));
    } finally {
      setPrinting(false);
    }
  }

  const selected = detail?.set ?? null;
  const fromYear = years?.find((y) => y.id === fromYearId) ?? null;
  const toYear = years?.find((y) => y.id === toYearId) ?? null;
  const isMutating = busy || mutation !== null;

  if (!sets) return <LoadingSkeleton rows={4} label="در حال بارگذاری ترازات افتتاحیه" />;

  return (
    <section className="space-y-4" aria-label="ترازات افتتاحیه">
      <ErrorBox>{error}</ErrorBox>
      <ErrorBox>{loadFailed ? "بارگذاری ترازات افتتاحیه ناموفق بود." : ""}</ErrorBox>
      {notice ? (
        <p role="status" className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm leading-6 text-foreground">
          {notice}
        </p>
      ) : null}

      {/* ------------------------------------------------ carry-forward */}
      <SectionCard
        title="انتقال سال مالی"
        description="مانده‌های ترازنامهٔ سال بسته‌شده را به‌عنوان ترازات افتتاحیهٔ سال بعد تولید می‌کند — با نگه‌داشتن تخصیص بدهکار/بستانکار به مشتری و تأمین‌کننده، هویت چک‌ها و دارایی‌ها، و انتقال سود (زیان) سال به سرمایه. هیچ سندی اینجا ثبت نمی‌شود."
      >
        {years === null ? (
          <LoadingSkeleton rows={1} compact label="در حال بارگذاری سال‌های مالی" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
            <Field label="سال قبل (بسته‌شده)">
              <select
                className={inputClass}
                value={fromYearId}
                onChange={(event) => setFromYearId(event.target.value)}
              >
                {years.map((year) => (
                  <option key={year.id} value={year.id}>
                    {toPersianDigits(year.label)}
                    {year.closedAt ? "" : " — باز"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="سال جدید">
              <select
                className={inputClass}
                value={toYearId}
                onChange={(event) => setToYearId(event.target.value)}
              >
                {years.map((year) => (
                  <option key={year.id} value={year.id}>
                    {toPersianDigits(year.label)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="w-full sm:w-[13rem]">
              <PrimaryButton
                type="button"
                disabled={isMutating || !fromYearId || !toYearId || fromYearId === toYearId}
                onClick={() => void generateCarryForward()}
              >
                {mutation === "carry-forward" ? "در حال تولید…" : "تولید پیشنهاد انتقال"}
              </PrimaryButton>
            </div>
            {fromYear && !fromYear.closedAt ? (
              <p className="text-xs leading-5 text-muted-foreground sm:col-span-3">
                سال {toPersianDigits(fromYear.label)} هنوز بسته نشده است؛ انتقال سال فقط از یک سال بسته ممکن است.
              </p>
            ) : null}
          </div>
        )}
      </SectionCard>

      {/* -------------------------------------------------------- the sets */}
      <SectionCard
        title="مجموعه‌های ترازات افتتاحیه"
        description="هر سال مالی یک مجموعه دارد؛ همان ثبت‌شده، سال را افتتاح می‌کند. وضعیت‌ها یک‌طرفه‌اند: پیش‌نویس ← بازبینی ← تأییدشده ← ثبت‌شده ← برگشته."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={isMutating} onClick={() => setImportOpen(true)}>
              در‌آوردن با پیش‌نمایش
            </Button>
          </div>
        }
      >
        {sets.length === 0 ? (
          <EmptyState>
            هنوز مجموعهٔ ترازات افتتاحیه‌ای نیست. از کارت «انتقال سال مالی» یا دکمهٔ «در‌آوردن با پیش‌نمایش» شروع کنید.
          </EmptyState>
        ) : (
          <div className="space-y-2">
            {sets.map((set) => {
              const isSelected = selectedId === set.id;
              return (
                <button
                  key={set.id}
                  type="button"
                  onClick={() => setSelectedId(set.id)}
                  aria-current={isSelected ? "true" : undefined}
                  className={`w-full rounded-xl border px-4 py-3 text-right transition-colors ${
                    isSelected
                      ? "border-primary/60 bg-primary/5"
                      : "border-border/80 bg-muted/40 hover:border-primary/40"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="text-sm font-semibold text-foreground">
                        سال مالی {toPersianDigits(set.fiscalYearLabel)}
                      </span>
                      <StatusBadge tone={STATUS_TONES[set.status]}>{STATUS_LABELS[set.status]}</StatusBadge>
                      <span className="text-xs text-muted-foreground">{SOURCE_LABELS[set.source] ?? set.source}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      مؤثر از {formatJalali(set.effectiveDate)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    جمع بدهکار {toPersianDigits(rials.format(Number(set.totalDebit)))} — بستانکار{" "}
                    {toPersianDigits(rials.format(Number(set.totalCredit)))}
                    {set.createdByName ? ` — ثبت‌کننده: ${set.createdByName}` : ""}
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </SectionCard>

      {/* ------------------------------------------------------- the detail */}
      {selected ? (
        <SectionCard
          title={`مجموعهٔ سال مالی ${toPersianDigits(selected.fiscalYearLabel)}`}
          description={
            selected.status === "reversed"
              ? `این مجموعه برگشت خورده است${selected.reversedReason ? ` — دلیل: ${selected.reversedReason}` : ""}.`
              : `تاریخ مؤثر: ${formatJalali(selected.effectiveDate)}` +
                (selected.note ? ` — ${selected.note}` : "")
          }
          actions={
            <div className="flex flex-wrap gap-2">
              {selected.status === "draft" ? (
                <>
                  <Button type="button" variant="outline" size="sm" disabled={isMutating} onClick={openEditor}>
                    ویرایش خطوط
                  </Button>
                  <Button type="button" size="sm" disabled={isMutating} onClick={requestSubmit}>
                    {mutation ? "در حال ثبت…" : "به بازبینی"}
                  </Button>
                </>
              ) : null}
              {selected.status === "review" && canApprove ? (
                <Button type="button" size="sm" disabled={isMutating} onClick={requestApprove}>
                  تأیید
                </Button>
              ) : null}
              {selected.status === "approved" && canApprove ? (
                <Button type="button" size="sm" disabled={isMutating} onClick={requestPost}>
                  {mutation ? "در حال ثبت…" : "ثبت در دفتر"}
                </Button>
              ) : null}
              {selected.status === "posted" && canApprove ? (
                <Button type="button" variant="destructive" size="sm" disabled={isMutating} onClick={requestReverse}>
                  برگشت
                </Button>
              ) : null}
              {selected.source === "carry_forward" && selected.status !== "reversed" ? (
                <Button type="button" variant="outline" size="sm" disabled={isMutating} onClick={() => void loadReconciliation()}>
                  تطبیق با تراز پایانی
                </Button>
              ) : null}
              <Button type="button" variant="outline" size="sm" disabled={isMutating} onClick={() => void exportSet("csv")}>
                خروجی CSV
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isMutating || detail === null || printing}
                onClick={() => void printSet()}
              >
                {printing ? "در حال تهیه…" : "چاپ / PDF"}
              </Button>
            </div>
          }
        >
          {detail === null ? (
            <LoadingSkeleton rows={3} compact label="در حال بارگذاری خطوط" />
          ) : (
            <>
              <DataTable caption="خطوط ترازات افتتاحیه" className="hidden lg:block">
                <DataTableHead>
                  <Th>حساب</Th>
                  <Th>بدهکار</Th>
                  <Th>بستانکار</Th>
                  <Th>مشخصه</Th>
                  <Th>توضیح</Th>
                </DataTableHead>
                <DataTableBody>
                  {detail.lines.map((line) => (
                    <DataTableRow key={line.id}>
                      <Td>
                        <span className="font-medium">{line.accountCode}</span>{" "}
                        <span className="text-muted-foreground">{line.accountName}</span>
                      </Td>
                      <Td>{line.debit === "0" ? "—" : toPersianDigits(rials.format(Number(line.debit)))}</Td>
                      <Td>{line.credit === "0" ? "—" : toPersianDigits(rials.format(Number(line.credit)))}</Td>
                      <Td className="text-muted-foreground">
                        {line.partyName ? `${line.partyType ?? ""} ${line.partyName}`.trim() : line.reference ?? "—"}
                      </Td>
                      <Td className="text-muted-foreground">{line.sourceNote ?? "—"}</Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>

              <div className="space-y-2 lg:hidden">
                {detail.lines.map((line) => (
                  <article key={line.id} className="rounded-xl border border-border/80 bg-muted/40 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-foreground">
                        {line.accountCode} — {line.accountName}
                      </h3>
                      <span className="text-xs text-muted-foreground">
                        {line.debit === "0" && line.credit === "0"
                          ? "—"
                          : `${line.debit !== "0" ? `ب‌: ${toPersianDigits(rials.format(Number(line.debit)))} ` : ""}${line.credit !== "0" ? `س‌: ${toPersianDigits(rials.format(Number(line.credit)))}` : ""}`}
                      </span>
                    </div>
                    {(line.partyName || line.reference || line.sourceNote) ? (
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {line.partyName ? `${line.partyType ?? ""} ${line.partyName}`.trim() + " — " : ""}
                        {line.reference ?? ""}
                        {line.sourceNote ? ` — ${line.sourceNote}` : ""}
                      </p>
                    ) : null}
                  </article>
                ))}
              </div>

              {/* the carry-forward reconciliation, when asked for */}
              {reconciliation ? (
                <div className="mt-5 rounded-xl border border-border/80 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-foreground">
                      تطبیق با تراز پایانی سال قبل
                    </h3>
                    <StatusBadge tone={reconciliation.matched ? "positive" : "danger"} dot>
                      {reconciliation.matched ? "مطابق تا ریال" : "عدم تطبیق"}
                    </StatusBadge>
                  </div>
                  {reconciliation.notes.length > 0 ? (
                    <ul className="mt-3 list-inside list-disc space-y-1 text-xs leading-5 text-muted-foreground">
                      {reconciliation.notes.map((note, index) => (
                        <li key={index}>{note}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[40rem] text-sm">
                      <thead>
                        <tr className="text-right text-xs text-muted-foreground">
                          <th className="pb-2 pr-2 font-medium">قلم</th>
                          <th className="pb-2 pr-2 font-medium">بدهکار تراز پایانی</th>
                          <th className="pb-2 pr-2 font-medium">بستانکار تراز پایانی</th>
                          <th className="pb-2 pr-2 font-medium">بدهکار افتتاحیه</th>
                          <th className="pb-2 pr-2 font-medium">بستانکار افتتاحیه</th>
                          <th className="pb-2 pr-2 font-medium">اختلاف</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reconciliation.rows.map((row) => (
                          <tr key={row.key} className="border-t border-border/60">
                            <td className={`py-2 pr-2 ${row.matched ? "" : "font-medium text-destructive"}`}>
                              {row.label}
                            </td>
                            <td className="py-2 pr-2 text-muted-foreground">
                              {toPersianDigits(rials.format(Number(row.expectedDebit)))}
                            </td>
                            <td className="py-2 pr-2 text-muted-foreground">
                              {toPersianDigits(rials.format(Number(row.expectedCredit)))}
                            </td>
                            <td className="py-2 pr-2">{toPersianDigits(rials.format(Number(row.actualDebit)))}</td>
                            <td className="py-2 pr-2">{toPersianDigits(rials.format(Number(row.actualCredit)))}</td>
                            <td className={`py-2 pr-2 ${row.matched ? "text-muted-foreground" : "font-medium text-destructive"}`}>
                              {row.matched ? "—" : toPersianDigits(rials.format(Number(row.difference)))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </SectionCard>
      ) : null}

      {/* ------------------------------------------------ reversal dialog */}
      <Dialog
        open={reversalOpen}
        onOpenChange={(open) => {
          if (!open && !isMutating) setReversalOpen(false);
        }}
      >
        <DialogContent showCloseButton={!isMutating}>
          <DialogHeader>
            <DialogTitle>برگشت ترازات افتتاحیهٔ {selected ? toPersianDigits(selected.fiscalYearLabel) : ""}؟</DialogTitle>
            <DialogDescription>
              سندی آینه‌ای با تاریخ امروز ثبت می‌شود و هیچ سندی بازنویسی نمی‌شود. تا زمانی که سند دیگری پس از تاریخ
              مؤثر ثبت نشده باشد، این کار ممکن است. دلیل الزامی است.
            </DialogDescription>
          </DialogHeader>
          <Field label="دلیل برگشت" hint="۱ تا ۵۰۰ حرف؛ در دفتر اسناد می‌ماند.">
            <textarea
              className={`${inputClass} h-24 resize-none py-2`}
              value={reversalReason}
              onChange={(event) => setReversalReason(event.target.value)}
              maxLength={500}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={isMutating} onClick={() => setReversalOpen(false)}>
              انصراف
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isMutating || reversalReason.trim().length === 0}
              onClick={() => void confirmReverse()}
            >
              {isMutating ? "در حال ثبت…" : "برگشت"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ------------------------------------------------ draft editor */}
      <Dialog open={editorOpen} onOpenChange={(open) => !open && !isMutating && setEditorOpen(false)}>
        <DialogContent className="max-w-3xl" showCloseButton={!isMutating}>
          <DialogHeader>
            <DialogTitle>ویرایش خطوط مجموعه</DialogTitle>
            <DialogDescription>
              هر خط یک حساب، فقط یک طرف (بدهکار یا بستانکار) و مبلغ به ریال می‌خواهد. مجموع دو طرف باید برابرسند باشد.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-2 overflow-y-auto pl-2">
            {draftLines.map((line, index) => (
              <div key={index} className="grid gap-2 rounded-xl border border-border/80 p-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-foreground">حساب</span>
                  <select
                    className={inputClass}
                    value={line.accountId}
                    onChange={(event) =>
                      setDraftLines((lines) =>
                        lines.map((l, i) => (i === index ? { ...l, accountId: event.target.value } : l)),
                      )
                    }
                  >
                    <option value="">— انتخاب حساب —</option>
                    {accountOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-foreground">بدهکار (ریال)</span>
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    placeholder="۰"
                    value={line.debit}
                    onChange={(event) =>
                      setDraftLines((lines) => lines.map((l, i) => (i === index ? { ...l, debit: event.target.value } : l)))
                    }
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-foreground">بستانکار (ریال)</span>
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    placeholder="۰"
                    value={line.credit}
                    onChange={(event) =>
                      setDraftLines((lines) => lines.map((l, i) => (i === index ? { ...l, credit: event.target.value } : l)))
                    }
                  />
                </label>
                <label className="block sm:col-span-2">
                  <span className="mb-1 block text-xs font-medium text-foreground">توضیح (اختیاری)</span>
                  <input
                    className={inputClass}
                    value={line.sourceNote}
                    onChange={(event) =>
                      setDraftLines((lines) =>
                        lines.map((l, i) => (i === index ? { ...l, sourceNote: event.target.value } : l)),
                      )
                    }
                  />
                </label>
                <div className="flex items-end justify-end">
                  <SecondaryButton
                    className="text-destructive"
                    disabled={isMutating || draftLines.length <= 2}
                    onClick={() => setDraftLines((lines) => lines.filter((_, i) => i !== index))}
                  >
                    حذف خط
                  </SecondaryButton>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <SecondaryButton disabled={isMutating} onClick={() => setDraftLines((lines) => [...lines, emptyDraftLine()])}>
              افزودن خط
            </SecondaryButton>
          </div>
          <Field label="توضیح مجموعه (اختیاری)">
            <input
              className={inputClass}
              value={draftNote}
              maxLength={500}
              onChange={(event) => setDraftNote(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={isMutating} onClick={() => setEditorOpen(false)}>
              انصراف
            </Button>
            <Button type="button" disabled={isMutating} onClick={() => void saveEditor()}>
              {mutation === "save-lines" ? "در حال ذخیره…" : "ذخیرهٔ خطوط"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ------------------------------------------------ import / preview */}
      <Dialog open={importOpen} onOpenChange={(open) => !open && !isMutating && setImportOpen(false)}>
        <DialogContent className="max-w-2xl" showCloseButton={!isMutating}>
          <DialogHeader>
            <DialogTitle>در‌آوردن ترازات افتتاحیه با پیش‌نمایش</DialogTitle>
            <DialogDescription>
              خطوط را به‌صورت آرایهٔ JSON بچسبانید؛ پیش از ثبت، همان اعتبارسنجی سرور — جمع‌ها، تفکیک به حساب و اولین
              ایراد — پیش‌نمایش داده می‌شود و هیچ چیز ذخیره نمی‌شود.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="سال مالی" hint="چهار رقم شمسی">
              <input className={inputClass} inputMode="numeric" maxLength={4} value={importYear} onChange={(event) => setImportYear(event.target.value)} />
            </Field>
            <Field label="تاریخ مؤثر">
              <input className={inputClass} type="date" value={importDate} onChange={(event) => setImportDate(event.target.value)} />
            </Field>
          </div>
          <Field
            label="خطوط (JSON)"
            hint='مثلاً [{"accountId":"…","debit":1000000},{"accountId":"…","credit":1000000}] — partyType/partyId/reference/sourceNote اختیاری‌اند.'
          >
            <textarea
              className={`${inputClass} h-28 resize-none py-2 font-mono text-xs`}
              dir="ltr"
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
            />
          </Field>
          {importPreview ? (
            <div className="rounded-xl border border-border/80 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <StatusBadge tone={importPreview.valid ? "positive" : "danger"} dot>
                  {importPreview.valid
                    ? `آمادهٔ ساخت — ${toPersianDigits(importPreview.lineCount)} خط`
                    : "این مجموعه معتبر نیست"}
                </StatusBadge>
                <span className="text-xs text-muted-foreground">
                  بدهکار {toPersianDigits(rials.format(Number(importPreview.totalDebit)))} — بستانکار{" "}
                  {toPersianDigits(rials.format(Number(importPreview.totalCredit)))}
                </span>
              </div>
              {importPreview.problem ? (
                <p className="mt-2 text-xs text-destructive">{errorMessage(importPreview.problem)}</p>
              ) : null}
              <ul className="mt-2 max-h-40 list-inside list-disc space-y-1 overflow-y-auto text-xs text-muted-foreground">
                {importPreview.accounts.map((account) => (
                  <li key={account.accountId}>
                    {account.code} — {account.name}: بدهکار {toPersianDigits(rials.format(Number(account.debit)))}، بستانکار{" "}
                    {toPersianDigits(rials.format(Number(account.credit)))}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={isMutating} onClick={() => void previewImport()}>
              {mutation === "import" ? "در حال بررسی…" : "پیش‌نمایش"}
            </Button>
            <Button
              type="button"
              disabled={isMutating || !importPreview?.valid}
              onClick={() => void createFromImport()}
            >
              ساخت پیش‌نویس
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {portalReady && printData
        ? createPortal(
          <div id="print-sheet-root" className={printStyles.sheet} aria-hidden="true">
            <header>
              <h1>ترازات افتتاحیه — سال مالی {toPersianDigits(printData.set.fiscalYearLabel)}</h1>
              <p>
                {STATUS_LABELS[printData.set.status]} — {SOURCE_LABELS[printData.set.source] ?? printData.set.source}
                {printData.set.source === "carry_forward"
                  ? " (انتقال از سال قبل)"
                  : ""}
              </p>
              <p>تاریخ مؤثر: {formatJalali(printData.set.effectiveDate)}</p>
              <p>
                جمع بدهکار: {toPersianDigits(rials.format(Number(printData.set.totalDebit)))} — جمع بستانکار:{" "}
                {toPersianDigits(rials.format(Number(printData.set.totalCredit)))}
              </p>
              <p>تاریخ تولید: {toPersianDigits(formatJalali(new Date(), { withMonthName: true }))}</p>
            </header>
            <table>
              <thead>
                <tr>
                  <th>حساب</th>
                  <th>مشخصه</th>
                  <th>توضیح</th>
                  <th>بدهکار</th>
                  <th>بستانکار</th>
                </tr>
              </thead>
              <tbody>
                {printData.lines.map((line) => (
                  <tr key={line.id}>
                    <td>
                      <span dir="ltr">{line.accountCode}</span> — {line.accountName}
                    </td>
                    <td>{line.partyName ? `${line.partyType ?? ""} ${line.partyName}`.trim() : line.reference ?? "—"}</td>
                    <td>{line.sourceNote ?? "—"}</td>
                    <td className={printStyles.num}>
                      {line.debit === "0" ? "—" : toPersianDigits(rials.format(Number(line.debit)))}
                    </td>
                    <td className={printStyles.num}>
                      {line.credit === "0" ? "—" : toPersianDigits(rials.format(Number(line.credit)))}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={3}>جمع</th>
                  <td className={printStyles.num}>
                    {toPersianDigits(rials.format(Number(printData.set.totalDebit)))}
                  </td>
                  <td className={printStyles.num}>
                    {toPersianDigits(rials.format(Number(printData.set.totalCredit)))}
                  </td>
                </tr>
              </tfoot>
            </table>

            {printData.reconciliation ? (
              <>
                <h2 className={printStyles.block}>
                  تطبیق با تراز پایانی سال قبل {printData.reconciliation.matched ? "— هم‌خوان" : "— مغایرت دارد"}
                </h2>
                <table>
                  <thead>
                    <tr>
                      <th>حساب / طرف</th>
                      <th>مطلوب — بدهکار</th>
                      <th>مطلوب — بستانکار</th>
                      <th>فعلي — بدهکار</th>
                      <th>فعلي — بستانکار</th>
                      <th>اختلاف</th>
                    </tr>
                  </thead>
                  <tbody>
                    {printData.reconciliation.rows.map((row) => (
                      <tr key={row.key}>
                        <td>{row.label}</td>
                        <td className={printStyles.num}>
                          {row.expectedDebit === "0" ? "—" : toPersianDigits(rials.format(Number(row.expectedDebit)))}
                        </td>
                        <td className={printStyles.num}>
                          {row.expectedCredit === "0" ? "—" : toPersianDigits(rials.format(Number(row.expectedCredit)))}
                        </td>
                        <td className={printStyles.num}>
                          {row.actualDebit === "0" ? "—" : toPersianDigits(rials.format(Number(row.actualDebit)))}
                        </td>
                        <td className={printStyles.num}>
                          {row.actualCredit === "0" ? "—" : toPersianDigits(rials.format(Number(row.actualCredit)))}
                        </td>
                        <td className={printStyles.num}>
                          {row.difference === "0" ? "—" : toPersianDigits(rials.format(Number(row.difference)))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {printData.reconciliation.notes.length > 0 ? (
                  <p>{printData.reconciliation.notes.join(" ")}</p>
                ) : null}
              </>
            ) : null}
          </div>,
          document.body,
        )
        : null}
    </section>
  );
}
