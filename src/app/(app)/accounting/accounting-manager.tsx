"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

import { useCallback, useEffect, useState, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FilterChip, FilterChipRow } from "@/app/dashboard/filters";
import { api, ErrorBox, SecondaryButton } from "@/app/dashboard/ui";
import { PERMISSIONS } from "@/lib/permissions";
import { partyScopeFor } from "@/lib/parties-scopes";
import {
  partyDirectoryHref,
  partyDirectoryView,
  type PartyDirectoryViewKey,
} from "@/lib/party-directory";
import { PartiesSection } from "@/app/dashboard/parties/parties-section";
import { LedgerDashboardSection } from "./ledger-dashboard-section";
import {
  accountingSectionHref,
  type AccountingSectionKey,
} from "./accounting-routes";
import { accountingSectionsFor } from "./accounting-nav";
import { LEDGER_WORKSPACE_SECTION_KEYS, LEDGER_WORKSPACE_SUBGROUPS } from "./accounting-workspace";
import { TrialBalanceSection } from "./trial-balance-section";
import { EntriesSection } from "./entries-section";
import { ManualEntrySection } from "./manual-entry-section";
import { FiscalPeriodsSection } from "./fiscal-periods-section";
import { ArSection } from "./ar-section";
import { ApSection } from "./ap-section";
import { ReceiptsPaymentsSection } from "./receipts-payments-section";
import { InstallmentsSection } from "./installments-section";
import { ChequesSection } from "./cheques-section";
import { ReconciliationSection } from "./reconciliation-section";
import { ChartOfAccountsSection } from "./chart-of-accounts-section";
import { canEditChartOfAccounts } from "@/lib/coa-tree";
import { ExpenseSection } from "./expense-section";
import { EXPENSE_UI_ERROR_MESSAGES } from "@/lib/expense-errors";
import { PayrollSection } from "./payroll-section";
import { VatReportSection } from "./vat-report-section";
import { FixedAssetsSection } from "./fixed-assets-section";
import { GrowthAccountingView } from "@/components/growth/growth-accounting-view";
import { AccountingReportsSection } from "./reports-section";
import { AccountingSettingsSection } from "./settings-section";
import styles from "./ledger-workspace.module.css";

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  parent_code: string | null;
  /**
   * Present on the picker response (`GET /api/ledger/accounts` without `?all`),
   * which is what the Expenses screen's payment-source rule needs — account
   * meaning is inherited through the parent (issue #832 §2). Optional because
   * the `?all=1` management rows carry their own tree shape instead.
   */
  parent_id?: string | null;
}


