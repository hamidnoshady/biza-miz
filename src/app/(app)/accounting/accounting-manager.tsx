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
import { accountingSectionNeedsAccountList } from "./accounting-manager-policy";
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
import { DimensionsSection } from "./dimensions-section";
import { canEditChartOfAccounts } from "@/lib/coa-tree";
import { ExpenseSection } from "./expense-section";
import { PayrollSection } from "./payroll-section";
import { guardedNavigate } from "@/components/navigation/unsaved-changes-guard";
import { errorMessage } from "./accounting-errors";
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
  /**
   * Whether a manual journal may post to this account, as the server computes
   * it over the *whole* chart. Optional because this row type is also built by
   * tests and by callers reading the older payload shape; the manual-entry
   * picker falls back to deriving it only when the server did not say.
   */
  is_postable?: boolean;
  /** The same query's own answer, for callers that need the negative. */
  has_children?: boolean;
}


export function AccountingManager({
  role,
  section,
  permissions,
  currentUserId,
}: {
  role: string;
  section: AccountingSectionKey;
  /**
   * The member's effective permission keys — the directory's buttons follow them.
   *
   * Required rather than optional, because the page's own gate guarantees it:
   * `AccountingPageBody` redirects when `memberAccessFor` returns nothing, so
   * `undefined` here used to mean "the read failed", never "the member holds
   * nothing". Modelling it as absent let the presentation fall *open* —
   * approve/reject controls drawn for a session whose permissions could not be
   * read — which is a UI that lies about what will happen on click. A failure
   * to resolve permissions is now a type error at the call site, and the
   * caller has to say something.
   */
  permissions: readonly string[];
  /**
   * Who is looking — a drafter may discard their own manual draft without
   * `ledger.approve`, so the review queue's «رد کردن» is shown on their own
   * rows only. Required rather than optional, like the page that guarantees
   * it: an unknown viewer used to fall *open*, drawing approve/reject controls
   * for a session the server would refuse, because "we could not read the
   * member" was indistinguishable from "this member may".
   */
  currentUserId: string;
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
   * looked live. A plain boolean now, because `permissions` is required above:
   * the section's contract is "the page read the member", and an unread
   * member cannot reach this component.
   */
  const canApproveLedger = permissions.includes(PERMISSIONS.ledgerApprove);
  const canExportReports = permissions.includes(PERMISSIONS.reportsExport);

  /**
   * Whether this member may *propose* a draft.
   *
   * `ledger.propose` is narrower than the page's own door in the other
   * direction: the page opens on `ledger.view`, so a custom role built for
   * read-only review reaches /accounting/manual with the whole form drawn and
   * live-looking, types a document, and is told 403 only after pressing
   * «ثبت پیش‌نویس». Read-only means read-only on screen too — the section
   * replaces the form with an explanation rather than offering a button the
   * API is going to refuse.
   */
  const canProposeLedger = permissions.includes(PERMISSIONS.ledgerPropose);

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

  /**
   * Whether this member may mutate the fixed-asset register — create,
   * depreciate, reverse, dispose, transfer, archive, delete (issue #833).
   *
   * The page opens with `ledger.view`, but every mutation route checks
   * `finance.assets_manage`; a ledger-only member used to see apparently
   * live buttons and discover the 403 only after pressing one. `undefined`
   * when effective permissions could not be read: the section is then
   * READ-ONLY until the capability is affirmatively known — fail-closed,
   * never "draw the controls and let the API say no" (the API stays the
   * authority either way).
   *
   * `finance.assets_manage` is *the* authority for this register's
   * controlled auto-postings too (depreciation, reversal, disposal): it is
   * the operational finance capability the owner, manager and accountant
   * presets all carry, and it is what the routes check — there is
   * deliberately no second, separate posting permission here.
   */
  const canManageFixedAssets = permissions ? permissions.includes(PERMISSIONS.financeAssetsManage) : undefined;

  /**
   * Whether this member may change payroll. Reading it (`payroll.view`) is what
   * opens the section; accruing, paying, voiding and setting wages need
   * `payroll.manage`, a capability a custom role can hold without the other. As
   * with `canApproveLedger`, `undefined` (permissions unknown) draws the
   * controls and leaves the API as the gate.
   */
  const canManagePayroll = permissions ? permissions.includes(PERMISSIONS.payrollManage) : undefined;

  // Every section is a route now, so the rail navigates rather than switching
  // local state — a section a person lands on is a URL they can keep.
  //
  // The chips below the page are buttons, not links, so the navigation guard's
  // click listener cannot see them: they hand their `router.push` to
  // `guardedNavigate`, which asks first when a screen (the payroll wage list)
  // has unsaved work and goes straight through otherwise.
  const goToSection = useCallback(
    (key: AccountingSectionKey) => {
      const href = accountingSectionHref(key);
      guardedNavigate(href, () => router.push(href));
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

  /*
   * Whether this member may run a reconciliation at all.
   *
   * The section opens on the app's ledger door (`ledger.view`), but every
   * mutation behind it — start, tick, complete, discard — requires
   * `finance.reconciliation_manage`. The screen used to draw all of those
   * controls for whoever could open it, so a read-only accountant's every click
   * came back 403 under a generic error. `undefined` when the page could not
   * read the member's effective permissions: the section then draws the
   * controls and the API stays the gate, exactly like `canApproveLedger`.
   */
  const canManageReconciliation = permissions
    ? permissions.includes(PERMISSIONS.financeReconciliationManage)
    : undefined;
  const sections = LEDGER_WORKSPACE_SECTION_KEYS.flatMap((key) => {
    const def = allowed.find((candidate) => candidate.key === key);
    return def ? [def] : [];
  });
  const currentSubGroup = LEDGER_WORKSPACE_SUBGROUPS.find((subGroup) => subGroup.keys.includes(section));
  const siblings = currentSubGroup
    ? sections.filter((candidate) => currentSubGroup.keys.includes(candidate.key))
    : [];

  const requiresAccounts = accountingSectionNeedsAccountList(section);
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
  useEffect(() => {
    if (requiresAccounts) loadAccounts();
  }, [requiresAccounts, loadAccounts]);

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

  if (requiresAccounts && !accounts) {
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
          {section === "trial-balance" ? (
            <TrialBalanceSection refreshKey={refreshKey} canExport={canExportReports} />
          ) : null}
          {section === "entries" ? (
            /*
             * `canApprove` is the same `ledger.approve` the manual-entry
             * review queue gets, and for the same reason: «برگشت سند» is
             * gated on it server-side, so a manager who cannot approve must
             * not be shown a live destructive accounting control. `accounts`
             * is the chart this workspace already loaded — the journal's
             * «حساب» filter picks from it rather than fetching it twice.
             */
            <EntriesSection
              refreshKey={refreshKey}
              busy={busy}
              accounts={accounts ?? []}
              canApprove={canApproveLedger}
              onRefresh={() => setRefreshKey((key) => key + 1)}
            />
          ) : null}
          {section === "manual" ? (
            <ManualEntrySection
              accounts={accounts ?? []}
              busy={busy}
              run={run}
              refreshKey={refreshKey}
              canApprove={canApproveLedger}
              canPropose={canProposeLedger}
              currentUserId={currentUserId}
            />
          ) : null}
          {section === "expenses" ? (
            <ExpenseSection
              accounts={accounts ?? []}
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
          {section === "receivables" ? <ArSection canSettle={!!permissions?.includes(PERMISSIONS.financeReceivablesManage)} /> : null}
          {section === "payables" ? <ApSection canSettle={!!permissions?.includes(PERMISSIONS.financePayablesManage)} /> : null}
          {section === "receipts" ? <ReceiptsPaymentsSection
            canManageReceivables={!!permissions?.includes(PERMISSIONS.financeReceivablesManage)}
            canManagePayables={!!permissions?.includes(PERMISSIONS.financePayablesManage)}
            canReversePayments={!!permissions?.includes(PERMISSIONS.ledgerApprove)}
          /> : null}
          {section === "installments" ? <InstallmentsSection /> : null}
          {section === "cheques" ? <ChequesSection busy={busy} run={run} /> : null}
          {section === "reconciliation" ? (
            <ReconciliationSection busy={busy} run={run} canManage={canManageReconciliation} />
          ) : null}
          {section === "chart-of-accounts" ? (
            <ChartOfAccountsSection busy={busy} run={run} canEdit={canEditAccounts} />
          ) : null}
          {section === "dimensions" ? <DimensionsSection canManage={canEditAccounts} /> : null}
          {section === "payroll" ? (
            <PayrollSection
              busy={busy}
              run={run}
              refreshKey={refreshKey}
              canManage={canManagePayroll}
              ownerKey={currentUserId}
            />
          ) : null}
          {section === "vat" ? <VatReportSection refreshKey={refreshKey} /> : null}
          {section === "fixed-assets" ? (
            <FixedAssetsSection
              busy={busy}
              refreshKey={refreshKey}
              canManage={canManageFixedAssets}
              accounts={accounts ?? []}
            />
          ) : null}
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
