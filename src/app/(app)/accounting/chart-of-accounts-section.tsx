"use client";

import { EmptyState, overlayPanelClass, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

import { useEffect, useId, useMemo, useState } from "react";
import { api, ErrorBox, errorMessage, Field, InfoBox, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Button } from "@/components/ui/button";
import { formatPersianNumber, toLatinDigits } from "@/lib/digits";
import type { Runner } from "./accounting-manager";
import {
  ACCOUNT_LEVEL_LABELS,
  WELL_KNOWN_CODES,
  nextAccountLevel,
  type AccountLevel,
  type NormalBalance,
} from "@/lib/coa-template";
import {
  accountSearchHaystack,
  buildAccountTree,
  collectDescendantIds,
  matchesAccountSearch,
} from "@/lib/coa-tree";
import { AccountHistoryPanel } from "./account-history-panel";
import { AccountStatementPanel } from "./account-statement-panel";
import { OverlayDialog } from "./ledger-ui";

type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

const TYPE_LABELS: Record<AccountType, string> = {
  asset: "دارایی",
  liability: "بدهی",
  equity: "حقوق صاحبان سرمایه",
  revenue: "درآمد",
  expense: "هزینه",
};

const NORMAL_BALANCE_LABELS: Record<NormalBalance, string> = {
  debit: "بدهکار",
  credit: "بستانکار",
};

/** Asset/expense carry a debit nature; liability/equity/revenue carry credit (migration 0056). */
const NORMAL_BALANCE_FOR_TYPE: Record<AccountType, NormalBalance> = {
  asset: "debit",
  expense: "debit",
  liability: "credit",
  equity: "credit",
  revenue: "credit",
};

const WELL_KNOWN_CODE_SET = new Set<string>(Object.values(WELL_KNOWN_CODES));

const errorLabels: Record<string, string> = {
  code_required: "کد حساب الزامی است.",
  invalid_code: "کد حساب باید فقط شامل عدد باشد (مثل ۶۱۰۰).",
  name_required: "نام حساب الزامی است.",
  invalid_type: "نوع حساب معتبر نیست.",
  parent_not_found: "حساب والد پیدا نشد.",
  code_in_use: "این کد حساب قبلاً استفاده شده است.",
  account_not_found: "حساب پیدا نشد.",
  parent_cycle: "حساب نمی‌تواند والد خودش یا زیرمجموعه‌اش باشد.",
  well_known_account: "این حساب برای عملکرد سیستم لازم است و قابل غیرفعال یا حذف نیست.",
  account_has_postings: "این حساب سند خورده و قابل حذف نیست؛ می‌توانید آن را غیرفعال کنید.",
  account_has_draft_postings: "این حساب در یک پیش‌نویس استفاده شده و قابل حذف نیست.",
  account_has_children: "ابتدا زیرمجموعه‌های این حساب را جابه‌جا یا حذف کنید.",
  parent_too_deep: "حساب والد از سطح «تفصیلی» است و نمی‌تواند زیرمجموعه داشته باشد.",
  hierarchy_too_deep: "این جابه‌جایی باعث می‌شود ساختار حساب از سطح «تفصیلی» عمیق‌تر شود.",
  parent_type_mismatch: "نوع حساب زیرمجموعه باید با نوع شاخهٔ والد یکسان باشد (دارایی زیر دارایی، هزینه زیر هزینه و…).",
  parent_archived: "نمی‌توان حساب را زیر یک حساب بایگانی‌شده ایجاد یا جابه‌جا کرد.",
  parent_has_active_children: "نمی‌توان حسابی را که زیرمجموعهٔ فعال دارد بایگانی کرد؛ ابتدا زیرمجموعه‌ها را بایگانی یا جابه‌جا کنید.",
  ancestor_archived: "نمی‌توان این حساب را فعال کرد؛ یکی از حساب‌های والد در زنجیره هنوز بایگانی است. ابتدا حساب‌های بالاتر را فعال کنید.",
  bad_request: "درخواست نامعتبر بود.",
  forbidden: "برای تغییر سرفصل حساب‌ها دسترسی «ویرایش سرفصل‌ها» لازم است.",
};

function accountError(code: string | undefined): string {
  return errorLabels[code ?? ""] ?? errorMessage(code);
}

interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  parentCode: string | null;
  isActive: boolean;
  hasPostings: boolean;
  hasDraftPostings: boolean;
  hasChildren: boolean;
  level: AccountLevel;
  normalBalance: NormalBalance;
  isContra: boolean;
}

/** The indentation one tree level costs, in both layouts. */
const INDENT_REM = 1.25;

