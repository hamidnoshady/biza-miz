"use client";

import { cardClass, EmptyState, LoadingSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DimensionFields, useDimensionCatalog } from "./dimension-fields";
import { dimensionPayload, enabledDimensionKinds, type DimensionDraft } from "./dimension-catalog";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { Button } from "@/components/ui/button";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import { api, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import {
  MANUAL_LINES_MAX,
  MANUAL_MEMO_MAX,
  MANUAL_REJECTION_REASON_MAX,
  canDecideOnDraft,
  manualDocumentProblem,
  manualJournalTotals,
  type ManualJournalProblem,
} from "@/lib/manual-journal";
import { provenanceLabel, provenanceOfMemo } from "@/lib/ai-provenance";
import type { AccountRow, Runner } from "./accounting-manager";

interface DraftLineInput {
  accountId: string;
  side: "debit" | "credit";
  amount: string;
  /** Issue #868 — the line's cost centre / profit centre / department / detail, one per kind. */
  dimensions: DimensionDraft;
}

const EMPTY_LINE: DraftLineInput = { accountId: "", side: "debit", amount: "", dimensions: {} };

/** A blank document: one debit row and one credit row, the shape of every entry. */
function blankLines(): DraftLineInput[] {
  return [
    { ...EMPTY_LINE, side: "debit" },
    { ...EMPTY_LINE, side: "credit" },
  ];
}

interface DraftLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
}
interface JournalDraft {
  id: string;
  entryDate: string | null;
  locationId: string | null;
  locationName: string | null;
  memo: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  proposedBy: string | null;
  proposedByName: string | null;
  proposedAt: string | null;
  lines: DraftLine[];
}

interface DraftPage {
  drafts: JournalDraft[];
  total: number;
  hasMore: boolean;
  limit: number;
  offset: number;
  activeLocation: { id: string; name: string } | null;
}

const PAGE_SIZE = 25;

const SIDE_OPTIONS = [
  { value: "debit", label: "بدهکار" },
  { value: "credit", label: "بستانکار" },
];

/**
 * What each refusal from `manualDocumentProblem` means to the person typing.
 * `not_balanced` is handled at the call site instead, because it can name the
 * actual difference — the one number that makes the problem fixable.
 */
const DOCUMENT_PROBLEM_TEXT: Record<ManualJournalProblem, string> = {
  no_lines: "حداقل دو ردیف کامل (حساب و مبلغ) لازم است.",
  too_few_lines: "حداقل دو ردیف کامل (حساب و مبلغ) لازم است.",
  too_many_lines: `تعداد ردیف‌ها بیش از حد مجاز (${toPersianDigits(String(MANUAL_LINES_MAX))} ردیف) است.`,
  single_account_entry: "سند باید حداقل به دو حساب متفاوت بخورد.",
  invalid_line: "یکی از ردیف‌ها معتبر نیست؛ حساب و مبلغ آن را بررسی کنید.",
  not_balanced: "سند متوازن نیست.",
};

/** «۳ روز پیش» — the age a reviewer needs before they can call a draft stale. */
function ageLabel(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return "امروز";
  if (days === 1) return "دیروز";
  return `${toPersianDigits(String(days))} روز پیش`;
}

/** A draft's id is a UUID; the first group is enough to find one in a list. */
function shortRef(id: string): string {
  return id.slice(0, 8);
}

/**
 * A key that is stable across a retry of *this* document and changes the moment
 * the document does.
 *
 * Two `POST /api/ledger/entries/drafts` with the same key create one draft; a
 * busy spinner is not enough protection on its own, because the requests that
 * duplicate a draft are the ones the person never saw — a fetch retried after a
 * dropped connection, a double-submitted form, a reconnecting client. Keying on
 * the payload's own signature also means an unchanged re-submit cannot post the
 * same document twice, while editing a single figure mints a fresh key.
 */
