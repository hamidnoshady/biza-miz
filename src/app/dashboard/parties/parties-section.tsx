"use client";

/**
 * The party directory — the section every app mounts for «اشخاص».
 *
 * There is exactly one of this component in the platform, and it is mounted for
 * every scope: the CRM's customers, the store's suppliers, the team's personnel,
 * Accounting's whole file and Accounting's customers-only slice. Which rows
 * appear, which columns are drawn, and whether a row can be edited at all is
 * answered by `PARTY_SCOPES` (`src/lib/parties-scopes.ts`), never by a copy of
 * this list in the app.
 *
 * What a section may *not* do is the other half of the rule. No app keeps its own
 * add/edit form, its own inactive flag, or its own second table of "the suppliers I
 * care about": Inventory used to have all three, and the ledger had a fourth
 * opinion of who a supplier is. Every one of those screens mounts this component
 * with its scope, so a name changed here is a name changed everywhere — the only
 * promise a shared record has to keep.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import {
  PARTY_COLUMN_LABELS,
  partyOwnerScopeForRole,
  partiesSectionAbilities,
  partyStatementKind,
  roleLabelInScope,
  showsColumn,
  type PartyColumn,
  type PartyScopeDef,
} from "@/lib/parties-scopes";
import {
  PARTY_ROLE_LABELS,
  PARTY_ROLE_TAB_LABELS,
  partyRoles,
  taxPercentageOf,
  type PartyApiRecord,
  type PartyRole,
} from "@/lib/parties";
import { directoryFilterCategories } from "@/lib/party-directory";
import { toPersianDigits } from "@/lib/digits";
import { formatPhoneDisplay } from "@/lib/phone";
import { useMoney } from "@/components/money/money-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge, TabBar } from "../page-chrome";
import {
  PARTY_DIRECTORY_VIEWS,
  partyDirectoryView,
  type PartyDirectoryViewKey,
} from "@/lib/party-directory";
import { api, errorMessage, ErrorBox, Field, InfoBox, inputClass } from "../ui";
import { ArStatementPanel } from "@/app/(app)/accounting/ar-statement-panel";
import { ApStatementPanel } from "@/app/(app)/accounting/ap-statement-panel";
import { crmCustomerHref } from "@/app/(app)/crm/crm-routes";
import { PartyFormDialog } from "./party-form";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

const PAGE_SIZE = 20;

/**
 * How long the search box waits before asking the server.
 *
 * Each keystroke used to be a request, and a directory query is not cheap: a
 * `count(*)` over `parties` plus an encrypted-phone comparison per row. Long
 * enough that a typed name is one query, short enough that it still feels like
 * live search.
 */
export const SEARCH_DEBOUNCE_MS = 300;

interface CategoryRow {
  id: string;
  name: string;
  role: string | null;
  isActive: boolean;
}

/** A row as the section needs it: the API's `Party`, narrowed to what the columns draw. */
export interface PartyListRow extends PartyApiRecord {
  id: string;
  displayName: string;
  /** The one column the list draws that a party record does not carry by itself. */
  categoryName?: string | null;
}

export interface PartiesSectionProps {
  /** The app's view: roles, columns, edit rights. */
  scope: PartyScopeDef;
  /** The signed-in role — decides which buttons exist and whether ledger figures show. */
  role: string;
  /** Opens one party's form on mount — the deep link another app's row uses. */
  editPartyId?: string | null;
  /** Opens the create form on mount — an overview quick action that only says "add one". */
  openNewOnMount?: boolean;
  /**
   * A search the mounting screen already performed — `?q=` on a link.
   *
   * Supplied, the box starts filled *and* already applied: a person who
   * followed «مریم» from the CRM's command field expects the list to be the
   * answer to that word, not a text box holding it while the whole directory
   * loads underneath. Omitted, the box starts empty as it always has.
   */
  initialQuery?: string;
  /**
   * The directory view («همه اشخاص» / «مشتریان» / «تأمین‌کنندگان» / …).
   *
   * Supplied by the canonical directory, which keeps it in the URL so a
   * filtered list is a link. Omitted by the single-role sections (the store's
   * suppliers tab, the team's staff list), which are already one role by scope
   * and show no view strip at all.
   */
  view?: PartyDirectoryViewKey;
  onViewChange?: (view: PartyDirectoryViewKey) => void;
  /**
   * The signed-in member's effective permissions, when the mounting page
   * could read them (every server-rendered mount can — see `member-access.ts`).
   * Supplied, the buttons follow the member's real rights: a cashier whose
   * `parties.manage` was revoked sees no «افزودن» button that would only
   * answer 403, and a waiter who was *granted* it sees one that works.
   * Omitted, the role presets decide — the API remains the boundary either
   * way.
   */
  permissions?: readonly string[];
}

