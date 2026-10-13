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
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { effectiveDateMatchesFiscalYear } from "@/lib/opening-balances";
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
  /** File-path problems (row-numbered) — the JSON path never has any. */
  problems?: { rowIndex: number | null; problem: string; detail?: string }[];
  /** The server-normalized lines the preview validated — the create resends
   * exactly these (a file's account names were resolved server-side). */
  lines?: {
    accountId: string;
    debit: number;
    credit: number;
    partyType: string | null;
    partyId: string | null;
    reference: string | null;
    sourceNote: string | null;
  }[];
}

interface DraftLine {
  accountId: string;
  debit: string;
  credit: string;
  reference: string;
  sourceNote: string;
  /** "" = unattributed; otherwise one of the party types (0217 constraint). */
  partyType: string;
  partyId: string;
  /** Display name for the picked party (or the fallback reference text). */
  partyName: string;
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

/** A file-import problem, as the preview screen shows it. */
function importProblemText(
  problem: { rowIndex: number | null; problem: string; detail?: string },
  unitLabel: string,
): string {
  const row = problem.rowIndex !== null ? `خط ${toPersianDigits(problem.rowIndex)}: ` : "";
  switch (problem.problem) {
    case "unsupported_format":
      return "فقط فایل CSV یا XLSX پشتیبانی می‌شود.";
    case "empty_file":
      return "فایل خالی است یا سطر سرستون ندارد.";
    case "unrecognised_headers":
      return "ستون‌های فایل شناخته نشد؛ از «کد» یا «نام»، «بدهکار» و «بستانکار» (فارسی یا انگلیسی) استفاده کنید.";
    case "missing_account_column":
      return "ستون حساب (کد یا نام) در فایل پیدا نشد.";
    case "missing_amount_columns":
      return "ستون بدهکار یا بستانکار در فایل پیدا نشد.";
    case "too_many_rows":
      return `فایل بیش از سقف مجاز (${problem.detail ? toPersianDigits(problem.detail) : "۵۰۰"}) خط دارد.`;
    case "invalid_amount":
      return `${row}مبلغ عدد صحیح ${unitLabel} نیست — ${problem.detail ?? ""}`;
    case "missing_account":
      return `${row}حساب در سرفصل پیدا نشد — ${problem.detail ?? ""}`;
    default:
      return problem.detail ?? problem.problem;
  }
}

/** Persian labels of the line attribution types (0217's party_type values). */
const PARTY_TYPE_LABELS: Record<string, string> = {
  customer: "مشتری",
  supplier: "تأمین‌کننده",
  cheque: "چک",
  fixed_asset: "دارایی ثابت",
  inventory: "موجودی",
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
  return { accountId: "", debit: "", credit: "", reference: "", sourceNote: "", partyType: "", partyId: "", partyName: "" };
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
  // The business's selected money unit: every read-out and every typed amount
  // is denominated in it, storage stays integer Rial.
  const money = useMoney();
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
  // Line attribution: a search per line (the directory is the platform's
  // /api/parties — customers for A/R lines, suppliers for A/P lines).
  const [partySearch, setPartySearch] = useState<Record<number, string>>({});
  const [partyResults, setPartyResults] = useState<Record<number, { id: string; name: string }[]>>({});
  const partySearchTimers = useRef<Record<number, number>>({});
  // Latest term per line, so a late answer for an older term never paints.
  const partySearchLatest = useRef<Record<number, string>>({});

  function setDraftLine(index: number, patch: Partial<DraftLine>) {
    setDraftLines((lines) => lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function searchLineParties(index: number, term: string) {
    const line = draftLines[index];
    if (!line || (line.partyType !== "customer" && line.partyType !== "supplier")) return;
    setPartySearch((current) => ({ ...current, [index]: term }));
    partySearchLatest.current[index] = term;
    if (partySearchTimers.current[index]) window.clearTimeout(partySearchTimers.current[index]);
    partySearchTimers.current[index] = window.setTimeout(async () => {
      try {
        const role = line.partyType === "customer" ? "Customer" : "Supplier";
        const { ok, data } = await api<{ parties?: { id: string; name: string }[] }>(
          `/api/parties?q=${encodeURIComponent(term)}&role=${role}&limit=12`,
        );
        if (partySearchLatest.current[index] !== term) return;
        setPartyResults((current) => ({
          ...current,
          [index]: ok ? (data.parties ?? []).map((p) => ({ id: p.id, name: p.name })) : [],
        }));
      } catch {
        if (partySearchLatest.current[index] !== term) return;
        setPartyResults((current) => ({ ...current, [index]: [] }));
      }
    }, 250);
  }

  function pickLineParty(index: number, id: string, name: string) {
    setDraftLine(index, { partyId: id, partyName: name });
    setPartySearch((current) => ({ ...current, [index]: "" }));
    setPartyResults((current) => ({ ...current, [index]: [] }));
  }

  function clearLineParty(index: number) {
    setDraftLine(index, { partyType: "", partyId: "", partyName: "" });
    setPartySearch((current) => ({ ...current, [index]: "" }));
    setPartyResults((current) => ({ ...current, [index]: [] }));
  }

  // Import / preview
  const [importOpen, setImportOpen] = useState(false);
  const [importMode, setImportMode] = useState<"file" | "json">("file");
  const [importFile, setImportFile] = useState<File | null>(null);
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
            // The stored amount is integer Rial; the input is denominated in
            // the business's selected unit, so convert on the way in…
            debit: l.debit === "0" ? "" : money.toInputText(l.debit),
            credit: l.credit === "0" ? "" : money.toInputText(l.credit),
            reference: l.reference ?? "",
            sourceNote: l.sourceNote ?? "",
            // …and the party attribution rides the round-trip untouched, so an
            // edit never silently un-attributes a line (0217 constraint).
            partyType: l.partyType ?? "",
            partyId: l.partyId ?? "",
            partyName: l.partyName ?? "",
          }))
        : [emptyDraftLine()],
    );
    setDraftNote(detail.set.note ?? "");
    setEditorOpen(true);
  }

  /**
   * One typed amount → integer Rial, in the business's unit. `null` means the
   * text is not a whole amount of that unit (decimal, garbage, negative, or
   * out of range) — the save is refused, never silently coerced to 0.
   */
  function parseAmount(value: string): number | null {
    const text = value.trim();
    if (text === "") return 0;
    try {
      const rial = money.parse(text);
      return rial >= 0 ? rial : null;
    } catch {
      return null;
    }
  }

  async function saveEditor() {
    if (!detail || mutation) return;
    const parsed = draftLines.map((l) => ({
      l,
      debit: parseAmount(l.debit),
      credit: parseAmount(l.credit),
    }));
    if (parsed.some((p) => p.debit === null || p.credit === null)) {
      setError(`مبالغ باید عدد صحیح به ${money.unitLabel} باشد — کسری و منفی قابل قبول نیست؛ خط نامعتبر را اصلاح کنید.`);
      return;
    }
    // A party type without a picked party would be dropped by the boundary
    // validation (0217's party-consistent rule) — say so instead of losing it.
    if (
      parsed.some(
        (p) =>
          (p.l.partyType === "customer" || p.l.partyType === "supplier") &&
          p.l.partyId.trim() === "",
      )
    ) {
      setError("برای خطی که نوع تخصیص «مشتری» یا «تأمین‌کننده» دارد، باید یک طرف انتخاب شود (یا تخصیص را خالی بگذارید).");
      return;
    }
    const lines = parsed
      .filter((p) => p.l.accountId !== "" || p.debit !== 0 || p.credit !== 0)
      .map((p) => ({
        accountId: p.l.accountId,
        debit: p.debit,
        credit: p.credit,
        partyType: p.l.partyType || null,
        partyId: p.l.partyId || null,
        reference: p.l.reference.trim() || null,
        sourceNote: p.l.sourceNote.trim() || null,
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

  /** The import source as the active mode provides it. */
  function importJsonLines(): unknown | { error: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
    } catch {
      return { error: "متن واردشده باید یک آرایهٔ JSON از خطوط باشد." };
    }
    return parsed;
  }

  async function previewImport() {
    setError("");
    setImportPreview(null);
    if (importFile === null && importMode === "file") {
      setError("فایلی انتخاب نشده است (CSV یا XLSX).");
      return;
    }
    if (importFile !== null && importMode === "file") {
      // File mode: the server parses (one codec layer, selected unit, account
      // resolution) and answers with the validated lines to confirm.
      const form = new FormData();
      form.set("file", importFile);
      form.set("fiscalYearLabel", importYear);
      form.set("effectiveDate", importDate || "");
      const { ok, data } = await api<ImportPreview & { error?: string }>(
        "/api/ledger/opening-balances/import",
        { method: "POST", body: form },
      );
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      setImportPreview(data);
      return;
    }
    const parsed = importJsonLines();
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      setError((parsed as { error: string }).error);
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
    // The preview validated these exact lines — resend them, whether they came
    // from a file (accounts resolved server-side) or the JSON textarea.
    const lines = importPreview.lines;
    if (!lines || lines.length === 0) return;
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
            lines,
            note:
              importMode === "file"
                ? `در‌آورده شده از فایل${importFile ? " «" + importFile.name + "»" : ""}`
                : "در‌آورده شده",
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
      setImportFile(null);
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
                    جمع بدهکار {money.formatText(set.totalDebit, { withUnit: false })} — بستانکار{" "}
                    {money.formatText(set.totalCredit, { withUnit: false })}
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
                      <Td>{line.debit === "0" ? "—" : money.formatText(line.debit, { withUnit: false })}</Td>
                      <Td>{line.credit === "0" ? "—" : money.formatText(line.credit, { withUnit: false })}</Td>
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
                          : `${line.debit !== "0" ? `ب‌: ${money.formatText(line.debit, { withUnit: false })} ` : ""}${line.credit !== "0" ? `س‌: ${money.formatText(line.credit, { withUnit: false })}` : ""}`}
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
                              {money.formatText(row.expectedDebit, { withUnit: false })}
                            </td>
                            <td className="py-2 pr-2 text-muted-foreground">
                              {money.formatText(row.expectedCredit, { withUnit: false })}
                            </td>
                            <td className="py-2 pr-2">{money.formatText(row.actualDebit, { withUnit: false })}</td>
                            <td className="py-2 pr-2">{money.formatText(row.actualCredit, { withUnit: false })}</td>
                            <td className={`py-2 pr-2 ${row.matched ? "text-muted-foreground" : "font-medium text-destructive"}`}>
                              {row.matched ? "—" : money.formatText(row.difference, { withUnit: false })}
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
              هر خط یک حساب، فقط یک طرف (بدهکار یا بستانکار) و مبلغ به {money.unitLabel} می‌خواهد. تخصیص خط
              (مشتری/تأمین‌کننده یا مرجع) در همین خط ویرایش می‌شود و در ذخیره حفظ می‌ماند. مجموع دو طرف باید
              برابرسند باشد.
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
                  <span className="mb-1 block text-xs font-medium text-foreground">{`بدهکار (${money.unitLabel})`}</span>
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
                  <span className="mb-1 block text-xs font-medium text-foreground">{`بستانکار (${money.unitLabel})`}</span>
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
                <div className="sm:col-span-3 rounded-lg border border-dashed border-border/80 p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2 text-xs font-medium text-foreground">
                      تخصیص (اختیاری)
                      <select
                        className={`${inputClass} h-8 w-44 text-xs`}
                        value={line.partyType}
                        onChange={(event) =>
                          setDraftLine(index, {
                            partyType: event.target.value,
                            partyId: "",
                            partyName: "",
                          })
                        }
                      >
                        <option value="">بدون تخصیص</option>
                        <option value="customer">مشتری</option>
                        <option value="supplier">تأمین‌کننده</option>
                        {line.partyType !== "" &&
                        line.partyType !== "customer" &&
                        line.partyType !== "supplier" ? (
                          <option value={line.partyType}>
                            {PARTY_TYPE_LABELS[line.partyType] ?? line.partyType}
                          </option>
                        ) : null}
                      </select>
                    </label>
                    {line.partyType === "customer" || line.partyType === "supplier" ? (
                      <div className="min-w-52 flex-1">
                        <input
                          className={inputClass}
                          value={partySearch[index] ?? ""}
                          placeholder={
                            line.partyType === "customer" ? "جست‌وجوی مشتری…" : "جست‌وجوی تأمین‌کننده…"
                          }
                          onChange={(event) => searchLineParties(index, event.target.value)}
                          aria-label={
                            line.partyType === "customer"
                              ? `جست‌وجوی مشتری خط ${index + 1}`
                              : `جست‌وجوی تأمین‌کننده خط ${index + 1}`
                          }
                        />
                        {(partyResults[index] ?? []).length > 0 ? (
                          <ul
                            className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-border/80 bg-background"
                            role="listbox"
                          >
                            {(partyResults[index] ?? []).map((party) => (
                              <li key={party.id}>
                                <button
                                  type="button"
                                  className="w-full px-3 py-1.5 text-right text-xs hover:bg-muted/60"
                                  onClick={() => pickLineParty(index, party.id, party.name)}
                                >
                                  {party.name}
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    ) : null}
                    {line.partyId !== "" ? (
                      <span className="flex items-center gap-1 rounded-full bg-muted/70 px-2 py-0.5 text-xs">
                        {PARTY_TYPE_LABELS[line.partyType] ?? ""} {line.partyName || "—"}.
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => clearLineParty(index)}
                          aria-label={`حذف تخصیص خط ${index + 1}`}
                        >
                          ✕
                        </button>
                      </span>
                    ) : null}
                    <label className="flex items-center gap-2 text-xs font-medium text-foreground">
                      مرجع
                      <input
                        className={`${inputClass} h-8 w-40 text-xs`}
                        value={line.reference}
                        onChange={(event) => setDraftLine(index, { reference: event.target.value })}
                        aria-label={`مرجع خط ${index + 1}`}
                      />
                    </label>
                  </div>
                </div>
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
              فایل CSV یا XLSX (ستون‌های «کد یا نام»، «بدهکار»، «بستانکار» و اختیاری «مرجع»/«توضیح»؛ مبالغ به{" "}
              {money.unitLabel}) انتخاب کنید یا آرایهٔ JSON بچسبانید؛ پیش از ثبت، همان اعتبارسنجی سرور — جمع‌ها،
              تفکیک به حساب و اولین ایراد — پیش‌نمایش داده می‌شود و هیچ چیز ذخیره نمی‌شود.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-1 rounded-lg bg-muted/60 p-1" role="tablist" aria-label="نحوهٔ در‌آوردن">
            <button
              type="button"
              role="tab"
              aria-selected={importMode === "file"}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors ${
                importMode === "file" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setImportMode("file")}
            >
              فایل (CSV / XLSX)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={importMode === "json"}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors ${
                importMode === "json" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setImportMode("json")}
            >
              آرایهٔ JSON
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="سال مالی" hint="چهار رقم شمسی">
              <input className={inputClass} inputMode="numeric" maxLength={4} value={importYear} onChange={(event) => setImportYear(event.target.value)} />
            </Field>
            <Field label="تاریخ مؤثر">
              <JalaliDatePicker
                className={inputClass}
                value={importDate}
                onChange={(iso) => setImportDate(iso)}
                ariaLabel="تاریخ مؤثر ترازات"
                placeholder="انتخاب تاریخ"
              />
            </Field>
          </div>
          {importYear.length === 4 &&
          importDate !== "" &&
          !effectiveDateMatchesFiscalYear(importYear, importDate) ? (
            <p className="text-xs text-destructive">{errorMessage("effective_date_outside_fiscal_year")}</p>
          ) : null}
          {importMode === "file" ? (
            <label className="block cursor-pointer rounded-xl border border-dashed border-border/80 p-4 text-center transition-colors hover:border-primary/50">
              <span className="block text-sm font-medium text-foreground">انتخاب فایل</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                CSV یا XLSX — حداکثر ۵۰۰ خط؛ مبالغ در واحد {money.unitLabel}
              </span>
              <input
                type="file"
                className="mt-3 block w-full cursor-pointer text-xs text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary"
                accept=".csv,.txt,.xlsx"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setImportFile(file);
                  setImportPreview(null);
                  if (file && !/\.(csv|txt|xlsx)$/i.test(file.name)) {
                    setError("فقط فایل CSV یا XLSX پشتیبانی می‌شود.");
                  }
                  event.target.value = "";
                }}
              />
            </label>
          ) : (
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
          )}
          {importFile ? (
            <p className="text-xs text-muted-foreground">
              فایل انتخاب‌شده: {importFile.name} —{" "}
              {toPersianDigits(Math.max(1, Math.round(importFile.size / 1024)))} کیلوبایت
            </p>
          ) : null}
          {importPreview ? (
            <div className="rounded-xl border border-border/80 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <StatusBadge tone={importPreview.valid ? "positive" : "danger"} dot>
                  {importPreview.valid
                    ? `آمادهٔ ساخت — ${toPersianDigits(importPreview.lineCount)} خط`
                    : "این مجموعه معتبر نیست"}
                </StatusBadge>
                <span className="text-xs text-muted-foreground">
                  بدهکار {money.formatText(importPreview.totalDebit, { withUnit: false })} — بستانکار{" "}
                  {money.formatText(importPreview.totalCredit, { withUnit: false })}
                </span>
              </div>
              {importPreview.problem ? (
                <p className="mt-2 text-xs text-destructive">{errorMessage(importPreview.problem)}</p>
              ) : null}
              {importPreview.problems && importPreview.problems.length > 0 ? (
                <ul className="mt-2 max-h-40 list-inside list-disc space-y-1 overflow-y-auto text-xs text-destructive">
                  {importPreview.problems.map((problem, i) => (
                    <li key={i}>{importProblemText(problem, money.unitLabel)}</li>
                  ))}
                </ul>
              ) : null}
              <ul className="mt-2 max-h-40 list-inside list-disc space-y-1 overflow-y-auto text-xs text-muted-foreground">
                {importPreview.accounts.map((account) => (
                  <li key={account.accountId}>
                    {account.code} — {account.name}: بدهکار {money.formatText(account.debit, { withUnit: false })}، بستانکار{" "}
                    {money.formatText(account.credit, { withUnit: false })}
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
                جمع بدهکار: {money.formatText(printData.set.totalDebit, { withUnit: false })} — جمع بستانکار:{" "}
                {money.formatText(printData.set.totalCredit, { withUnit: false })}
              </p>
              <p>تاریخ تولید: {toPersianDigits(formatJalali(new Date(), { withMonthName: true }))}</p>
            </header>
            <table>
              <thead>
                <tr>
                  <th>حساب</th>
                  <th>مشخصه</th>
                  <th>توضیح</th>
                  <th>{`بدهکار (${money.unitLabel})`}</th>
                  <th>{`بستانکار (${money.unitLabel})`}</th>
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
                      {line.debit === "0" ? "—" : money.formatText(line.debit, { withUnit: false })}
                    </td>
                    <td className={printStyles.num}>
                      {line.credit === "0" ? "—" : money.formatText(line.credit, { withUnit: false })}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={3}>جمع</th>
                  <td className={printStyles.num}>
                    {money.formatText(printData.set.totalDebit, { withUnit: false })}
                  </td>
                  <td className={printStyles.num}>
                    {money.formatText(printData.set.totalCredit, { withUnit: false })}
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
                          {row.expectedDebit === "0" ? "—" : money.formatText(row.expectedDebit, { withUnit: false })}
                        </td>
                        <td className={printStyles.num}>
                          {row.expectedCredit === "0" ? "—" : money.formatText(row.expectedCredit, { withUnit: false })}
                        </td>
                        <td className={printStyles.num}>
                          {row.actualDebit === "0" ? "—" : money.formatText(row.actualDebit, { withUnit: false })}
                        </td>
                        <td className={printStyles.num}>
                          {row.actualCredit === "0" ? "—" : money.formatText(row.actualCredit, { withUnit: false })}
                        </td>
                        <td className={printStyles.num}>
                          {row.difference === "0" ? "—" : money.formatText(row.difference, { withUnit: false })}
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