function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Generic balanced multi-line journal entry — covers both "manual expense
 * entry" (two lines: debit an expense account, credit Cash/Bank) and
 * anything else not auto-generated (e.g. settling tax payable: debit Tax
 * Payable, credit Cash/Bank). Submitting only drafts it — see the review
 * queue below, since posting it for real needs someone holding
 * ledger.approve (Phase 16's draft → review → post workflow).
 *
 * Two rules this screen has to keep, and the bugs that came from missing them:
 *
 *  - **The screen's arithmetic must be the server's.** The summary panel is the
 *    only check most people read before pressing «ثبت پیش‌نویس», so anything it
 *    calls «متوازن» has to be something the API will actually accept. It used
 *    to call a one-account document balanced, and a document whose amount field
 *    held unparseable text balanced-at-zero, and both came back as a red error
 *    under a green summary.
 *  - **A row is identified by identity, not by index.** The rows were keyed by
 *    array position, so deleting row 2 of 4 re-labelled every row under it and
 *    React re-used the deleted row's DOM node — the account you had picked in
 *    row 3 appeared to move up into the row you just emptied.
 *
 * And one rule about its own controls: every button inside this form that is
 * not the submit button says `type="button"`. A `<button>` inside a `<form>` is
 * `type="submit"` by default, so «افزودن ردیف» once both added a row *and*
 * submitted the document underneath — a draft created by a person who was still
 * reaching for the next row.
 */
export function ManualEntrySection({
  accounts,
  busy,
  run,
  refreshKey,
  canPropose,
  canApprove,
  currentUserId,
}: {
  accounts: AccountRow[];
  busy: boolean;
  run: Runner;
  refreshKey: number;
  /**
   * Whether this member may draft a journal (`ledger.propose`).
   *
   * Required, not optional, and `false` when the page could not read the
   * member's permissions. The page opens on `ledger.view`, so a read-only
   * reviewer reaches a screen that draws a complete, live-looking form and
   * answers 403 only after «ثبت پیش‌نویس» — read-only has to look read-only.
   * The alternative (drawing the button and letting the API refuse) was the
   * bug, not the guard.
   */
  canPropose: boolean;
  /**
   * Whether this member may turn a draft into a real posting (`ledger.approve`).
   * «تأیید و ثبت» is that permission's button, not the app door's: a manager
   * reaches this screen and may draft, but approving answered 403 from a
   * control that looked live.
   */
  canApprove: boolean;
  /**
   * Who is looking. `DELETE …/drafts/{id}` allows the drafter to discard their
   * own draft without `ledger.approve`, so «رد کردن» can only be hidden on
   * someone else's draft — hiding it on all of them would take away an action
   * the server permits.
   */
  currentUserId: string;
}) {
  const money = useMoney();
  const formId = useId();
  const [memo, setMemo] = useState("");
  const [entryDate, setEntryDate] = useState("");
  /*
   * Each row carries its own `key`. See the docblock: an index key made React
   * re-use a removed row's DOM node, so the row *below* a deletion appeared to
   * inherit the deleted row's account.
   */
  const nextKey = useRef(0);
  const makeKey = () => `line-${nextKey.current++}`;
  // Issue #868: the enabled dimension kinds and their values. Read once; a
  // business that never enabled one gets an empty catalogue and no extra fields.
  const dimensionCatalog = useDimensionCatalog();
  const dimensionKinds = enabledDimensionKinds(dimensionCatalog.settings);
  const [lines, setLines] = useState<{ key: string; value: DraftLineInput }[]>(() =>
    blankLines().map((value) => ({ key: makeKey(), value })),
  );
  const [page, setPage] = useState<DraftPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [localError, setLocalError] = useState("");
  const [notice, setNotice] = useState("");
  /** The draft whose row action is in flight, so only its own buttons go busy. */
  const [pendingDraftId, setPendingDraftId] = useState<string | null>(null);
  /** The row a reviewer pressed «رد کردن» on — discarding is confirmed, not instant. */
  const [confirmRejectId, setConfirmRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  /** The idempotency key for the document currently on screen, keyed by its content. */
  const idempotencyRef = useRef<{ signature: string; key: string } | null>(null);

  const loadDrafts = useCallback(() => {
    let cancelled = false;
    api<DraftPage>(`/api/ledger/entries/drafts?limit=${PAGE_SIZE}&offset=${offset}`).then(({ ok, data }) => {
      if (cancelled) return;
      if (ok) {
        /*
         * Rejecting the last draft on the last page leaves `offset` past the
         * end of a now-shorter queue: the page comes back empty while
         * «۵۰ سند» still says there are fifty, and the screen reads as an
         * emptied queue with work left in it. Step back to the last real page.
         */
        if (data.drafts.length === 0 && data.total > 0 && data.offset >= data.total) {
          const lastPage = Math.max(0, Math.floor((data.total - 1) / data.limit) * data.limit);
          if (lastPage !== data.offset) {
            setOffset(lastPage);
            return;
          }
        }
        setPage(data);
        setLocalError("");
      } else {
        // An endless skeleton reads as "still loading"; say what happened instead.
        setPage({ drafts: [], total: 0, hasMore: false, limit: PAGE_SIZE, offset, activeLocation: null });
        setLocalError("بارگذاری پیش‌نویس‌ها ناموفق بود.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [offset]);

  useEffect(loadDrafts, [loadDrafts, refreshKey]);

  /*
   * Only the *postable* accounts belong in the picker. A parent account
   * («۱۰۰۰ دارایی‌ها», «۵۰۰۰ هزینه‌ها») is a heading that totals its children;
   * posting to it is accepted by the database but corrupts every rollup that
   * sums children into a parent, and the chart-of-accounts screen already draws
   * the same distinction.
   *
   * `is_postable` is the server's answer and the picker defers to it. Deriving
   * "leaf" here instead — from the active accounts only, the codes nothing else
   * names as a parent — disagreed with the server exactly once and that was
   * enough: a parent whose only child had been archived was not a parent in the
   * active subset, so it was offered here and refused at approval time with
   * `not_a_leaf_account`, by the reviewer rather than by the person typing.
   * The fallback is only for a caller whose payload predates the column.
   */
  const postableAccounts = useMemo(() => {
    if (accounts.some((a) => typeof a.is_postable === "boolean")) {
      return accounts.filter((a) => a.is_postable === true);
    }
    const parents = new Set(accounts.map((a) => a.parent_code).filter(Boolean));
    return accounts.filter((a) => !parents.has(a.code));
  }, [accounts]);

  const accountOptions = useMemo(
    () => [
      { value: "", label: "انتخاب حساب" },
      ...postableAccounts.map((a) => ({
        value: a.id,
        label: `${a.code} — ${a.name}`,
        // Searching the code *and* the name: an accountant types «۱۱۰۰», a
        // manager types «صندوق», and both should find the same row.
        searchString: `${a.code} ${a.name}`,
      })),
    ],
    [postableAccounts],
  );

  function updateLine(key: string, patch: Partial<DraftLineInput>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, value: { ...l.value, ...patch } } : l)));
  }
  function addLine() {
    setLines((prev) =>
      prev.length >= MANUAL_LINES_MAX ? prev : [...prev, { key: makeKey(), value: { ...EMPTY_LINE } }],
    );
  }
  function removeLine(key: string) {
    setLines((prev) => (prev.length <= 2 ? prev : prev.filter((l) => l.key !== key)));
  }

  /*
   * The totals count only the rows that will actually be *submitted* — a row
   * needs both an account and an amount to become a line.
   *
   * Counting every row instead let the screen say «متوازن» for a document the
   * server was bound to refuse: type an amount, forget the account, and the
   * amount joined the total on screen but was filtered out of the payload, so
   * pressing «ثبت پیش‌نویس» returned `not_balanced` with the summary above it
   * still reading balanced. `incompleteLines` names that state instead.
   */
  const rows = lines.map((l) => l.value);
  /**
   * `null` for an amount the money parser refuses. It used to be coerced to 0,
   * so a typo («۱۲۳x۰۰۰», a pasted «۱۲۳٬۰۰۰ تومان») silently contributed
   * nothing to a total that still called itself balanced. A row that cannot be
   * read is a row the person has to fix, not a zero.
   */
  function amountOf(line: DraftLineInput): number | null {
    if (!line.amount.trim()) return null;
    try {
      const rial = money.parse(line.amount);
      return Number.isSafeInteger(rial) && rial > 0 ? rial : null;
    } catch {
      return null;
    }
  }

  const payloadLines = rows.filter((l) => l.accountId && amountOf(l) !== null);
  const incompleteLines = rows.filter(
    (l) => (l.accountId && !l.amount.trim()) || (!l.accountId && l.amount.trim()),
  ).length;
  /** Rows with an unreadable or non-positive amount — «۰», «-۵», «۱۲x». */
  const invalidAmountLines = rows.filter((l) => l.amount.trim() && amountOf(l) === null).length;

  /** The payload exactly as `submit` will send it, so the check below judges the real thing. */
  const journalLines = payloadLines.map((l) => {
    const rial = amountOf(l) ?? 0;
    const dimensions = dimensionPayload(l.dimensions);
    return {
      accountId: l.accountId,
      debit: l.side === "debit" ? rial : 0,
      credit: l.side === "credit" ? rial : 0,
      // Sent only when the line names a value, so an unattributed line is the same document it always was.
      ...(dimensions ? { dimensions } : {}),
    };
  });

  /*
   * The totals are the shared module's BigInt arithmetic, not a second sum done
   * in JS numbers. With two hundred rows near the top of the legal range the
   * aggregate passes `Number.MAX_SAFE_INTEGER`, and a `number` total then
   * rounds two genuinely different sides into the same figure — «متوازن» for a
   * document the server's own BigInt comparison refuses. `formatText` takes the
   * exact value as a string, so nothing is narrowed on its way to the screen.
   */
  const totals = manualJournalTotals(journalLines);
  const differenceText = (() => {
    const abs = totals.difference < 0n ? -totals.difference : totals.difference;
    return money.formatText(abs.toString());
  })();
  const differenceIsDebit = totals.difference > 0n;

  /*
   * The verdict comes from the same function the API validates with
   * (`@/lib/manual-journal`), not from a second implementation of the rules
   * here — a screen that grades a document more leniently than the server is
   * how «متوازن» ended up sitting above a `not_balanced` error.
   */
  const documentProblem = manualDocumentProblem(journalLines);
  const balanced = documentProblem === null;
  const memoTooLong = memo.trim().length > MANUAL_MEMO_MAX;
  const canSubmit =
    canPropose &&
    balanced &&
    !!memo.trim() &&
    !memoTooLong &&
    invalidAmountLines === 0 &&
    /*
     * A half-typed row used to be silently dropped: `submit` filtered the rows
     * down to the complete ones, so a balanced document plus one row with only
     * an amount on it submitted cleanly and the row vanished on reset. The
     * summary now treats "there is a row you have not finished" as a reason
     * not to submit, the same way it treats an unbalanced document.
     */
    incompleteLines === 0;

  /** Why «ثبت پیش‌نویس» is disabled, in the order a person would fix the problems. */
  const blockingReason = (() => {
    if (!canPropose) return "";
    if (!memo.trim()) return "شرح سند را بنویسید.";
    if (memoTooLong)
      return `شرح سند حداکثر ${toPersianDigits(String(MANUAL_MEMO_MAX))} نویسه است.`;
    if (invalidAmountLines > 0)
      return `${toPersianDigits(String(invalidAmountLines))} ردیف مبلغ نامعتبر دارد؛ مبلغ باید عددی بزرگ‌تر از صفر باشد.`;
    if (incompleteLines > 0)
      return `${toPersianDigits(String(incompleteLines))} ردیف ناقص است (حساب یا مبلغ ندارد)؛ آن را کامل کنید یا حذفش کنید.`;
    if (documentProblem === "not_balanced")
      return `سند متوازن نیست؛ اختلاف ${differenceText} ${
        differenceIsDebit ? "در سمت بدهکار" : "در سمت بستانکار"
      } است.`;
    return documentProblem ? DOCUMENT_PROBLEM_TEXT[documentProblem] : "";
  })();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setNotice("");
    setLocalError("");
    if (!canSubmit) return;
    const signature = JSON.stringify({ memo: memo.trim(), entryDate, lines: journalLines });
    const stable =
      idempotencyRef.current?.signature === signature
        ? idempotencyRef.current.key
        : newIdempotencyKey();
    idempotencyRef.current = { signature, key: stable };
    const ok = await run(() =>
      api("/api/ledger/entries/drafts", {
        method: "POST",
        body: JSON.stringify({
          memo: memo.trim(),
          entryDate: entryDate || undefined,
          lines: journalLines,
          idempotencyKey: stable,
        }),
      }),
    );
    if (ok) {
      setMemo("");
      setEntryDate("");
      setLines(blankLines().map((value) => ({ key: makeKey(), value })));
      // The document changed, so the next submit is a new document, not a retry.
      idempotencyRef.current = null;
      setOffset(0);
      // Saving used to look identical to nothing happening: the form emptied,
      // the new draft appeared somewhere down the page, and no word was said.
      setNotice("پیش‌نویس سند ثبت شد و در فهرست «در انتظار بررسی» پایین همین صفحه است.");
    }
  }

  async function approve(id: string) {
    setLocalError("");
    setNotice("");
    setPendingDraftId(id);
    const ok = await run(() => api(`/api/ledger/entries/drafts/${id}/approve`, { method: "POST" }));
    setPendingDraftId(null);
    if (ok) setNotice("سند تأیید و در دفاتر ثبت شد.");
  }

  async function reject(id: string) {
    setLocalError("");
    setNotice("");
    setPendingDraftId(id);
    // Through the shared runner, like approve: it surfaces the error and bumps
    // refreshKey, which refetches this queue — a rejected draft has to leave the
    // AI review queue too, not just this list.
    const ok = await run(() =>
      api(`/api/ledger/entries/drafts/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: rejectReason.trim() || null }),
      }),
    );
    setPendingDraftId(null);
    setConfirmRejectId(null);
    setRejectReason("");
    if (ok) setNotice("پیش‌نویس رد و حذف شد؛ علت آن در تاریخچه نگهداری می‌شود.");
  }

  const hasNoPostableAccounts = postableAccounts.length === 0;
  const drafts = page?.drafts ?? null;
  const activeLocation = page?.activeLocation ?? null;

  return (
    <div className="space-y-4">
      <section aria-labelledby={`${formId}-heading`} className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سند دستی</p>
          <h2 id={`${formId}-heading`} className="mt-1 text-base font-semibold text-foreground">
            ثبت سند دستی (پیش‌نویس)
          </h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            سند ابتدا به‌صورت پیش‌نویس ذخیره می‌شود و تا تأیید در فهرست پایین، اثری در دفاتر ندارد.
          </p>
          {/* Which branch this draft will post to. The queue below is
              business-wide, so a document can be drafted here and approved by
              somebody whose own branch is a different one — and approval posts
              to the draft's branch, not theirs. */}
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            شعبهٔ ثبت:{" "}
            <span className="font-semibold text-foreground">
              {activeLocation ? activeLocation.name : "تعیین نشده"}
            </span>
          </p>
        </header>

        {notice ? (
          <p
            role="status"
            className="mx-4 mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 sm:mx-5 dark:text-emerald-300"
          >
            {notice}
          </p>
        ) : null}

        {!canPropose ? (
          /* Read-only is read-only on screen, not only in the API. The page
             opens on ledger.view, so a reviewer without ledger.propose used to
             get a full live form and a 403 after typing a whole document. */
          <p className="mx-4 mt-4 rounded-xl border border-border/80 bg-muted/60 px-3 py-2 text-sm leading-6 text-muted-foreground sm:mx-5">
            شما دسترسی «پیشنهاد سند» ندارید؛ این صفحه فقط برای مشاهده و بررسی پیش‌نویس‌هاست.
          </p>
        ) : null}

        {canPropose && hasNoPostableAccounts ? (
          <p className="mx-4 mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-950 sm:mx-5 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200">
            هیچ حساب قابل ثبتی در سرفصل حساب‌ها وجود ندارد؛ ابتدا از «سرفصل حساب‌ها» حساب تعریف کنید.
          </p>
        ) : null}

        {canPropose ? (
        <form onSubmit={submit} className="space-y-4 p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-foreground">شرح سند</span>
              <input
                className={inputClass}
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="مثلاً: تسویه مالیات بر ارزش افزوده اسفند"
                maxLength={MANUAL_MEMO_MAX}
                required
                aria-describedby={`${formId}-memo-hint`}
              />
              <span id={`${formId}-memo-hint`} className="mt-1 block text-xs text-muted-foreground">
                {memoTooLong
                  ? `حداکثر ${toPersianDigits(String(MANUAL_MEMO_MAX))} نویسه.`
                  : "شرحی که بعداً در دفتر روزنامه خوانده می‌شود."}
              </span>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-foreground">تاریخ سند</span>
              <JalaliDatePicker value={entryDate} onChange={setEntryDate} placeholder="امروز" />
              {/* «امروز» is resolved the moment the draft is saved, in this
                  branch's own calendar, and stays with the document. Saying
                  only «خالی یعنی امروز» left open when "today" was decided —
                  and it used to be decided at approval, so a draft created on
                  the 30th and approved on the 1st posted on the 1st. */}
              <span className="mt-1 block text-xs text-muted-foreground">
                خالی یعنی امروزِ این شعبه؛ تاریخ همین حالا در پیش‌نویس ثبت می‌شود و با تأیید عوض نمی‌شود.
              </span>
            </label>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">ردیف‌های سند</h3>
              <span className="text-xs text-muted-foreground">
                حداقل دو ردیف روی دو حساب متفاوت لازم است
              </span>
            </div>

            {/* From `lg` up the rows read as one table with a single header, the
                way a voucher is written on paper; below that each row keeps its
                own labelled fields, because four inputs squeezed into a phone
                width is how a «طرف» select ends up 60px wide. */}
            <div
              className="hidden gap-3 px-3 text-xs font-medium text-muted-foreground lg:grid lg:grid-cols-[minmax(0,2fr)_9rem_minmax(0,1fr)_2.75rem]"
              aria-hidden="true"
            >
              <span>حساب</span>
              <span>طرف</span>
              <span>مبلغ ({money.unitLabel})</span>
              <span className="text-center">حذف</span>
            </div>

            <ul className="space-y-3">
              {lines.map(({ key, value: line }, i) => {
                const rowNumber = toPersianDigits(String(i + 1));
                const amount = amountOf(line);
                const amountInvalid = !!line.amount.trim() && amount === null;
                return (
                  <li
                    key={key}
                    className="rounded-xl border border-border/80 bg-muted/60 p-3 lg:border-transparent lg:bg-transparent lg:p-0 dark:lg:bg-transparent"
                  >
                    <p className="mb-2 text-xs font-semibold text-muted-foreground lg:hidden">
                      ردیف {rowNumber}
                    </p>
                    <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_9rem_minmax(0,1fr)_2.75rem] lg:items-center lg:gap-3">
                      <label className="block">
                        <span className="mb-1.5 block text-sm font-medium text-foreground lg:sr-only">
                          حساب ردیف {rowNumber}
                        </span>
                        <SearchableSelect
                          value={line.accountId}
                          onChange={(v) => updateLine(key, { accountId: v })}
                          options={accountOptions}
                          ariaLabel={`حساب ردیف ${rowNumber}`}
                          searchPlaceholder="کد یا نام حساب…"
                          disabled={hasNoPostableAccounts}
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1.5 block text-sm font-medium text-foreground lg:sr-only">
                          طرف ردیف {rowNumber}
                        </span>
                        <SearchableSelect
                          value={line.side}
                          onChange={(v) => updateLine(key, { side: v as "debit" | "credit" })}
                          options={SIDE_OPTIONS}
                          ariaLabel={`طرف ردیف ${rowNumber}`}
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1.5 block text-sm font-medium text-foreground lg:sr-only">
                          مبلغ ردیف {rowNumber} ({money.unitLabel})
                        </span>
                        <PersianNumberInput
                          className={inputClass}
                          dir="ltr"
                          inputMode="numeric"
                          allowDecimal={false}
                          allowNegative={false}
                          value={line.amount}
                          onChange={(e) => updateLine(key, { amount: e.target.value })}
                          placeholder="۰"
                          aria-label={`مبلغ ردیف ${rowNumber} به ${money.unitLabel}`}
                          aria-invalid={amountInvalid || undefined}
                        />
                      </label>
                      {/* An icon-only control on a 44px target — a full «حذف»
                          button per row pushed the amount field off a phone. */}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeLine(key)}
                        disabled={lines.length <= 2}
                        aria-label={`حذف ردیف ${rowNumber}`}
                        title={lines.length <= 2 ? "سند باید حداقل دو ردیف داشته باشد" : "حذف این ردیف"}
                        className="justify-self-end text-muted-foreground hover:text-destructive lg:justify-self-center"
                      >
                        <Trash2Icon aria-hidden="true" />
                      </Button>
                    </div>
                    {dimensionKinds.length > 0 ? (
                      <div className="mt-3">
                        <DimensionFields
                          idPrefix={`line-dimensions-${key}`}
                          catalog={dimensionCatalog}
                          locationId={activeLocation?.id ?? null}
                          value={line.dimensions}
                          onChange={(next) => updateLine(key, { dimensions: next })}
                          rowLabel={rowNumber}
                          kinds={dimensionKinds}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            {/* `type="button"`: a <button> inside a <form> submits by default,
                so this one used to add a row *and* file the draft underneath. */}
            <SecondaryButton type="button" onClick={addLine} disabled={lines.length >= MANUAL_LINES_MAX}>
              <PlusIcon aria-hidden="true" className="size-4" />
              افزودن ردیف
            </SecondaryButton>
          </div>

          <div className="rounded-xl border border-border/80 bg-muted/60 p-4">
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">جمع بدهکار</dt>
                <dd className="mt-1 font-bold tabular-nums text-foreground">
                  {money.formatText(totals.totalDebit.toString())}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">جمع بستانکار</dt>
                <dd className="mt-1 font-bold tabular-nums text-foreground">
                  {money.formatText(totals.totalCredit.toString())}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">وضعیت سند</dt>
                <dd className="mt-1">
                  <StatusBadge tone={balanced ? "positive" : "neutral"}>
                    {balanced ? "متوازن" : "در انتظار توازن"}
                  </StatusBadge>
                </dd>
                {/* The difference, not just "not balanced yet": the number a
                    person needs in order to fix it was the one thing the
                    summary never said. */}
                {!balanced && totals.difference !== 0n ? (
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    اختلاف: <span className="tabular-nums">{differenceText}</span>
                    {differenceIsDebit ? " (بدهکار بیشتر است)" : " (بستانکار بیشتر است)"}
                  </p>
                ) : null}
              </div>
            </dl>
            {/* One live region for everything the summary has to say, so a
                screen reader hears the balance change as it is typed. */}
            <div role="status" aria-live="polite" className="empty:hidden">
              {incompleteLines > 0 ? (
                <p className="mt-3 text-xs leading-5 text-amber-700 dark:text-amber-300">
                  {toPersianDigits(String(incompleteLines))} ردیف ناقص است (حساب یا مبلغ ندارد) و مانع ثبت سند
                  است.
                </p>
              ) : null}
              {invalidAmountLines > 0 ? (
                <p className="mt-1 text-xs leading-5 text-destructive">
                  {toPersianDigits(String(invalidAmountLines))} ردیف مبلغ نامعتبر دارد؛ مبلغ باید عددی بزرگ‌تر از صفر باشد.
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-[12rem] flex-1 sm:max-w-xs">
              <PrimaryButton disabled={busy || !canSubmit}>
                {busy ? "در حال ثبت…" : "ثبت پیش‌نویس"}
              </PrimaryButton>
            </div>
            {/* A disabled button with no reason beside it is the screen refusing
                to say what is wrong. */}
            {blockingReason && !busy ? (
              <p className="text-xs leading-5 text-muted-foreground">{blockingReason}</p>
            ) : null}
          </div>
        </form>
        ) : null}
      </section>

      <section aria-labelledby={`${formId}-queue-heading`} className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">کنترل و تأیید</p>
          <h2 id={`${formId}-queue-heading`} className="mt-1 text-base font-semibold text-foreground">
            پیش‌نویس‌های در انتظار بررسی
            {page && page.total > 0 ? (
              <span className="ms-2 text-sm font-normal text-muted-foreground">
                ({toPersianDigits(String(page.total))} سند)
              </span>
            ) : null}
          </h2>
          {!canApprove ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              شما دسترسی «تأیید سند» ندارید؛ می‌توانید پیش‌نویس ثبت کنید و پیش‌نویس‌های خودتان را رد کنید.
            </p>
          ) : null}
        </header>
        <div className="p-4 sm:p-5">
          {localError ? (
            <p role="alert" className="mb-3 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {localError}
            </p>
          ) : null}
          {!drafts ? (
            <LoadingSkeleton rows={3} label="در حال بارگذاری پیش‌نویس‌ها" />
          ) : drafts.length === 0 ? (
            <EmptyState>پیش‌نویسی در انتظار بررسی وجود ندارد.</EmptyState>
          ) : (
            <ul className="space-y-3">
              {drafts.map((d) => {
                const rowBusy = pendingDraftId === d.id;
                /*
                 * The same exact arithmetic as the form above, for the same
                 * reason: `reduce` over JS numbers rounded two different sides
                 * into one figure once a document was big enough, so the number
                 * a reviewer trusted was the one the server disagreed with.
                 */
                const total = manualJournalTotals(d.lines).totalDebit.toString();
                const confirming = confirmRejectId === d.id;
                // The route's own rule, imported rather than mirrored — the
                // screen used to keep a hand-written copy of it, which is how
                // it came to offer (and hide) the wrong buttons.
                const { mayDecide: canReject, isAuthor } = canDecideOnDraft({
                  actorId: currentUserId,
                  draftAuthorId: d.createdBy,
                  canApprove,
                });
                const proposedAt = d.proposedAt ?? d.createdAt;
                const age = ageLabel(proposedAt);
                const originLabel = provenanceLabel(provenanceOfMemo(d.memo));
                return (
                  <li key={d.id} className="rounded-xl border border-border/80 bg-muted/60 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        {/* `break-words`: a long memo used to run past the card
                            on a phone instead of wrapping. */}
                        <h3 className="text-sm font-semibold break-words text-foreground">{d.memo}</h3>
                        {/* Everything a reviewer needs before deciding, in one
                            line: the date it will post under, whose branch it
                            posts to, who proposed it and how long it has been
                            waiting. The queue is business-wide, so without the
                            branch a reviewer approves a document without
                            knowing whose books it lands in. */}
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {/* The date is fixed when the draft is written — the
                              form's «امروز» resolves here, not at approval — so
                              a blank one is a draft from before that rule, not a
                              promise to fill in later. */}
                          {d.entryDate ? toPersianDigits(formatJalali(d.entryDate)) : "بدون تاریخ"}
                          {d.proposedByName ? ` — ${d.proposedByName}` : d.createdByName ? ` — ${d.createdByName}` : ""}
                          {age ? ` — ${age}` : ""}
                        </p>
                        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="rounded-full border border-border bg-background px-2 py-0.5 font-medium text-foreground">
                            {d.locationName ?? "بدون شعبه"}
                          </span>
                          {/* Where the document came from, when it says so. An
                              autopilot draft is approved on different grounds
                              than a typed one, and the mark on its memo is the
                              only place that difference is recorded. */}
                          {originLabel ? (
                            <span className="rounded-full border border-sky-500/30 bg-sky-500/5 px-2 py-0.5 font-medium text-sky-800 dark:text-sky-300">
                              {originLabel}
                            </span>
                          ) : null}
                          <span className="tabular-nums">#{toPersianDigits(shortRef(d.id))}</span>
                        </p>
                      </div>
                      <span className="shrink-0 text-sm font-bold tabular-nums text-foreground">
                        {money.formatText(total)}
                      </span>
                    </div>

                    {/* A real table, not three spans under an aria-hidden
                        header: with the heading hidden there was nothing left
                        to say which number was the debit. `frame={false}` —
                        the draft card already draws the panel. */}
                    <DataTable caption={`ردیف‌های پیش‌نویس ${d.memo}`} frame={false} className="mt-3">
                      <DataTableHead>
                        <Th className="py-2">حساب</Th>
                        <Th numeric className="py-2">
                          بدهکار
                        </Th>
                        <Th numeric className="py-2">
                          بستانکار
                        </Th>
                      </DataTableHead>
                      <DataTableBody>
                        {d.lines.map((l, i) => (
                          <DataTableRow key={`${d.id}-${i}`}>
                            <Th scope="row" className="py-2 font-normal">
                              {l.accountCode} {l.accountName}
                            </Th>
                            <Td numeric className="py-2">
                              <span className="sr-only">بدهکار: </span>
                              {l.debit ? money.format(l.debit) : "—"}
                            </Td>
                            <Td numeric className="py-2">
                              <span className="sr-only">بستانکار: </span>
                              {l.credit ? money.format(l.credit) : "—"}
                            </Td>
                          </DataTableRow>
                        ))}
                      </DataTableBody>
                    </DataTable>

                    {confirming ? (
                      /* Discarding a draft is irreversible and «رد کردن» sat
                         one tap from «تأیید و ثبت»; it asks first now, and
                         records what the reviewer says — a rejection with no
                         reason is indistinguishable from a deletion. */
                      <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 p-3">
                        <p className="text-sm text-destructive">
                          این پیش‌نویس رد و حذف شود؟ این کار قابل بازگشت نیست.
                        </p>
                        <label className="mt-3 block">
                          <span className="mb-1.5 block text-xs font-medium text-foreground">
                            علت رد{isAuthor ? " (اختیاری)" : ""}
                          </span>
                          <textarea
                            className={inputClass}
                            rows={2}
                            value={rejectReason}
                            onChange={(e) => setRejectReason(e.target.value)}
                            maxLength={MANUAL_REJECTION_REASON_MAX}
                            placeholder={isAuthor ? "مثلاً: اشتباه تایپ کردم" : "مثلاً: مبلغ با فاکتور مطابقت ندارد"}
                          />
                        </label>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="destructive"
                            onClick={() => reject(d.id)}
                            disabled={
                              busy ||
                              rowBusy ||
                              // Reviewing somebody else's draft owes them an
                              // explanation; withdrawing your own does not.
                              (!isAuthor && !rejectReason.trim())
                            }
                          >
                            {rowBusy ? "در حال حذف…" : "بله، رد کن"}
                          </Button>
                          <SecondaryButton
                            type="button"
                            onClick={() => {
                              setConfirmRejectId(null);
                              setRejectReason("");
                            }}
                            disabled={rowBusy}
                          >
                            انصراف
                          </SecondaryButton>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {canApprove ? (
                          <div className="min-w-40 flex-1 sm:max-w-xs">
                            <PrimaryButton
                              type="button"
                              onClick={() => approve(d.id)}
                              disabled={busy || rowBusy}
                            >
                              {rowBusy ? "در حال ثبت…" : "تأیید و ثبت"}
                            </PrimaryButton>
                          </div>
                        ) : null}
                        {canReject ? (
                          <SecondaryButton
                            type="button"
                            onClick={() => setConfirmRejectId(d.id)}
                            disabled={busy || rowBusy}
                          >
                            رد کردن
                          </SecondaryButton>
                        ) : (
                          <p className="text-xs leading-6 text-muted-foreground">
                            بررسی این پیش‌نویس با دارندهٔ دسترسی «تأیید سند» است.
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* Bounded on purpose: the queue is business-wide and open-ended, so
              it is read a page at a time rather than loaded whole. */}
          {page && page.total > page.limit ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground">
                نمایش {toPersianDigits(String(page.offset + 1))} تا{" "}
                {toPersianDigits(String(page.offset + (drafts?.length ?? 0)))} از{" "}
                {toPersianDigits(String(page.total))}
              </p>
              <div className="flex gap-2">
                <SecondaryButton
                  type="button"
                  onClick={() => setOffset(Math.max(0, page.offset - page.limit))}
                  disabled={busy || page.offset === 0}
                >
                  <ChevronRightIcon aria-hidden="true" className="size-4" />
                  صفحهٔ قبل
                </SecondaryButton>
                <SecondaryButton
                  type="button"
                  onClick={() => setOffset(page.offset + page.limit)}
                  disabled={busy || !page.hasMore}
                >
                  صفحهٔ بعد
                  <ChevronLeftIcon aria-hidden="true" className="size-4" />
                </SecondaryButton>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