export function PartiesSection({
  scope,
  role,
  editPartyId,
  openNewOnMount,
  initialQuery,
  view,
  onViewChange,
  permissions,
}: PartiesSectionProps) {
  // The views are offered only where the scope can actually serve them: a
  // «تأمین‌کنندگان» tab inside a customers-only scope would be a filter that
  // returns nothing by construction.
  const views = useMemo(
    () =>
      onViewChange
        ? PARTY_DIRECTORY_VIEWS.filter((candidate) =>
            candidate.roles.every((candidateRole) => scope.roles.includes(candidateRole)),
          )
        : [],
    [onViewChange, scope],
  );
  /**
   * Memoised, because `partyDirectoryView` returns an entry from a module-level
   * table but the *call* re-runs on every render — and `listedRoles` below is a
   * `useMemo` over it. Without this the role array had a new identity every
   * render, `load` changed with it, and `useEffect(load, [load])` re-fetched the
   * whole directory on every parent re-render.
   */
  const activeView = useMemo(() => partyDirectoryView(view), [view]);
  /**
   * Which roles this listing asks the API for: the view's, narrowed to what
   * the scope allows. The narrowing is what keeps the URL from being an
   * access-control hole — `?view=employees` inside the CRM's customers-only
   * scope still lists customers.
   */
  const listedRoles = useMemo(() => {
    const allowed = activeView.roles.filter((candidate) => scope.roles.includes(candidate));
    return allowed.length > 0 ? allowed : scope.roles;
  }, [activeView, scope]);
  // What this member may do here: their effective permissions when the page
  // could read them, the role presets when it could not (one definition —
  // parties-scopes.ts). `scope.readOnly` still wins over both: a read-only
  // scope never draws a write button no matter who is asking. Money-shaped
  // columns follow the ledger's own access rule, not the section's — a cashier
  // browsing customers is not a cashier reading balances.
  const abilities = useMemo(() => partiesSectionAbilities(role, permissions), [role, permissions]);
  const canManage = !scope.readOnly && abilities.canManage;
  const canSeeLedger = abilities.canSeeLedger;
  // Opening a statement is a *role* gate, not a permission one — the ledger's
  // statement routes ask `requireRole`, so a `ledger.view` grant reads the
  // balance column without opening the panel behind it.
  const canOpenStatement = abilities.canOpenStatement;

  const [parties, setParties] = useState<PartyListRow[] | null>(null);
  /**
   * The business the listing came from, and so the namespace of its drafts. Read
   * off the response rather than passed in: every mount of this section is a
   * different app's client component, and a prop each of them must remember to
   * thread would be a mount that silently shares one browser's drafts across two
   * businesses on a pre-Phase-23 origin.
   */
  const [businessId, setBusinessId] = useState("");
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  /**
   * What the box shows — updated on every keystroke so typing stays instant.
   *
   * Initialised from a deep link, and *also* the initial `appliedQuery` below:
   * a `?q=` search is already deliberate, so it skips the debounce instead of
   * spending 400 ms looking like it was ignored.
   */
  const [query, setQuery] = useState(initialQuery ?? "");
  /** What the server was asked for — the debounced copy of `query`. */
  const [appliedQuery, setAppliedQuery] = useState(initialQuery ?? "");
  const [categoryId, setCategoryId] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  // The categories offered as filters — the one rule lives in
  // `party-directory.ts` (`directoryFilterCategories`), shared with the effect
  // that retires a selection the view switch made stale.
  const filterCategories = useMemo(
    () => directoryFilterCategories(categories, listedRoles),
    [categories, listedRoles],
  );
  const [showCategories, setShowCategories] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  /**
   * Which single thing is mid-flight — a party id, a category id — rather than
   * «something is».
   *
   * A boolean disabled every button on the screen for the length of one
   * request, so archiving one row greyed out forty, and nothing said which row
   * was the one working. Keyed, the feedback lands on the control that was
   * actually pressed and the rest of the list stays usable.
   */
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const busy = pendingKey !== null;
  const [form, setForm] = useState<{ partyId?: string | null; initial?: PartyApiRecord | null } | null>(
    editPartyId ? { partyId: editPartyId } : openNewOnMount ? {} : null,
  );
  const [statement, setStatement] = useState<{ id: string; name: string; kind: "ar" | "ap" } | null>(
    null,
  );
  /**
   * What each party owes, read from the ledger's own receivables endpoint when this
   * scope asks for the column (`balance`) and this role may see accounting figures.
   * The number is the ledger's, never a copy: the directory shows it and links to
   * the statement, and that is all a second app is allowed to do with a balance.
   */
  const [balances, setBalances] = useState<Record<string, number>>({});
  /**
   * Party id → the branch's `suppliers.id` for that party.
   *
   * The A/P ledger is keyed on the branch alias rather than on the party (see
   * the panel mount at the foot of this component), so opening a supplier's
   * statement needs the translation. Absent means this branch has no supplier
   * row for that party, and therefore no payables statement to show.
   */
  const [supplierAliases, setSupplierAliases] = useState<Record<string, string>>({});
  const money = useMoney();

  const columns = useMemo(
    () => scope.columns.filter((column: PartyColumn) => showsColumn(scope, column)),
    [scope],
  );

  // Typing is instant; the query the server sees settles afterwards. Only the
  // text box is debounced — a view switch, a category pick and the archived
  // toggle are deliberate clicks and apply at once.
  useEffect(() => {
    if (query === appliedQuery) return;
    const timer = window.setTimeout(() => setAppliedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, appliedQuery]);

  useEffect(() => setPage(1), [appliedQuery, includeInactive, categoryId, view]);
  // A view switch can retire the chosen category (a personnel-only grouping
  // while the list moved to customers); a filter that no longer exists must
  // not keep silently narrowing the list it names.
  useEffect(() => {
    if (categoryId && !filterCategories.some((category) => category.id === categoryId)) {
      setCategoryId("");
    }
  }, [categoryId, filterCategories]);

  /**
   * The roles as one string. `listedRoles` is an array, so depending on it
   * directly makes `load` a new function whenever the memo re-runs; the joined
   * value is what the request actually carries and compares by value.
   */
  const rolesParam = listedRoles.join(",");

  const load = useCallback(
    (signal?: AbortSignal) => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      params.set("roles", rolesParam);
      if (appliedQuery.trim()) params.set("q", appliedQuery.trim());
      if (includeInactive) params.set("includeInactive", "1");
      if (categoryId) params.set("categoryId", categoryId);
      void api<{ parties: PartyListRow[]; total: number; businessId?: string; error?: string }>(
        `/api/parties?${params}`,
        { signal },
      ).then(({ ok, aborted, data }) => {
        // A response for a query the person has already typed past must not
        // overwrite the list: without this, a slow answer for «ا» landing
        // after a fast one for «احمدی» shows the wrong rows under the right
        // search term.
        if (aborted) return;
        if (ok) {
          setParties(data.parties ?? []);
          setTotal(Number(data.total ?? 0));
          setBusinessId(data.businessId ?? "");
        } else {
          setParties([]);
          setTotal(0);
          setError(errorMessage(data.error));
        }
      });
    },
    [page, appliedQuery, includeInactive, categoryId, rolesParam],
  );
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey]);

  /**
   * Deleting the last row of the last page leaves `page` past the end, and the
   * reload then asks for a page the server has nothing for: an empty list under
   * a pager reading «۳ از ۲». Clamp instead, and the reload above follows.
   */
  useEffect(() => {
    const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
    if (page > pages) setPage(pages);
  }, [total, page]);

  useEffect(() => {
    if (!canSeeLedger || !columns.includes("balance")) {
      setBalances({});
      return;
    }
    const controller = new AbortController();
    void api<{ customers: { customerId: string; balance: number }[] }>("/api/ledger/ar/customers", {
      signal: controller.signal,
    }).then(({ ok, aborted, data }) => {
      if (aborted || !ok) return;
      setBalances(Object.fromEntries((data.customers ?? []).map((row) => [row.customerId, row.balance])));
    });
    return () => controller.abort();
  }, [canSeeLedger, columns, refreshKey]);

  /*
   * The party → supplier-alias map, fetched only where an A/P statement can
   * actually be opened.
   *
   * `?scope=directory` is the variant that lists *every* supplier rather than
   * only those with a nonzero balance, which is what a lookup table needs: a
   * supplier who currently owes nothing still has a statement worth reading.
   * The endpoint is role-gated the same way the statement is, so it is asked
   * for only when `canOpenStatement` is already true — otherwise it would be a
   * guaranteed 403 on every load of a cashier's screen.
   */
  useEffect(() => {
    if (!canOpenStatement || !listedRoles.includes("Supplier")) {
      setSupplierAliases({});
      return;
    }
    const controller = new AbortController();
    void api<{ suppliers: { supplierId: string; supplierPartyId: string | null }[] }>(
      "/api/ledger/ap/suppliers?scope=directory",
      { signal: controller.signal },
    ).then(({ ok, aborted, data }) => {
      if (aborted || !ok) return;
      setSupplierAliases(
        Object.fromEntries(
          (data.suppliers ?? [])
            .filter((row) => row.supplierPartyId)
            .map((row) => [row.supplierPartyId as string, row.supplierId]),
        ),
      );
    });
    return () => controller.abort();
  }, [canOpenStatement, listedRoles, refreshKey]);

  const loadCategories = useCallback((signal?: AbortSignal) => {
    void api<{ categories: CategoryRow[] }>("/api/parties/categories?includeInactive=1", { signal }).then(
      ({ ok, aborted, data }) => {
        if (aborted || !ok) return;
        setCategories(data.categories ?? []);
      },
    );
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    loadCategories(controller.signal);
    return () => controller.abort();
  }, [loadCategories, refreshKey]);

  async function run(
    action: () => Promise<{ ok: boolean; data: { error?: string } }>,
    successInfo = "",
    key = "global",
  ) {
    // One action at a time: they all reload the list when they finish, and two
    // in flight means the second's refresh can land on the first's stale data.
    if (pendingKey !== null) return false;
    setPendingKey(key);
    setError("");
    // The banner on screen must describe the action that just ran. Without
    // this, «شخص حذف شد.» stayed above the list while the next row was being
    // archived, and a failed archive left a success message over its error.
    setInfo("");
    const { ok, data } = await action();
    setPendingKey(null);
    if (!ok) {
      setError(errorMessage(data.error));
      return false;
    }
    if (successInfo) setInfo(successInfo);
    setRefreshKey((key) => key + 1);
    return true;
  }

  /**
   * The status toggle sends `status` alone.
   *
   * That is only safe because the route is patch-shaped: a body that names one key
   * changes one key. A form-shaped PUT (which the party form also uses) would
   * archive a party and blank its address in the same statement.
   */
  async function toggleStatus(party: PartyListRow) {
    const archiving = party.status !== false;
    await run(
      () =>
        api(`/api/parties/${encodeURIComponent(party.id)}`, {
          method: "PUT",
          body: JSON.stringify({ status: party.status === false }),
        }),
      archiving
        ? `«${party.displayName}» بایگانی شد؛ در انتخاب‌گرهای فروش و خرید دیده نمی‌شود.`
        : `«${party.displayName}» دوباره فعال شد.`,
      party.id,
    );
  }

  async function remove(party: PartyListRow) {
    if (
      !window.confirm(
        `«${party.displayName}» حذف شود؟\n\nاگر این شخص سابقهٔ مالی داشته باشد، به‌جای حذف بایگانی می‌شود تا صورتحساب‌ها دست‌نخورده بمانند.`,
      )
    ) {
      return;
    }
    if (pendingKey !== null) return;
    setError("");
    setInfo("");
    setPendingKey(party.id);
    const { ok, data } = await api<{ result?: "deleted" | "archived"; error?: string }>(
      `/api/parties/${encodeURIComponent(party.id)}`,
      { method: "DELETE" },
    );
    setPendingKey(null);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setInfo(
      data.result === "archived"
        ? `«${party.displayName}» سابقهٔ مالی یا شعبه‌ای دارد؛ برای حفظ صورتحساب‌ها به‌جای حذف، بایگانی شد.`
        : `«${party.displayName}» حذف شد.`,
    );
    setRefreshKey((key) => key + 1);
  }

  const totalPages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  // One «افزودن شخص» for the directory — the whole point of one form is that
  // the button does not multiply per role. A single-role section keeps naming
  // its role, because there it is the only thing you could be adding.
  const soleRole = listedRoles.length === 1 ? listedRoles[0] : null;
  const addLabel = soleRole ? `افزودن ${PARTY_ROLE_LABELS[soleRole]}` : "افزودن شخص";
  /**
   * The empty state, in the plural the product already keeps.
   *
   * It used to be built by concatenation — `${PARTY_ROLE_LABELS[role]}ای` —
   * which reads «کارمندای پیدا نشد» for کارمند. `PARTY_ROLE_TAB_LABELS` holds
   * the written plurals («مشتریان»، «کارکنان»، «تأمین‌کنندگان») for exactly
   * this reason.
   */
  const emptyLabel = (() => {
    const searching = appliedQuery.trim().length > 0 || categoryId !== "";
    const subject = soleRole ? PARTY_ROLE_TAB_LABELS[soleRole] : "اشخاص";
    return searching
      ? `هیچ‌کدام از ${subject} با این جستجو یا فیلتر پیدا نشد.`
      : `هنوز ${subject}ی ثبت نشده است.`;
  })();

  /**
   * Where the table takes over from the cards.
   *
   * A fixed `lg` was wrong in both directions: Accounting's seven columns are
   * cramped at 1024px, and the sales picker's two columns sat in the card list
   * on a desktop. The column count decides, and both halves read the same pair
   * so they can never overlap or leave a gap.
   */
  const [tableFrom, cardsUntil] =
    columns.length + (canManage ? 1 : 0) <= 5 ? (["md:block", "md:hidden"] as const) : (["lg:block", "lg:hidden"] as const);

  /**
   * Which statement, if any, this row can open.
   *
   * Three things have to agree: the member's role (the ledger's statement
   * routes are role-gated, not permission-gated), the scope (Accounting's own
   * A/R and A/P sections own that conversation, so the directory does not
   * duplicate it there) and the *party's* roles — an A/R statement for a
   * supplier is an empty table, and personnel have neither.
   */
  const statementKindFor = useCallback(
    (party: PartyListRow): "ar" | "ap" | null => {
      if (!canOpenStatement || scope.key === "accounting") return null;
      const kind = partyStatementKind(partyRoles(party.roles, party.role));
      // A supplier this branch has never bought from has no `suppliers` row,
      // so the A/P ledger has nothing filed under them. Better no button than
      // one that opens an empty statement and reads as lost history.
      if (kind === "ap" && !supplierAliases[party.id]) return null;
      return kind;
    },
    [canOpenStatement, scope.key, supplierAliases],
  );

  const openStatement = useCallback(
    (party: PartyListRow) => {
      const kind = statementKindFor(party);
      if (!kind) return;
      setStatement({ id: party.id, name: party.displayName, kind });
    },
    [statementKindFor],
  );

  /** The facts a card shows, as label/value pairs the scope's columns decide. */
  const cardFacts = useCallback(
    (party: PartyListRow): { label: string; value: ReactNode }[] => {
      const facts: { label: string; value: ReactNode }[] = [];
      const roleLabel = roleLabelInScope(scope, party.role as PartyRole);
      if (roleLabel) facts.push({ label: PARTY_COLUMN_LABELS.role, value: roleLabel });
      if (showsColumn(scope, "phone")) {
        facts.push({
          label: PARTY_COLUMN_LABELS.phone,
          value: party.phone ? (
            // LTR and tabular, like the table cell: a number with a leading
            // zero reorders inside RTL text otherwise.
            <a href={`tel:${party.phone}`} dir="ltr" className="tabular-nums hover:underline">
              {toPersianDigits(formatPhoneDisplay(party.phone))}
            </a>
          ) : (
            "—"
          ),
        });
      }
      if (showsColumn(scope, "email") && party.email) {
        facts.push({ label: PARTY_COLUMN_LABELS.email, value: party.email });
      }
      if (showsColumn(scope, "city") && party.addressInfo?.city) {
        facts.push({ label: PARTY_COLUMN_LABELS.city, value: String(party.addressInfo.city) });
      }
      if (showsColumn(scope, "category") && party.categoryName) {
        facts.push({ label: PARTY_COLUMN_LABELS.category, value: party.categoryName });
      }
      if (showsColumn(scope, "accountingCode")) {
        facts.push({
          label: PARTY_COLUMN_LABELS.accountingCode,
          value: party.accountingCode ? (
            <span dir="ltr" className="tabular-nums">
              {toPersianDigits(party.accountingCode)}
            </span>
          ) : (
            "—"
          ),
        });
      }
      if (showsColumn(scope, "balance") && canSeeLedger) {
        // `balances[id]` is absent for a party the ledger has no line for,
        // which is «۰», not «unknown» — the same distinction the table cell
        // makes. Reading `?? 0` here is what stopped a settled customer from
        // showing the "no access" dash.
        facts.push({
          label: PARTY_COLUMN_LABELS.balance,
          value: (
            <span className="tabular-nums font-medium">{money.format(balances[party.id] ?? 0)}</span>
          ),
        });
      }
      return facts;
    },
    [scope, canSeeLedger, balances, money],
  );

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {info ? <InfoBox>{info}</InfoBox> : null}

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">{scope.description}</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">{scope.label}</h2>
          </div>
        }
        description={
          scope.readOnly
            ? "نمای خواندنی از پروندهٔ مشترک؛ ویرایش در بخش مالک این رکورد انجام می‌شود."
            : canManage
              ? "روی هر ردیف بزنید تا پروندهٔ کاملش باز شود."
              : "در این بخش فقط خوانده می‌شود؛ برای ویرایش، دسترسی «مدیریت اشخاص» لازم است."
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {/*
              A read-only scope (the sales picker) draws no management door:
              the dialog already hides its editor behind `canManage`, but a
              view that cannot write should not offer the panel that writes.
            */}
            {!scope.readOnly ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setShowCategories(true)}>
                دسته‌ها
              </Button>
            ) : null}
            {canManage ? (
              <Button type="button" size="sm" onClick={() => setForm({})}>
                {addLabel}
              </Button>
            ) : null}
          </div>
        }
      >
        {views.length > 1 && onViewChange ? (
          <div className="mb-4">
            <TabBar
              idPrefix="party-directory"
              label="نمای فهرست اشخاص"
              tabs={views.map((candidate) => ({ key: candidate.key, label: candidate.label }))}
              active={activeView.key}
              onChange={onViewChange}
            />
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{activeView.description}</p>
          </div>
        ) : null}

        {/*
          The toolbar stacks on a phone and lays out in a row from `sm` up. It
          is a grid rather than a wrapping flex row because the three controls
          have very different natural widths: as a flex row the `<select>` grew
          with its longest category name and pushed the archived toggle off a
          360px screen.
        */}
        <div className="mb-4 grid min-w-0 gap-3 sm:grid-cols-[minmax(0,16rem)_minmax(0,auto)_auto] sm:items-center">
          <input
            type="search"
            className={`${inputClass} w-full`}
            // A placeholder is not an accessible name: it vanishes on the first
            // keystroke and several screen readers never announce it.
            aria-label="جستجوی اشخاص با نام یا تلفن"
            placeholder="جستجو با نام یا تلفن…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {filterCategories.length > 0 ? (
            <select
              className={`${inputClass} w-full min-w-0`}
              aria-label="فیلتر دسته"
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              <option value="">همهٔ دسته‌ها</option>
              {filterCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="hidden sm:block" />
          )}
          {/*
            Radix renders the checkbox as a <button>, and a <label> does not
            label a button — so the text beside it was decorative and the
            control announced as unnamed. An explicit id/aria-labelledby pair
            is what makes the two one control for a screen reader, and keeps
            the text clickable.
          */}
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              id="parties-include-inactive"
              aria-labelledby="parties-include-inactive-label"
              checked={includeInactive}
              onCheckedChange={(checked) => setIncludeInactive(checked === true)}
            />
            <label
              id="parties-include-inactive-label"
              htmlFor="parties-include-inactive"
              className="cursor-pointer select-none whitespace-nowrap"
            >
              نمایش بایگانی‌شده‌ها
            </label>
          </span>
        </div>

        {!parties ? (
          <LoadingSkeleton rows={3} />
        ) : parties.length === 0 ? (
          <EmptyState>{emptyLabel}</EmptyState>
        ) : (
          <>
            {/*
              Table from `tableFrom` up, cards below it.

              The breakpoint follows the *scope*, not one hard-coded width: the
              CRM draws six columns and needs `lg`, but the store's suppliers
              view draws five and the sales picker two — forcing those into the
              card list on a 900px tablet wasted the width and made a
              five-column list unreadable as a run-on sentence.
            */}
            <DataTable
              caption={`فهرست ${scope.label}`}
              frame={false}
              className={`hidden ${tableFrom}`}
            >
              <DataTableHead>
                {columns.map((column) => (
                  <Th key={column}>{PARTY_COLUMN_LABELS[column]}</Th>
                ))}
                {canManage ? <Th>عملیات</Th> : null}
              </DataTableHead>
              <DataTableBody>
                {parties.map((party) => (
                  <DataTableRow key={party.id} className="align-top">
                    {columns.map((column) => (
                      <Td key={column}>
                        <PartyCell
                          column={column}
                          party={party}
                          scope={scope}
                          showRoleChip={scope.roles.length > 1}
                          showLedger={canSeeLedger}
                          balance={balances[party.id]}
                          formatMoney={(value) => money.format(value)}
                        />
                      </Td>
                    ))}
                    {canManage ? (
                      <Td>
                        <PartyRowActions
                          party={party}
                          pending={pendingKey === party.id}
                          disabled={busy}
                          statementKind={statementKindFor(party)}
                          onEdit={() => setForm({ partyId: party.id, initial: party })}
                          onToggleStatus={() => toggleStatus(party)}
                          onRemove={() => remove(party)}
                          onStatement={() => openStatement(party)}
                        />
                      </Td>
                    ) : null}
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>

            <ul className={`space-y-3 ${cardsUntil}`}>
              {parties.map((party) => (
                <li
                  key={party.id}
                  className="rounded-xl border border-border/80 bg-muted/50 p-4 transition-colors hover:bg-muted"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold break-words text-foreground">{party.displayName}</p>
                    </div>
                    <StatusBadge tone={party.status === false ? "neutral" : "positive"}>
                      {party.status === false ? "بایگانی" : "فعال"}
                    </StatusBadge>
                  </div>
                  {/*
                    Label/value pairs, not a `·`-joined sentence.

                    The Accounting scope carries five facts per row; joined into
                    one line they read as «مشتری · ۰۹۱۲ ۱۲۳ ۴۵۶۷ · عمده · کد
                    ۱۰۰۰۰۷ · ۱۲٬۰۰۰ تومان» — a string in which nothing says
                    which number is the code and which is the balance, and which
                    wraps to four lines on a phone anyway.
                  */}
                  <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                    {cardFacts(party).map((fact) => (
                      <div key={fact.label} className="contents">
                        <dt className="text-muted-foreground">{fact.label}</dt>
                        <dd className="min-w-0 break-words text-foreground">{fact.value}</dd>
                      </div>
                    ))}
                  </dl>
                  {canManage ? (
                    <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/80 pt-2">
                      <PartyRowActions
                        party={party}
                        pending={pendingKey === party.id}
                        disabled={busy}
                        statementKind={statementKindFor(party)}
                        onEdit={() => setForm({ partyId: party.id, initial: party })}
                        onToggleStatus={() => toggleStatus(party)}
                        onRemove={() => remove(party)}
                        onStatement={() => openStatement(party)}
                      />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>

            {totalPages > 1 ? (
              <nav
                aria-label="صفحه‌بندی فهرست اشخاص"
                className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"
              >
                <span aria-live="polite">
                  صفحهٔ {toPersianDigits(String(page))} از {toPersianDigits(String(totalPages))}
                  <span className="ms-2 hidden sm:inline">
                    ({toPersianDigits(String(total))} شخص)
                  </span>
                </span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((current) => Math.max(current - 1, 1))}
                    disabled={page <= 1}
                  >
                    قبلی
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((current) => Math.min(current + 1, totalPages))}
                    disabled={page >= totalPages}
                  >
                    بعدی
                  </Button>
                </div>
              </nav>
            ) : null}
          </>
        )}
      </SectionCard>

      {form ? (
        <PartyFormDialog
          scope={scope}
          partyId={form.partyId ?? null}
          initial={form.initial ?? null}
          businessId={businessId}
          // A new person opens with the current view's role ticked: «افزودن
          // شخص» from «تأمین‌کنندگان» should not start life as a customer.
          defaultRoles={activeView.defaultRoles}
          onClose={() => setForm(null)}
          onSaved={(saved) => {
            setForm(null);
            setError("");
            // Naming the person is the difference between a banner that
            // confirms *this* save and one that could be left over from the
            // previous row.
            const name = saved.displayName ?? saved.name ?? "";
            setInfo(name ? `«${name}» ذخیره شد.` : "شخص ذخیره شد.");
            setRefreshKey((key) => key + 1);
          }}
        />
      ) : null}

      {showCategories ? (
        <PartyCategoriesDialog
          categories={categories}
          canManage={canManage}
          busy={busy}
          run={run}
          onClose={() => setShowCategories(false)}
        />
      ) : null}

      {/*
        The statement is the ledger's own panel — the CRM and the sales screens
        read that balance, they do not restate it.

        Which panel depends on the row: receivables are kept against customers
        and payables against suppliers, so a supplier row opens the A/P
        statement. It used to open the A/R one for every role, which is an
        empty table for a supplier and a meaningless one for an employee.
      */}
      {statement?.kind === "ar" ? (
        <ArStatementPanel
          customerId={statement.id}
          customerName={statement.name}
          onClose={() => setStatement(null)}
        />
      ) : null}
      {/*
        A/P is keyed differently from A/R, and the difference is easy to miss.

        `arLines` joins `parties` directly, so an A/R statement is addressed by
        the party id this list already holds. `apLines` selects `suppliers.id`
        — the *branch alias* — and carries the party as a separate `party_id`
        column, so passing a party id here returns an empty statement rather
        than an error. `supplierAliases` maps one to the other; a supplier the
        branch has never transacted with has no alias, and `statementKindFor`
        withholds the button rather than opening an empty panel.
      */}
      {statement?.kind === "ap" ? (
        <ApStatementPanel
          supplierId={supplierAliases[statement.id] ?? statement.id}
          supplierName={statement.name}
          supplierPartyId={statement.id}
          onClose={() => setStatement(null)}
        />
      ) : null}
    </div>
  );
}

function PartyCell({
  column,
  party,
  scope,
  showRoleChip,
  showLedger,
  balance,
  formatMoney,
}: {
  column: PartyColumn;
  party: PartyListRow;
  scope: PartyScopeDef;
  showRoleChip: boolean;
  /** Whether this role may read the ledger's figures on a party at all. */
  showLedger: boolean;
  balance?: number;
  formatMoney: (value: number) => string;
}) {
  switch (column) {
    case "displayName":
      return (
        <span className="font-medium text-foreground">
          {scope.readOnly ? (
            <Link
              href={partyOwnerScopeForRole((party.role as PartyRole) ?? scope.defaultRole).href}
              className="inline-flex items-center gap-1 hover:underline"
            >
              {party.displayName}
              <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden="true" />
            </Link>
          ) : scope.key === "crm" ? (
            <Link href={crmCustomerHref(party.id)} className="hover:underline">
              {party.displayName}
            </Link>
          ) : (
            party.displayName
          )}
        </span>
      );
    case "role":
      return showRoleChip ? (
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {PARTY_ROLE_LABELS[(party.role as PartyRole) ?? "Customer"]}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    case "phone":
      // The same rendering the CRM's picker uses: the national form a person
      // reads and dials, not the stored shape the search compares, and always
      // LTR so a number with a leading zero never reorders inside RTL text.
      return (
        <span className="text-muted-foreground">
          {party.phone ? (
            // Dialable: this directory is read on a tablet at a counter, and
            // the number is there to be called.
            <a href={`tel:${party.phone}`} dir="ltr" className="tabular-nums hover:underline">
              {toPersianDigits(formatPhoneDisplay(party.phone))}
            </a>
          ) : (
            "—"
          )}
        </span>
      );
    case "email":
      return (
        <span className="text-muted-foreground">
          {party.email ? (
            <a href={`mailto:${party.email}`} dir="ltr" className="hover:underline">
              {party.email}
            </a>
          ) : (
            "—"
          )}
        </span>
      );
    case "city":
      return <span className="text-muted-foreground">{party.addressInfo?.city || "—"}</span>;
    case "category":
      return <span className="text-muted-foreground">{party.categoryName || "—"}</span>;
    case "accountingCode":
      return (
        <span dir="ltr" className="tabular-nums text-muted-foreground">
          {/*
            An explicit emptiness check, not a truthiness one: a code is a
            string the ledger reads back, and `"0"` — however unlikely the
            numbering scheme makes it — is a code, not a missing value.
          */}
          {party.accountingCode != null && party.accountingCode !== ""
            ? toPersianDigits(party.accountingCode)
            : "—"}
        </span>
      );
    case "tax": {
      if (!showLedger) return <span className="tabular-nums text-muted-foreground">—</span>;
      // Read through the same coercion the payload builder and the service
      // use. A rate stored as a *string* by an importer rendered «—» before —
      // the column claimed the party had no rate while the ledger was posting
      // one.
      // `null` is «follows the business rate», not 0 and not a missing value.
      const tax = taxPercentageOf(party);
      return (
        <span className="tabular-nums text-muted-foreground">
          {tax === null ? "نرخ کسب‌وکار" : `${toPersianDigits(String(tax))}٪`}
        </span>
      );
    }
    case "balance":
      /*
        Zero is a balance, and «—» means «you cannot see this».

        Conflating the two — `showLedger && balance` — hid the single most
        reassuring number in the directory: a customer who has settled read
        exactly like a customer whose figures this member may not see.
      */
      return showLedger ? (
        <span className="tabular-nums font-semibold">{formatMoney(balance ?? 0)}</span>
      ) : (
        <span className="tabular-nums text-muted-foreground">—</span>
      );
    case "status":
    default:
      return (
        <StatusBadge tone={party.status === false ? "neutral" : "positive"}>
          {party.status === false ? "بایگانی" : "فعال"}
        </StatusBadge>
      );
  }
}

function PartyRowActions({
  party,
  pending,
  disabled,
  statementKind,
  onEdit,
  onToggleStatus,
  onRemove,
  onStatement,
}: {
  party: PartyListRow;
  /** This row is the one with a request in flight — it says so, in place. */
  pending: boolean;
  /** Some other row is mid-request, so this one's writes wait their turn. */
  disabled: boolean;
  /** Which ledger statement this row opens, or null when it opens none. */
  statementKind: "ar" | "ap" | null;
  onEdit: () => void;
  onToggleStatus: () => void;
  onRemove: () => void;
  onStatement: () => void;
}) {
  const archived = party.status === false;
  /*
    Every action names the person it acts on.

    Four «حذف» buttons in a list are four identical announcements to a screen
    reader, and on a phone the row they belong to is above the fold while the
    button is below it. The visible label stays short; `aria-label` carries the
    row.
  */
  const on = (verb: string) => `${verb} «${party.displayName}»`;
  return (
    <div className="flex flex-wrap gap-1">
      <Button type="button" variant="ghost" size="xs" onClick={onEdit} aria-label={on("ویرایش")}>
        ویرایش
      </Button>
      {statementKind ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onStatement}
          className="text-muted-foreground"
          aria-label={on(statementKind === "ap" ? "صورتحساب پرداختنی" : "صورتحساب دریافتنی")}
        >
          صورتحساب
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={disabled}
        onClick={onToggleStatus}
        className="text-muted-foreground"
        aria-label={on(archived ? "فعال‌سازی" : "بایگانی")}
      >
        {archived ? "فعال‌سازی" : "بایگانی"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={disabled}
        onClick={onRemove}
        aria-label={on("حذف")}
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        حذف
      </Button>
      {/*
        The row says it is working, rather than the page going quiet. `aria-live`
        because the change is a state, not a navigation: a screen reader user
        who pressed «بایگانی» hears that it is under way without being moved.
      */}
      {pending ? (
        <span className="self-center text-xs text-muted-foreground" aria-live="polite">
          در حال انجام…
        </span>
      ) : null}
    </div>
  );
}

/**
 * The category panel.
 *
 * It lives beside the list rather than in a settings screen because a category is
 * not a preference: it is a fact about the parties on this page, edited while the
 * list is open, and a second place to keep the same fact is where two apps start
 * disagreeing about it.
 */
function PartyCategoriesDialog({
  categories,
  canManage,
  busy,
  run,
  onClose,
}: {
  categories: CategoryRow[];
  canManage: boolean;
  busy: boolean;
  run: (
    action: () => Promise<{ ok: boolean; data: { error?: string } }>,
    successInfo?: string,
  ) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  /**
   * The «نام دسته» field's own error.
   *
   * A duplicate name comes back as a 409 carrying `fieldErrors.name`, which the
   * shared `run()` flattened into the section-wide banner above the *list* —
   * far from the input that caused it, and gone the moment anything else ran.
   */
  const [nameError, setNameError] = useState("");

  async function addCategory() {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("نام دسته الزامی است.");
      return;
    }
    setNameError("");
    await run(async () => {
      const result = await api<{ error?: string; fieldErrors?: Record<string, string> }>(
        "/api/parties/categories",
        { method: "POST", body: JSON.stringify({ name: trimmed, role: role || null }) },
      );
      if (result.ok) {
        setName("");
        return result;
      }
      const fieldError = result.data.fieldErrors?.name;
      if (!fieldError) return result;
      // Handled at the field: report it there and tell `run()` the banner has
      // nothing to add.
      setNameError(errorMessage(fieldError));
      return { ok: false as const, data: {} };
    });
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 sm:max-w-md">
        <DialogHeader className="pe-8">
          <DialogTitle>دسته‌های اشخاص</DialogTitle>
          {/*
            Radix warns at runtime for a DialogContent with neither a
            DialogDescription nor aria-describedby, and the explanation was a
            bare <p> that assistive technology never tied to the dialog.
          */}
          <DialogDescription>
            دسته‌ها برای همین فهرست‌اند: یک گروه می‌تواند فقط برای مشتریان باشد، فقط برای تأمین‌کنندگان، یا برای هر سه.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        {canManage ? (
          // `mb-0` on the fields: <Field> carries mb-4, which in a three-column
          // row left the «افزودن» button floating 16px above the inputs'
          // baseline.
          <div className="mb-3 grid min-w-0 items-end gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_auto] [&_label]:mb-0">
            <Field label="نام دسته">
              <input
                className={inputClass}
                maxLength={80}
                value={name}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? "party-category-name-error" : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError("");
                }}
                onKeyDown={(event) => {
                  // A one-field row people fill in repeatedly: Enter submits it
                  // rather than making them reach for the mouse each time.
                  if (event.key === "Enter" && !busy && name.trim()) {
                    event.preventDefault();
                    void addCategory();
                  }
                }}
                placeholder="مثلاً عمده‌فروش"
              />
              {nameError ? (
                <span id="party-category-name-error" className="mt-1 block text-xs text-destructive">
                  {nameError}
                </span>
              ) : null}
            </Field>
            <Field label="نقش">
              <select
                className={inputClass}
                aria-label="نقشی که این دسته برای آن است"
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                <option value="">همه</option>
                {(["Customer", "Employee", "Supplier"] as const).map((partyRole) => (
                  <option key={partyRole} value={partyRole}>
                    {PARTY_ROLE_LABELS[partyRole]}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="button" disabled={busy || !name.trim()} onClick={() => void addCategory()}>
              افزودن
            </Button>
          </div>
        ) : null}
        <ul className="divide-y divide-border/80">
          {categories.map((category) => (
            <li key={category.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <span className={`min-w-0 ${category.isActive ? "" : "text-muted-foreground line-through"}`}>
                <span className="break-words">{category.name}</span>
                {category.role ? (
                  <span className="ms-2 text-xs text-muted-foreground">
                    {PARTY_ROLE_LABELS[category.role as PartyRole] ?? ""}
                  </span>
                ) : null}
                {/*
                  An archived category is offered nowhere as a filter, so say
                  so: without this the strike-through was the only clue, and it
                  is invisible on a long name that wrapped.
                */}
                {!category.isActive ? (
                  <span className="ms-2 text-xs text-muted-foreground">(غیرفعال)</span>
                ) : null}
              </span>
              {/*
                Archiving is reversible.

                The list already asks for `includeInactive=1` and the route
                already accepts `isActive: true`, but only the «غیرفعال‌سازی»
                direction had a button — so a mis-click archived a grouping
                with no way back from any screen in the product. It is the same
                request with the flag flipped.
              */}
              {canManage ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="shrink-0 text-muted-foreground"
                  disabled={busy}
                  aria-label={`${category.isActive ? "غیرفعال‌سازی" : "فعال‌سازی"} دستهٔ «${category.name}»`}
                  onClick={() =>
                    run(
                      () =>
                        api(`/api/parties/categories/${encodeURIComponent(category.id)}`, {
                          method: "PATCH",
                          body: JSON.stringify({ isActive: !category.isActive }),
                        }),
                      category.isActive
                        ? `دستهٔ «${category.name}» غیرفعال شد.`
                        : `دستهٔ «${category.name}» دوباره فعال شد.`,
                    )
                  }
                >
                  {category.isActive ? "غیرفعال‌سازی" : "فعال‌سازی"}
                </Button>
              ) : null}
            </li>
          ))}
          {categories.length === 0 ? (
            <li className="py-3 text-sm text-muted-foreground">دسته‌ای ساخته نشده است.</li>
          ) : null}
        </ul>
        </div>
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={onClose}>
            بستن
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