export function AccountingManager({
  role,
  section,
  permissions,
  currentUserId,
}: {
  role: string;
  section: AccountingSectionKey;
  /** The member's effective permission keys — the directory's buttons follow them. */
  permissions?: readonly string[];
  /** Who is looking — a drafter may discard their own manual draft without ledger.approve. */
  currentUserId?: string;
}) {
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /*
   * «اشخاص» (the directory) is Accounting's own view of the same table the
   * CRM, the store and the team look at (`../parties/parties-section.tsx`,
   * scope `accounting`) — customers, suppliers and staff with the ledger's own
   * columns, managed here rather than by sending the accountant into the CRM.
   * It is also the one place a party's ledger code is written.
   *
   * «مشتریان»، «تأمین‌کنندگان» and «فروشندگان» used to be three more sections
   * beside it, three routes over the same table. They are `?view=` filters of
   * this one screen now (`src/lib/party-directory.ts`), so an A/R link, an A/P
   * link and a purchase order all land on the same directory with the right
   * list already selected — and a person who is both a customer and a supplier
   * is one file, not two.
   *
   * A `?party=<id>` link from another app (an A/R row, an AI answer, a
   * notification) lands on the section's route with that one file open, the
   * way `?customer=` lands on the CRM's file.
   */
  const router = useRouter();
  const searchParams = useSearchParams();
  const partyParam = searchParams.get("party");
  const [editPartyId, setEditPartyId] = useState<string | null>(partyParam);
  useEffect(() => {
    setEditPartyId(partyParam);
  }, [partyParam]);
  // The directory's view («همه اشخاص» / «مشتریان» / …) lives in the URL, so a
  // filtered list is a link somebody can send and a back button returns to the
  // list you were reading rather than to «همه».
  const viewParam = searchParams.get("view");
  const directoryView = partyDirectoryView(viewParam).key;
  const setDirectoryView = useCallback(
    (next: PartyDirectoryViewKey) => {
      // `replace`, not `push`: switching a filter is refining one screen, and
      // it should not cost five back presses to leave the directory.
      router.replace(partyDirectoryHref(next, { party: partyParam }), { scroll: false });
    },
    [partyParam, router],
  );
  const [refreshKey, setRefreshKey] = useState(0);

  /**
   * Whether this member may turn a draft into a real posting.
   *
   * `ledger.approve` is deliberately *not* the app's door (owner/manager/
   * accountant may all draft), so «تأیید و ثبت» in the manual-entry review
   * queue is the one accounting button whose permission is narrower than the
   * page it sits on — a manager pressed it and got a 403 from a control that
   * looked live. `undefined` when the page could not read the member's
   * effective permissions; the section then draws the button and the API stays
   * the gate, matching how `partiesSectionAbilities` treats the same gap.
   */
  const canApproveLedger = permissions ? permissions.includes(PERMISSIONS.ledgerApprove) : undefined;

  /**
   * Whether this member may *write* in the expense register (issue #832 §3).
   *
   * «هزینه‌ها» opens with `ledger.view`, which is right: a read-only accountant,
   * an auditor and a viewer all came to read a book. What was wrong is that the
   * screen then drew «ثبت هزینه», the receipt upload and every other mutating
   * control for them too, so the only honest answer they could get was a 403
   * after a form they were not entitled to fill. Same three-state convention as
   * `canApproveLedger`: `undefined` when the member's effective permissions could
   * not be read, and then the controls are drawn and the API stays the gate.
   *
   * `canBrowseMedia` is narrower than it looks. A receipt photo lives in the
   * canonical Media Library, and its bytes are readable by anyone who may read
   * the expense they belong to (`/api/media/[id]/file`) — but the library
   * *page* is `media.view`, so «باز کردن در کتابخانهٔ رسانه» is offered only to
   * the members for whom it is a door rather than a redirect.
   */
  const canManageExpenses = permissions ? permissions.includes(PERMISSIONS.financeExpensesManage) : undefined;
  const canBrowseMedia = permissions ? permissions.includes(PERMISSIONS.mediaView) : undefined;

  // Every section is a route now, so the rail navigates rather than switching
  // local state — a section a person lands on is a URL they can keep.
  const goToSection = useCallback(
    (key: AccountingSectionKey) => {
      router.push(accountingSectionHref(key));
    },
    [router],
  );

  /**
   * The app's menu is the sidebar (`accounting-app-nav.tsx`) — the one
   * navigation definition. This page used to draw a second copy of the ledger
   * group as a rail beside the content (dashboard audit F15), and on a phone
   * that rail filled the first screen before the form a person came for.
   *
   * What stays is contextual: the few sections of the *current* sub-group
   * («دفتر و اسناد»، «وجوه و هزینه»…) as one compact row, drawn after the
   * section's own content on a phone and above it from `sm` up. Keys are
   * filtered through `accountingSectionsFor`, the same gate the pages use.
   */
  const permissionSet = useMemo(() => new Set(permissions), [permissions]);
  const allowed = accountingSectionsFor(permissionSet);
  /*
   * Whether this member may restructure the chart of accounts.
   *
   * Opening «سرفصل حساب‌ها» needs only the app's own door (owner/manager/
   * accountant), but every mutating route behind it calls
   * `requirePermission(accounts.edit)` — which a manager's preset does not
   * include. The screen used to draw «افزودن»، «ویرایش»، «بایگانی» and «حذف»
   * for them anyway, so a manager's every action came back 403 under a generic
   * «خطای غیرمنتظره». One definition, shared with the tests: `coa-tree.ts`.
   */
  const canEditAccounts = canEditChartOfAccounts(role, permissions);
  const sections = LEDGER_WORKSPACE_SECTION_KEYS.flatMap((key) => {
    const def = allowed.find((candidate) => candidate.key === key);
    return def ? [def] : [];
  });
  const currentSubGroup = LEDGER_WORKSPACE_SUBGROUPS.find((subGroup) => subGroup.keys.includes(section));
  const siblings = currentSubGroup
    ? sections.filter((candidate) => currentSubGroup.keys.includes(candidate.key))
    : [];

  const [loadFailed, setLoadFailed] = useState(false);
  const loadAccounts = useCallback(() => {
    setLoadFailed(false);
    api<{ accounts: AccountRow[] }>("/api/ledger/accounts").then(({ ok, data }) => {
      if (ok) setAccounts(data.accounts);
      // Without this the whole workspace sat on a skeleton for ever whenever
      // the chart of accounts failed to load — indistinguishable from a slow
      // network, and with no way to retry.
      else setLoadFailed(true);
    });
  }, []);
  useEffect(loadAccounts, [loadAccounts]);

  async function run(fn: () => Promise<{ ok: boolean; data: { error?: string } }>) {
    setBusy(true);
    setError("");
    try {
      const { ok, data } = await fn();
      if (!ok) {
        setError(errorMessage(data.error));
        return false;
      }
      setRefreshKey((k) => k + 1);
      return true;
    } catch {
      /* A thrown fetch (dropped connection) used to escape here: the studio's
         busy flag then stayed set for ever — every action button in every
         ledger section disabled — and the click ended in an unhandled
         rejection. The settings area's own runner already caught this way. */
      setError("ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!accounts) {
    if (loadFailed) {
      return (
        <div className="space-y-3">
          <ErrorBox>بارگذاری سرفصل حساب‌ها ناموفق بود؛ بخش‌های حسابداری بدون آن باز نمی‌شوند.</ErrorBox>
          <div className="max-w-xs">
            <SecondaryButton onClick={loadAccounts}>تلاش دوباره</SecondaryButton>
          </div>
        </div>
      );
    }
    return (
      <SectionCardSkeleton rows={4} />
    );
  }

  const body = (
    <>
      {section === "dashboard" ? <LedgerDashboardSection onGoToTab={goToSection} refreshKey={refreshKey} /> : null}
          {section === "trial-balance" ? <TrialBalanceSection refreshKey={refreshKey} /> : null}
          {section === "entries" ? <EntriesSection refreshKey={refreshKey} busy={busy} run={run} /> : null}
          {section === "manual" ? (
            <ManualEntrySection
              accounts={accounts}
              busy={busy}
              run={run}
              refreshKey={refreshKey}
              canApprove={canApproveLedger}
              currentUserId={currentUserId}
            />
          ) : null}
          {section === "expenses" ? (
            <ExpenseSection
              accounts={accounts}
              busy={busy}
              run={run}
              refreshKey={refreshKey}
              canManageExpenses={canManageExpenses}
              canBrowseMedia={canBrowseMedia}
            />
          ) : null}
          {section === "fiscal-periods" ? <FiscalPeriodsSection /> : null}
          {section === "directory" ? (
            <PartiesSection
              scope={partyScopeFor("accounting")}
              role={role}
              editPartyId={editPartyId}
              view={directoryView}
              onViewChange={setDirectoryView}
              permissions={permissions}
            />
          ) : null}
          {section === "receivables" ? <ArSection /> : null}
          {section === "payables" ? <ApSection /> : null}
          {section === "receipts" ? <ReceiptsPaymentsSection /> : null}
          {section === "installments" ? <InstallmentsSection /> : null}
          {section === "cheques" ? <ChequesSection busy={busy} run={run} /> : null}
          {section === "reconciliation" ? <ReconciliationSection busy={busy} run={run} /> : null}
          {section === "chart-of-accounts" ? (
            <ChartOfAccountsSection busy={busy} run={run} canEdit={canEditAccounts} />
          ) : null}
          {section === "payroll" ? <PayrollSection busy={busy} run={run} refreshKey={refreshKey} /> : null}
          {section === "vat" ? <VatReportSection refreshKey={refreshKey} /> : null}
          {section === "fixed-assets" ? <FixedAssetsSection busy={busy} refreshKey={refreshKey} /> : null}
          {section === "financial-reports" ? <AccountingReportsSection /> : null}
          {section === "settings" ? <AccountingSettingsSection /> : null}
          {section === "growth" ? <GrowthAccountingView /> : null}
    </>
  );

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>

      <div className="flex min-w-0 flex-col gap-4">
        {currentSubGroup && siblings.length > 1 ? (
          <nav aria-label={currentSubGroup.label} className="order-2 sm:order-1">
            <FilterChipRow label={currentSubGroup.label} className="flex-nowrap overflow-x-auto pb-1">
              {siblings.map((candidate) => (
                <FilterChip
                  key={candidate.key}
                  selected={candidate.key === section}
                  aria-current={candidate.key === section ? "page" : undefined}
                  onClick={() => goToSection(candidate.key)}
                >
                  {candidate.label}
                </FilterChip>
              ))}
            </FilterChipRow>
          </nav>
        ) : null}
        <div className={`${styles.content} order-1 min-w-0 sm:order-2`}>{body}</div>
      </div>
    </div>
  );
}

export type Runner = (fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => Promise<boolean>;

function errorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    memo_required: "شرح سند الزامی است.",
    memo_too_long: "شرح سند بیش از حد طولانی است؛ آن را کوتاه‌تر بنویسید.",
    no_lines: "حداقل یک سطر با مبلغ لازم است.",
    too_few_lines: "سند باید حداقل دو ردیف داشته باشد.",
    too_many_lines: "تعداد ردیف‌های سند بیش از حد مجاز است.",
    single_account_entry: "سند باید حداقل به دو حساب متفاوت بخورد.",
    invalid_line: "یکی از سطرها معتبر نیست (حساب، یا فقط بدهکار یا بستانکار).",
    invalid_entry_date: "تاریخ سند معتبر نیست.",
    not_balanced: "مجموع بدهکار و بستانکار برابر نیست.",
    unknown_account: "یکی از حساب‌های انتخاب‌شده معتبر نیست.",
    not_a_leaf_account: "به حساب گروه یا کل نمی‌توان سند زد؛ حساب معین یا تفصیلی را انتخاب کنید.",
    ledger_account_missing: "یکی از حساب‌های مورد نیاز سیستم در سرفصل حساب‌ها یافت نشد.",
    unauthorized: "وارد نشده‌اید.",
    forbidden: "دسترسی مجاز نیست.",
    network_error: "ارتباط با سرور برقرار نشد. اتصال اینترنت یا شبکه را بررسی و دوباره تلاش کنید.",
    bad_request: "درخواست نامعتبر بود.",
    // Phase 16 — AR subledger
    customer_required: "انتخاب مشتری الزامی است.",
    customer_not_found: "مشتری انتخاب‌شده معتبر نیست.",
    invalid_amount: "مبلغ معتبر نیست.",
    invalid_method: "روش دریافت/پرداخت معتبر نیست.",
    // A date parameter the caller sent could not be used (not YYYY-MM-DD, or
    // not a real calendar date) — the A/R and A/P routes reject rather than
    // guessing what was meant.
    invalid_date: "تاریخ واردشده معتبر نیست.",
    // Phase 16 — AP subledger
    supplier_required: "انتخاب تأمین‌کننده الزامی است.",
    supplier_not_found: "تأمین‌کننده انتخاب‌شده معتبر نیست.",
    // Phase 30 — cheques
    invalid_direction: "نوع چک معتبر نیست.",
    invalid_action: "این عملیات روی چک تعریف نشده است.",
    invalid_cheque_transition: "این تغییر وضعیت برای چک ممکن نیست؛ ممکن است وضعیت چک را کسی دیگر تغییر داده باشد.",
    cheque_not_found: "چک پیدا نشد.",
    duplicate_cheque: "چکی با همین شماره و بانک (یا همین شناسه صیاد) قبلاً ثبت شده است.",
    invalid_sayad_id: "شناسه صیاد باید ۱۶ رقم باشد.",
    serial_number_required: "شماره چک الزامی است.",
    bank_name_required: "نام بانک الزامی است.",
    counterparty_name_required: "نام صاحب چک الزامی است.",
    due_date_required: "تاریخ سررسید الزامی است.",
    invalid_issue_date: "تاریخ دریافت/صدور معتبر نیست.",
    invalid_due_date: "تاریخ سررسید معتبر نیست.",
    due_date_before_issue: "سررسید نمی‌تواند پیش از تاریخ دریافت/صدور باشد.",
    invalid_occurred_on: "تاریخ وقوع معتبر نیست.",
    action_before_issue: "تاریخ این اقدام نمی‌تواند پیش از تاریخ دریافت/صدور باشد.",
    invalid_counterparty_for_direction: "طرف حساب انتخاب‌شده با نوع چک هم‌خوانی ندارد.",
    // Phase 16 — bank & cash reconciliation
    invalid_account: "حساب انتخاب‌شده معتبر نیست.",
    statement_date_required: "تاریخ صورتحساب الزامی است.",
    invalid_statement_date: "تاریخ صورتحساب معتبر نیست؛ تاریخ را از تقویم انتخاب کنید.",
    statement_date_already_reconciled:
      "برای این حساب، تطبیقی با تاریخ مساوی یا جدیدتر قبلاً قفل شده است؛ تاریخ صورتحساب باید بعد از آخرین تطبیق قفل‌شده باشد.",
    reconciliation_in_progress:
      "یک تطبیق ناتمام برای این حساب وجود دارد؛ ابتدا آن را تکمیل یا حذف کنید.",
    reconciliation_not_found: "تطبیق پیدا نشد.",
    reconciliation_completed: "این تطبیق قبلاً قفل شده و قابل تغییر نیست.",
    negative_statement_balance:
      "مانده صورتحساب صندوق یا کارت‌خوان نمی‌تواند منفی باشد؛ مانده پایانی را وارد کنید، نه گردش دوره.",
    journal_line_not_found: "سند انتخاب‌شده معتبر نیست.",
    journal_line_already_reconciled: "این سند در یک تطبیق قفل‌شدهٔ دیگر ثبت شده و دوباره قابل تطبیق نیست.",
    balance_mismatch: "مانده محاسبه‌شده با مانده صورتحساب برابر نیست.",
    fiscal_period_locked: "دوره مالی این تاریخ قفل است و امکان ثبت سند وجود ندارد.",
    fiscal_period_soft_closed: "دوره مالی این تاریخ بسته‌ی موقت است؛ فقط مالک یا حسابدار می‌تواند سند ثبت کند.",
    // Phase 16 — manual journal workflow
    draft_not_found: "پیش‌نویس پیدا نشد.",
    entry_not_found: "سند پیدا نشد.",
    not_reversible: "فقط اسناد دستی قابل برگشت هستند.",
    cannot_reverse_a_reversal: "سند برگشتی را نمی‌توان دوباره برگشت زد.",
    already_reversed: "این سند قبلاً برگشت خورده است.",
    entry_has_no_lines: "این سند ردیف حسابداری ندارد و قابل برگشت نیست.",
    // Phase 16 — chart of accounts customisation
    well_known_account: "این حساب برای عملکرد سیستم لازم است و قابل غیرفعال یا حذف نیست.",
    account_not_found: "حساب پیدا نشد.",
    /*
     * Phase 16 — expense management, and every code issue #832 added to it
     * (reversal, payment-source, VAT, branch, party). The text lives once, in
     * `expense-errors.ts`, next to the codes the service throws and the map the
     * import adapter reads; spreading it here is what keeps a code from being
     * translated in one channel and left as «خطای غیرمنتظره» in another. The
     * three codes the register shares with the journal (`invalid_amount`,
     * `memo_required`, `unknown_account`) are deliberately not in this spread —
     * their wording above is deliberately about a *document*, not only an
     * expense.
     */
    ...EXPENSE_UI_ERROR_MESSAGES,
    // Chart of accounts (accounts-service.ts) — these reach here whenever a
    // section routes an accounts error through `run` rather than its own map.
    code_required: "کد حساب الزامی است.",
    invalid_code: "کد حساب باید فقط شامل عدد باشد (مثل ۶۱۰۰).",
    name_required: "نام حساب الزامی است.",
    invalid_type: "نوع حساب معتبر نیست.",
    code_in_use: "این کد حساب قبلاً استفاده شده است.",
    parent_not_found: "حساب والد پیدا نشد.",
    parent_cycle: "حساب نمی‌تواند والد خودش یا زیرمجموعه‌اش باشد.",
    parent_too_deep: "حساب والد از سطح «تفصیلی» است و نمی‌تواند زیرمجموعه داشته باشد.",
    hierarchy_too_deep: "این جابه‌جایی باعث می‌شود ساختار حساب از سطح «تفصیلی» عمیق‌تر شود.",
    account_has_postings: "این حساب سند خورده و قابل حذف نیست؛ می‌توانید آن را غیرفعال کنید.",
    account_has_draft_postings: "این حساب در یک پیش‌نویس استفاده شده و قابل حذف نیست.",
    account_has_children: "ابتدا زیرمجموعه‌های این حساب را جابه‌جا یا حذف کنید.",
    // Fiscal years and periods (fiscal-periods-service.ts)
    invalid_year: "سال شمسی نامعتبر است.",
    fiscal_year_exists: "این سال مالی قبلاً تعریف شده است.",
    fiscal_year_not_found: "سال مالی یافت نشد.",
    fiscal_year_closed: "سال مالی این دوره بسته شده و دیگر قابل بازگشایی نیست.",
    fiscal_year_already_closed: "این سال مالی قبلاً بسته شده است.",
    periods_not_ready: "برای بستن سال مالی، ابتدا همه دوره‌های آن را به‌صورت موقت ببندید.",
    periods_incomplete: "فهرست دوره‌های سال مالی کامل نیست و سال قابل بستن نیست.",
    fiscal_period_overlap: "بازهٔ این سال با یک دورهٔ مالی موجود هم‌پوشانی دارد؛ دوره‌ها را بررسی کنید.",
    period_locked_for_closing: "دوره پایانی سال قفل است؛ ابتدا آن را بازگشایی و دوباره بسته‌ی موقت کنید.",
    period_not_found: "دوره یافت نشد.",
    invalid_transition: "این تغییر وضعیت مجاز نیست.",
    // Phase 16 — payroll entries
    user_not_found: "عضو موردنظر پیدا نشد.",
    no_wages_set: "هیچ عضو فعالی حقوق تعیین‌شده ندارد.",
    period_label_required: "عنوان دوره الزامی است.",
    period_label_too_long: "عنوان دوره بیش از حد طولانی است.",
    invalid_accrual_date: "تاریخ تعهد معتبر نیست.",
    invalid_paid_date: "تاریخ پرداخت معتبر نیست.",
    run_not_found: "تعهد حقوق پیدا نشد.",
    already_paid: "این تعهد قبلاً پرداخت شده است.",
    already_voided: "این تعهد قبلاً ابطال شده است.",
    run_voided: "این تعهد ابطال شده و قابل پرداخت نیست.",
    // Phase 22 — fixed assets & depreciation
    fixed_asset_not_found: "دارایی ثابت پیدا نشد.",
    fixed_asset_has_depreciation: "برای این دارایی استهلاک ثبت شده و قابل حذف نیست.",
    period_already_depreciated: "استهلاک این دوره قبلاً ثبت شده است.",
    fully_depreciated: "این دارایی به‌طور کامل مستهلک شده است.",
  };
  return map[code ?? ""] ?? "خطای غیرمنتظره. دوباره تلاش کنید.";
}