/**
 * Chart-of-accounts customisation: add sub-accounts, rename, reparent, and
 * archive/restore or delete — first real use of accounts.edit anywhere in
 * the codebase. Archiving keeps every historical posting intact (it's still
 * in every statement/report ever produced) and only stops the account being
 * offered for new ones; deleting is only ever allowed for an account that
 * was never posted to (real or drafted) and has no sub-accounts of its own.
 *
 * The screen is a **tree**, not a flat list. The four-tier
 * گروه/کل/معین/تفصیلی hierarchy is the whole point of the model (migration
 * 0056) and it used to be invisible here: rows came back `ORDER BY code` with
 * the parent reduced to a bare code in a column, so a sub-account whose code
 * does not happen to sort beside its parent's appeared nowhere near it. The
 * ordering and the search live in `@/lib/coa-tree` so they are testable
 * without a browser.
 */
export function ChartOfAccountsSection({
  busy,
  run,
  canEdit = true,
}: {
  busy: boolean;
  run: Runner;
  /**
   * Whether this member holds `accounts.edit`. The API is the real boundary
   * (every mutating route calls `requirePermission`), but a screen that draws
   * «حذف» for somebody who can only ever receive a 403 is offering an error —
   * so the buttons follow the same permission the routes check.
   */
  canEdit?: boolean;
}) {
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [localError, setLocalError] = useState("");
  const [notice, setNotice] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("expense");
  const [parentId, setParentId] = useState("");
  const [isContra, setIsContra] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [visibility, setVisibility] = useState<"all" | "active" | "archived">("all");
  const [reload, setReload] = useState(0);
  const [statementAccount, setStatementAccount] = useState<{ id: string; code: string; name: string } | null>(null);
  const [historyAccount, setHistoryAccount] = useState<{ id: string; code: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<AccountRow | null>(null);
  /* The delete dialog keeps its own error: a failed delete must surface inside
     the open dialog, not in the «افزودن حساب» card's box behind the backdrop
     (which is what sharing `localError` did — and it stayed there afterwards). */
  const [deleteError, setDeleteError] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  /*
   * «ویرایش» — renaming and reparenting.
   *
   * `PATCH /api/ledger/accounts/:id` has supported both since Phase 16, the
   * audit trail records both (`account.renamed` / `account.reparented`, shown by
   * `AccountHistoryPanel`) and this component's own doc comment claimed both,
   * but the screen only ever offered archive and delete: a mistyped account
   * name could be read, audited and reverted — just not corrected.
   */
  const [editing, setEditing] = useState<AccountRow | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api<{ accounts: AccountRow[] }>("/api/ledger/accounts?all=1")
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (ok) {
          setAccounts(data.accounts);
          setLoadFailed(false);
        }
        // An endless skeleton reads as "still loading"; name the failure instead.
        else setLoadFailed(true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  function refresh() {
    setAccounts(null);
    setLoadFailed(false);
    setReload((n) => n + 1);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");
    setNotice("");
    // Codes are identifiers, so «۶۱۰۰» and «6100» must not become two
    // different accounts — the service normalises too; this keeps the field
    // honest about what will be saved.
    const normalizedCode = toLatinDigits(code).trim();
    const trimmedName = name.trim();
    if (!normalizedCode) return setLocalError(errorLabels.code_required);
    if (!trimmedName) return setLocalError(errorLabels.name_required);
    if (accounts?.some((a) => a.code === normalizedCode)) return setLocalError(errorLabels.code_in_use);

    // When a parent is selected the child's type is always inherited from it
    // (issue #824 §2). The type picker is constrained client-side; the server
    // enforces the same rule as the integrity boundary.
    const resolvedParent = parentId ? accounts?.find((a) => a.id === parentId) : undefined;
    const effectiveType: AccountType = resolvedParent ? resolvedParent.type : type;

    setSaving(true);
    try {
      const { ok, data } = await api<{ error?: string }>("/api/ledger/accounts", {
        method: "POST",
        body: JSON.stringify({ code: normalizedCode, name: trimmedName, type: effectiveType, parentId: parentId || null, isContra }),
      });
      if (!ok) {
        setLocalError(accountError(data.error));
        return;
      }
      setCode("");
      setName("");
      setParentId("");
      setIsContra(false);
      setType("expense");
      setNotice(`حساب «${normalizedCode} — ${trimmedName}» اضافه شد.`);
      refresh();
    } catch {
      setLocalError("ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(a: AccountRow) {
    setLocalError("");
    setNotice("");
    setPendingId(a.id);
    const ok = await run(() =>
      api(`/api/ledger/accounts/${a.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !a.isActive }) }),
    );
    setPendingId(null);
    if (ok) {
      setNotice(a.isActive ? `حساب «${a.name}» بایگانی شد.` : `حساب «${a.name}» دوباره فعال شد.`);
      refresh();
    }
  }

  function remove(a: AccountRow) {
    setDeleteError("");
    setNotice("");
    setDeleting(a);
  }

  async function confirmRemove() {
    if (!deleting) return;
    setSaving(true);
    try {
      const { ok, data } = await api<{ error?: string }>(`/api/ledger/accounts/${deleting.id}`, { method: "DELETE" });
      if (!ok) {
        setDeleteError(accountError(data.error));
        return;
      }
      setNotice(`حساب «${deleting.code} — ${deleting.name}» حذف شد.`);
      setDeleting(null);
      refresh();
    } catch {
      setDeleteError("ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.");
    } finally {
      setSaving(false);
    }
  }

  const actionBusy = busy || saving || pendingId !== null;

  // Only an account that can still receive a new child: a «تفصیلی» parent is
  // refused server-side (`parent_too_deep`) and an archived parent is refused
  // too (`parent_archived`, issue #824 §3), so offering either one as a *new*
  // parent in the add form would be offering an error. The edit panel may add
  // the current (already-archived) parent separately so the existing value
  // stays visible. The service enforces the same invariants as the hard
  // boundary; this is just UX.
  const parentOptions = useMemo(
    () => (accounts ?? []).filter((a) => a.isActive && nextAccountLevel(a.level) !== null),
    [accounts],
  );
  // For editing, the current parent (if it has become archived since this
  // account was placed under it) must remain visible so the picker shows the
  // actual current value; otherwise a no-op save would look like the parent
  // was cleared. Moving the account to it again is still refused server-side
  // (`parent_archived`); moving away is allowed. A parent that isn't in
  // `parentOptions` because it is archived is appended to the edit panel's
  // option list with an "[بایگانی‌شده]" suffix rather than silently vanishing.
  const currentParentForEdit = useMemo(
    () => (editing?.parentId ? (accounts ?? []).find((a) => a.id === editing.parentId) ?? null : null),
    [accounts, editing],
  );

  /**
   * The rows to draw: filtered, then ordered as a tree.
   *
   * A matched account keeps its ancestors even when they don't match, because
   * a child shown without its parent is a row with no context — and the
   * indentation would be lying about where it sits. Ancestors kept only for
   * context are drawn dimmed.
   */
  const { rows, matchCount } = useMemo(() => {
    const all = accounts ?? [];
    const byId = new Map(all.map((a) => [a.id, a]));
    const haystacks = new Map(
      all.map((a) => [
        a.id,
        accountSearchHaystack([a.code, a.name, a.parentCode, TYPE_LABELS[a.type], ACCOUNT_LEVEL_LABELS[a.level]]),
      ]),
    );

    const matched = new Set<string>();
    for (const account of all) {
      const visible =
        visibility === "all" || (visibility === "active" ? account.isActive : !account.isActive);
      if (!visible) continue;
      if (!matchesAccountSearch(haystacks.get(account.id) ?? "", search)) continue;
      matched.add(account.id);
    }

    const shown = new Set(matched);
    for (const id of matched) {
      let parent = byId.get(id)?.parentId ?? null;
      const guard = new Set<string>();
      while (parent && !guard.has(parent)) {
        guard.add(parent);
        shown.add(parent);
        parent = byId.get(parent)?.parentId ?? null;
      }
    }

    return {
      rows: buildAccountTree(all.filter((a) => shown.has(a.id))).map((row) => ({
        ...row,
        contextOnly: !matched.has(row.account.id),
      })),
      matchCount: matched.size,
    };
  }, [accounts, search, visibility]);

  if (!accounts) {
    if (loadFailed) {
      return (
        <div className="space-y-3">
          <ErrorBox>بارگذاری سرفصل حساب‌ها ناموفق بود.</ErrorBox>
          <div className="max-w-xs">
            <SecondaryButton onClick={refresh}>تلاش دوباره</SecondaryButton>
          </div>
        </div>
      );
    }
    return <SectionCardSkeleton rows={4} label="در حال بارگذاری سرفصل حساب‌ها" />;
  }

  const filtering = search.trim() !== "" || visibility !== "all";

  return (
    <div className="space-y-4">
      {canEdit ? (
        <SectionCard
          title="افزودن حساب"
          description="فقط حساب‌های مجاز جدید را اضافه کنید؛ حساب‌های سیستمی و دارای سند همچنان با قوانین فعلی محافظت می‌شوند."
          bodyClassName="p-0"
        >
          {localError ? <div className="px-4 pt-4 sm:px-5"><ErrorBox>{localError}</ErrorBox></div> : null}
          <form onSubmit={submit} className="grid gap-x-3 gap-y-1 p-4 sm:p-5 md:grid-cols-2 xl:grid-cols-4">
            <Field label="کد حساب" hint="با ارقام فارسی هم می‌توانید بنویسید؛ به شکل استاندارد ذخیره می‌شود.">
              <input
                className={inputClass}
                dir="ltr"
                inputMode="numeric"
                value={code}
                /* Latin digits in storage, Persian on display (digits.ts), and
                   the placeholder itself invites «۶۱۰۰» — so the field shows
                   what will actually be saved instead of silently changing it
                   on submit. Non-digits are dropped: the server now rejects
                   them outright (`invalid_code`). */
                onChange={(e) => setCode(toLatinDigits(e.target.value).replace(/\D/g, ""))}
                placeholder="مثلاً ۶۱۰۰"
                required
              />
            </Field>
            <Field label="نام حساب">
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="نام حساب" required />
            </Field>
            <Field
              label="نوع حساب"
              hint={
                parentId
                  ? `از والد به ارث رسیده: ${TYPE_LABELS[parentOptions.find((a) => a.id === parentId)?.type ?? type]}`
                  : `ماهیت این حساب: ${NORMAL_BALANCE_LABELS[NORMAL_BALANCE_FOR_TYPE[type]]}`
              }
            >
              <SearchableSelect
                value={type}
                onChange={(value) => setType(value as AccountType)}
                ariaLabel="نوع حساب"
                disabled={!!parentId}
                options={(Object.keys(TYPE_LABELS) as AccountType[]).map((t) => ({ value: t, label: TYPE_LABELS[t] }))}
              />
            </Field>
            <Field
              label="حساب والد"
              hint={
                parentId
                  ? `سطح حساب جدید: ${
                      ACCOUNT_LEVEL_LABELS[
                        nextAccountLevel(parentOptions.find((a) => a.id === parentId)?.level ?? null) ?? "tafsili"
                      ]
                    } — نوع حساب به‌طور خودکار از والد تعیین می‌شود.`
                  : "بدون والد، حساب در سطح «گروه» ساخته می‌شود."
              }
            >
              <SearchableSelect
                value={parentId}
                onChange={(value) => {
                  setParentId(value);
                  // When a parent is chosen, the child's type must match the
                  // parent's branch (issue #824 §2) — so the picker locks to
                  // that type automatically instead of letting the user pick a
                  // mismatch that the server will reject. Clearing the parent
                  // does not revert the type (no opinion either way), but it
                  // does unlock the picker.
                  if (value) {
                    const parent = parentOptions.find((a) => a.id === value);
                    if (parent) setType(parent.type);
                  }
                }}
                ariaLabel="حساب والد"
                options={[
                  { value: "", label: "بدون والد (سطح گروه)" },
                  ...parentOptions.map((a) => ({
                    value: a.id,
                    label: `${a.code} — ${a.name} (${ACCOUNT_LEVEL_LABELS[a.level]}، ${TYPE_LABELS[a.type]})`,
                  })),
                ]}
              />
            </Field>
            <label className="mb-4 flex items-center gap-2 md:col-span-2 xl:col-span-4">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={isContra}
                onChange={(e) => setIsContra(e.target.checked)}
              />
              <span className="text-sm font-medium">حساب کاهنده (مثلاً برگشت از فروش)</span>
            </label>
            <div className="md:col-span-2 xl:col-span-4">
              <div className="max-w-xs">
                <PrimaryButton disabled={actionBusy}>{saving ? "در حال افزودن…" : "افزودن حساب"}</PrimaryButton>
              </div>
            </div>
          </form>
        </SectionCard>
      ) : (
        <InfoBox>
          شما دسترسی «ویرایش سرفصل‌ها» ندارید؛ سرفصل حساب‌ها فقط برای مشاهده و بررسی گردش حساب در دسترس است.
        </InfoBox>
      )}

      <SectionCard
        description={
          filtering
            ? `${formatPersianNumber(matchCount)} حساب از ${formatPersianNumber(accounts.length)} حساب با این فیلتر پیدا شد.`
            : `${formatPersianNumber(accounts.length)} حساب، به ترتیب ساختار درختی گروه ← کل ← معین ← تفصیلی.`
        }
        bodyClassName="p-0"
      >
        {!canEdit && localError ? <div className="px-4 pt-4 sm:px-5"><ErrorBox>{localError}</ErrorBox></div> : null}
        {notice ? (
          <div className="px-4 pt-4 sm:px-5">
            <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
              {notice}
            </p>
          </div>
        ) : null}
        <div className="border-b border-border/80 p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">جست‌وجوی حساب</span>
              <input
                className={inputClass}
                type="search"
                dir="auto"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="کد، نام، نوع یا حساب والد…"
                aria-label="جست‌وجوی سرفصل حساب‌ها"
              />
            </label>
            <div
              role="group"
              aria-label="فیلتر وضعیت حساب"
              className="grid grid-cols-3 gap-2 sm:min-w-72"
            >
              {([
                ["all", "همه"],
                ["active", "فعال"],
                ["archived", "بایگانی‌شده"],
              ] as const).map(([key, label]) => (
                <Button
                  key={key}
                  type="button"
                  variant="outline"
                  aria-pressed={visibility === key}
                  onClick={() => setVisibility(key)}
                  className={`min-h-10 rounded-xl px-3 text-sm font-medium ${
            visibility === key
                      ? "border-amber-200 bg-amber-100 text-amber-950 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200 dark:hover:bg-amber-500/20"
                      : "border-border/80 bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
        </div>
        <div className="p-4 sm:p-5">
          {rows.length === 0 ? (
            <EmptyState>
              {accounts.length === 0
                ? "هنوز سرفصلی ثبت نشده است. از فرم بالا اولین حساب را اضافه کنید."
                : "حسابی با این فیلتر پیدا نشد؛ عبارت جست‌وجو یا وضعیت را تغییر دهید."}
            </EmptyState>
          ) : (
            <>
              {/* The desktop table. `hidden … lg:block` — it used to be only
                  `lg:block`, which is not a hiding rule at all, so both this
                  and the card list below rendered together on a phone. */}
              <DataTable caption="سرفصل حساب‌ها، به ترتیب ساختار درختی" className="hidden lg:block">
                <DataTableHead>
                  <Th>کد</Th>
                  <Th>حساب</Th>
                  <Th>نوع</Th>
                  <Th>سطح</Th>
                  <Th>ماهیت</Th>
                  <Th>وضعیت</Th>
                  <Th>عملیات</Th>
                </DataTableHead>
                <DataTableBody>
                  {rows.map(({ account: a, depth, contextOnly }) => (
                    <DataTableRow key={a.id} selected={pendingId === a.id} className={contextOnly ? "opacity-60" : undefined}>
                      <Td dir="ltr" nowrap muted className="text-start font-medium tabular-nums">
                        {a.code}
                      </Td>
                      <Td className="font-semibold">
                        <span className="flex min-w-0 items-center gap-1.5" style={{ paddingInlineStart: `${depth * INDENT_REM}rem` }}>
                          {depth > 0 ? (
                            <span aria-hidden="true" className="select-none text-muted-foreground">
                              └
                            </span>
                          ) : null}
                          <span className="min-w-0 break-words">{a.name}</span>
                          {WELL_KNOWN_CODE_SET.has(a.code) ? <StatusBadge tone="active">سیستمی</StatusBadge> : null}
                          {a.isContra ? <StatusBadge tone="neutral">کاهنده</StatusBadge> : null}
                        </span>
                      </Td>
                      <Td muted>{TYPE_LABELS[a.type]}</Td>
                      <Td muted>{ACCOUNT_LEVEL_LABELS[a.level]}</Td>
                      <Td muted>{NORMAL_BALANCE_LABELS[a.normalBalance]}</Td>
                      <Td>
                        <StatusBadge tone={a.isActive ? "positive" : "neutral"}>
                          {a.isActive ? "فعال" : "بایگانی‌شده"}
                        </StatusBadge>
                      </Td>
                      <Td>
                        <AccountActions
                          account={a}
                          canEdit={canEdit}
                          busy={actionBusy}
                          pending={pendingId === a.id}
                          onEdit={() => { setLocalError(""); setNotice(""); setEditing(a); }}
                          onStatement={() => setStatementAccount({ id: a.id, code: a.code, name: a.name })}
                          onHistory={() => setHistoryAccount({ id: a.id, code: a.code, name: a.name })}
                          onToggle={() => void toggleActive(a)}
                          onRemove={() => remove(a)}
                          onBlockedRemove={setNotice}
                        />
                      </Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>

              <div className="space-y-3 lg:hidden">
                {rows.map(({ account: a, depth, contextOnly }) => (
                  <article
                    key={a.id}
                    // Indentation is capped on a phone: past two levels it eats
                    // the card rather than explaining it, and the «والد» row
                    // below already names where the account sits.
                    style={{ marginInlineStart: `${Math.min(depth, 2) * 0.75}rem` }}
                    className={`rounded-xl border border-border/80 bg-muted/60 p-4 ${
                      contextOnly ? "opacity-60" : ""
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p dir="ltr" className="text-start text-xs font-medium tabular-nums text-muted-foreground">{a.code}</p>
                        {/* `truncate` used to cut a long Persian account name
                            off with no way to read it; wrapping is what a card
                            layout is for. */}
                        <h3 className="mt-1 text-sm font-semibold break-words text-foreground">{a.name}</h3>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {WELL_KNOWN_CODE_SET.has(a.code) ? <StatusBadge tone="active">سیستمی</StatusBadge> : null}
                          {a.isContra ? <StatusBadge tone="neutral">کاهنده</StatusBadge> : null}
                        </div>
                      </div>
                      <StatusBadge tone={a.isActive ? "positive" : "neutral"}>
                        {a.isActive ? "فعال" : "بایگانی‌شده"}
                      </StatusBadge>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-sm">
                      <div><dt className="text-xs text-muted-foreground">نوع</dt><dd className="mt-1 text-foreground">{TYPE_LABELS[a.type]}</dd></div>
                      <div><dt className="text-xs text-muted-foreground">سطح</dt><dd className="mt-1 text-foreground">{ACCOUNT_LEVEL_LABELS[a.level]}</dd></div>
                      <div><dt className="text-xs text-muted-foreground">ماهیت</dt><dd className="mt-1 text-foreground">{NORMAL_BALANCE_LABELS[a.normalBalance]}</dd></div>
                      <div>
                        <dt className="text-xs text-muted-foreground">والد</dt>
                        <dd dir="ltr" className="mt-1 text-start tabular-nums text-foreground">{a.parentCode ?? "—"}</dd>
                      </div>
                    </dl>
                    <div className="mt-3">
                      <AccountActions
                        account={a}
                        canEdit={canEdit}
                        busy={actionBusy}
                        pending={pendingId === a.id}
                        stacked
                        onEdit={() => { setLocalError(""); setNotice(""); setEditing(a); }}
                        onStatement={() => setStatementAccount({ id: a.id, code: a.code, name: a.name })}
                        onHistory={() => setHistoryAccount({ id: a.id, code: a.code, name: a.name })}
                        onToggle={() => void toggleActive(a)}
                        onRemove={() => remove(a)}
                        onBlockedRemove={setNotice}
                      />
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </SectionCard>

      {statementAccount ? (
        <AccountStatementPanel
          accountId={statementAccount.id}
          accountCode={statementAccount.code}
          accountName={statementAccount.name}
          onClose={() => setStatementAccount(null)}
        />
      ) : null}

      {editing ? (
        <EditAccountPanel
          account={editing}
          // A parent that is the account itself, or anything below it, is the
          // one move the server always rejects (`parent_cycle`) — and the list
          // used to offer every one of them. If the current parent is archived
          // (now filtered out of parentOptions) it is still included so the
          // picker displays the existing value; moving to it is still blocked
          // server-side if it's archived, but selecting no-op is fine.
          parentOptions={(() => {
            const cycleSafe = parentOptions.filter(
              (candidate) =>
                candidate.id !== editing.id &&
                !collectDescendantIds(accounts ?? [], editing.id).has(candidate.id),
            );
            if (currentParentForEdit && !cycleSafe.some((c) => c.id === currentParentForEdit.id)) {
              return [...cycleSafe, currentParentForEdit];
            }
            return cycleSafe;
          })()}
          busy={busy}
          canEdit={canEdit}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setNotice(message);
            refresh();
          }}
        />
      ) : null}

      {historyAccount ? (
        <AccountHistoryPanel
          accountId={historyAccount.id}
          accountCode={historyAccount.code}
          accountName={historyAccount.name}
          onClose={() => setHistoryAccount(null)}
        />
      ) : null}

      {deleting ? (
        <DeleteAccountPanel
          account={deleting}
          busy={actionBusy}
          error={deleteError}
          onClose={() => {
            setDeleteError("");
            setDeleting(null);
          }}
          onConfirm={() => void confirmRemove()}
        />
      ) : null}
    </div>
  );
}

/**
 * One account's actions.
 *
 * Read-only actions (گردش حساب) are always offered. تاریخچه (audit) is offered
 * only to editors to match the `accounts.edit` gate on the history API. Write
 * actions (ویرایش، بایگانی/فعال کردن، حذف) are drawn only for a member who
 * holds `accounts.edit`. «حذف» additionally needs an account with no real
 * postings, no draft postings, no children, and not a well-known system account
 * — the same four guards the service enforces; when not deletable the control
 * is shown as a disabled explanatory chip (with the reason inline and on hover)
 * rather than hidden, so keyboard and touch users can discover why without
 * having to guess through an error dialog. System/well-known accounts are
 * never archivable.
 */
function AccountActions({
  account,
  canEdit,
  busy,
  pending,
  stacked = false,
  onEdit,
  onStatement,
  onHistory,
  onToggle,
  onRemove,
  onBlockedRemove,
}: {
  account: AccountRow;
  canEdit: boolean;
  busy: boolean;
  pending: boolean;
  stacked?: boolean;
  onEdit: () => void;
  onStatement: () => void;
  onHistory: () => void;
  onToggle: () => void;
  onRemove: () => void;
  /** Report *why* deletion is unavailable when the user tries anyway. */
  onBlockedRemove: (reason: string) => void;
}) {
  // One id per row: `aria-describedby` needs a stable target for the inline
  // reason text, and rows are rendered many times on one screen.
  const blockedReasonId = useId();
  const isWellKnown = WELL_KNOWN_CODE_SET.has(account.code);
  // Mirror the service's delete guards exactly (issue #824 §4): real postings,
  // draft postings, children, and well-known codes each block deletion. The
  // UI says why rather than letting the user discover it through a failed
  // confirmation dialog.
  const deletable =
    !account.hasPostings && !account.hasDraftPostings && !account.hasChildren && !isWellKnown;
  const deleteBlockedReason = isWellKnown
    ? "حساب سیستمی قابل حذف نیست"
    : account.hasPostings
    ? "دارای سند ثبت‌شده"
    : account.hasDraftPostings
    ? "در پیش‌نویس استفاده شده"
    : account.hasChildren
    ? "دارای زیرمجموعه"
    : null;

  return (
    <div className={`flex flex-wrap gap-2 ${stacked ? "" : "justify-start"}`}>
      {canEdit ? (
        <SecondaryButton onClick={onEdit} disabled={busy}>
          ویرایش
        </SecondaryButton>
      ) : null}
      <SecondaryButton onClick={onStatement}>گردش حساب</SecondaryButton>
      {canEdit ? <SecondaryButton onClick={onHistory}>تاریخچه</SecondaryButton> : null}
      {canEdit ? (
        <SecondaryButton
          onClick={onToggle}
          // A well-known account is refused server-side (`well_known_account`),
          // so the control explains itself rather than producing an error.
          disabled={busy || isWellKnown}
          className={isWellKnown ? "cursor-not-allowed" : undefined}
        >
          {pending ? "در حال اعمال…" : account.isActive ? "بایگانی" : "فعال کردن"}
        </SecondaryButton>
      ) : null}
      {canEdit ? (
        deletable ? (
          <Button type="button" variant="destructive" onClick={onRemove} disabled={busy} className="px-4">
            حذف
          </Button>
        ) : (
          /*
           * The account cannot be deleted, and the control says so where the
           * user is looking rather than letting them discover it through a
           * failed dialog (issue #824 §4 / review item 5).
           *
           * It stays a real <button> — `aria-disabled` rather than `disabled`
           * — so it is reachable by Tab and announced with its reason through
           * `aria-describedby`. A `disabled` control is skipped by the tab
           * order, which is exactly how the reason used to become invisible to
           * keyboard and screen-reader users. Activating it reports the reason
           * in the panel's own notice area, so a tap gives feedback on touch
           * devices too (where a title/tooltip never appears).
           */
          <button
            type="button"
            aria-disabled="true"
            aria-describedby={blockedReasonId}
            title={deleteBlockedReason ?? ""}
            onClick={() => onBlockedRemove(deleteBlockedReason ?? "")}
            className="inline-flex min-h-9 cursor-not-allowed items-center gap-1 rounded-xl border border-border/80 px-3 py-2 text-xs font-medium text-muted-foreground"
          >
            <span aria-hidden="true" className="select-none">⛔</span>
            <span>حذف</span>
          </button>
        )
      ) : null}
      {canEdit && !deletable && deleteBlockedReason ? (
        // Visible text, not only a tooltip: this is what a touch user reads,
        // and it is the node `aria-describedby` points at.
        <span
          id={blockedReasonId}
          className="inline-flex items-center text-[11px] text-muted-foreground"
        >
          {deleteBlockedReason}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Rename an account, move it under another, or flip its contra flag.
 *
 * One PATCH covers every requested change (applied in a single transaction by
 * `updateAccount`), and only the fields that actually changed are sent — the
 * route treats a present `parentId` as an instruction, so sending an unchanged
 * one would write an audit row saying it moved when it did not.
 *
 * `code` and `type` are deliberately absent: the auto-posting engine looks
 * accounts up *by code* (`WELL_KNOWN_CODES`), and the account's type decides
 * which side of the statements it lands on. Neither is a rename — changing
 * either is a new account plus a reclassifying entry, which is a different
 * (and audited) operation. `isContra` *is* editable (issue #824 §6): a mistaken
 * contra flag does not change postings, only how the balance is presented.
 */
function EditAccountPanel({
  account,
  parentOptions,
  busy,
  canEdit,
  onClose,
  onSaved,
}: {
  account: AccountRow;
  parentOptions: AccountRow[];
  busy: boolean;
  canEdit: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [name, setName] = useState(account.name);
  const [parentId, setParentId] = useState(account.parentId ?? "");
  const [isContra, setIsContra] = useState(account.isContra);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isWellKnown = WELL_KNOWN_CODE_SET.has(account.code);

  const nameChanged = name.trim() !== account.name;
  const parentChanged = (parentId || null) !== (account.parentId ?? null);
  const contraChanged = isContra !== account.isContra;
  const dirty = nameChanged || parentChanged || contraChanged;
  const canSave = !!name.trim() && dirty;

  // Closing a form with edits in it silently discards them, so the way out
  // asks first — the same guard the party form draws, for the same reason.
  function requestClose() {
    if (saving) return;
    if (dirty && !window.confirm("تغییرهای ذخیره‌نشده‌ای در این فرم دارید. بستن فرم آن‌ها را کنار می‌گذارد. ادامه می‌دهید؟")) {
      return;
    }
    onClose();
  }

  const selectedParent = parentOptions.find((a) => a.id === parentId);
  const nextLevel = parentId
    ? nextAccountLevel(selectedParent?.level ?? null)
    : "group";

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError("");
    const body: { name?: string; parentId?: string | null; isContra?: boolean } = {};
    if (nameChanged) body.name = name.trim();
    if (parentChanged) body.parentId = parentId || null;
    if (contraChanged) body.isContra = isContra;
    try {
      const { ok, data } = await api<{ error?: string }>(`/api/ledger/accounts/${account.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      if (!ok) {
        setError(accountError((data as { error?: string }).error));
        return;
      }
      onSaved(`تغییرهای حساب «${account.code} — ${name.trim()}» ذخیره شد.`);
    } catch {
      setError("ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <OverlayDialog
      headingId="edit-account-heading"
      onClose={requestClose}
      className={`${overlayPanelClass} max-h-[88vh] w-full max-w-md overflow-y-auto p-4 sm:max-h-[80vh] sm:p-5`}
    >
        <header className="mb-4 border-b border-border pb-4">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">ویرایش حساب</p>
          <h3 id="edit-account-heading" className="mt-1 text-lg font-bold break-words">
            <span dir="ltr">{account.code}</span> — {account.name}
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            کد و نوع حساب قابل تغییر نیستند؛ سندهای خودکار حساب‌ها را با کد پیدا می‌کنند. نام، حساب والد و وضعیت کاهنده قابل ویرایش هستند.
          </p>
        </header>

        {error ? <ErrorBox>{error}</ErrorBox> : null}

        <div className="space-y-3">
          <Field label="نام حساب">
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="نام حساب"
              autoFocus
              disabled={!canEdit}
            />
          </Field>
          <Field
            label="حساب والد"
            hint={
              nextLevel
                ? `با این انتخاب، سطح حساب «${ACCOUNT_LEVEL_LABELS[nextLevel]}» می‌شود.`
                : undefined
            }
          >
            <SearchableSelect
              value={parentId}
              onChange={setParentId}
              ariaLabel="حساب والد"
              disabled={!canEdit}
              options={[
                { value: "", label: "بدون والد (سطح گروه)" },
                ...parentOptions.map((a) => ({
                  value: a.id,
                  label: `${a.code} — ${a.name} (${ACCOUNT_LEVEL_LABELS[a.level]})${!a.isActive ? " [بایگانی‌شده]" : ""}`,
                })),
              ]}
            />
            {account.hasChildren ? (
              <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">
                زیرمجموعه‌های این حساب هم همراه آن جابه‌جا می‌شوند. جابه‌جایی زیرشاخه‌ها را نیز از نظر نوع حساب اعتبارسنجی می‌کند.
              </span>
            ) : null}
          </Field>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={isContra}
              onChange={(e) => setIsContra(e.target.checked)}
              disabled={!canEdit || isWellKnown}
            />
            <span className="text-sm font-medium">
              حساب کاهنده
              {isWellKnown ? " (برای حساب‌های سیستمی تغییرپذیر نیست)" : ""}
            </span>
          </label>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <SecondaryButton onClick={requestClose} disabled={saving || busy}>
            انصراف
          </SecondaryButton>
          <PrimaryButton type="button" onClick={() => void save()} disabled={saving || busy || !canSave || !canEdit}>
            {saving ? "در حال ذخیره…" : "ذخیره تغییرات"}
          </PrimaryButton>
        </div>
      </OverlayDialog>
  );
}

function DeleteAccountPanel({
  account,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  account: AccountRow;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {

  return (
    <OverlayDialog
      headingId="delete-account-heading"
      describedById="delete-account-description"
      role="alertdialog"
      onClose={onClose}
      dismissible={!busy}
      className={`${overlayPanelClass} max-h-[88vh] w-full max-w-md overflow-y-auto p-4 sm:p-5`}
    >
        <p className="text-xs font-semibold text-rose-700 dark:text-rose-300">حذف سرفصل</p>
        <h3 id="delete-account-heading" className="mt-1 text-lg font-bold break-words">
          حذف <span dir="ltr">{account.code}</span> — {account.name}؟
        </h3>
        <p id="delete-account-description" className="mt-2 text-sm leading-6 text-muted-foreground">
          این کار فقط وقتی انجام می‌شود که حساب هیچ سند، پیش‌نویس یا زیرمجموعه‌ای نداشته باشد و قابل بازگشت نیست.
        </p>
        {error ? <div className="mt-4"><ErrorBox>{error}</ErrorBox></div> : null}
        <div className="mt-5 grid grid-cols-2 gap-3">
          <SecondaryButton onClick={onClose} disabled={busy}>انصراف</SecondaryButton>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy ? "در حال حذف…" : "حذف حساب"}
          </Button>
        </div>
      </OverlayDialog>
  );
}
