"use client";

/**
 * Accounting → هزینه‌های کارفرما — the reimbursable-cost register (issue #1128 §D).
 *
 * ## The three acts, and why they are one screen
 *
 * §D asks for three things that only make sense together: money an agency spends on a
 * client's behalf, the invoice that bills it back, and the business's choice of gross
 * versus net presentation. Wave 10 built the first, wave 11 the second and wave 12 the
 * third — all of them behind routes with no screen, so the whole of §D's cost side was
 * reachable only by an API call. This is the member-facing half.
 *
 * They sit on one page because the choice governs the recording and the recording
 * governs the recharge: a member who records a cost without knowing which account it
 * landed in cannot explain the invoice that follows, and a business that has not
 * chosen a policy is choosing it again on every row.
 *
 * ## What the screen refuses to do
 *
 * 1. **It never guesses the presentation.** The record form's first option is
 *    «پیروی از سیاست کسب‌وکار», which sends *nothing*: the service resolves the
 *    policy, or the documented fallback while there is none. Choosing explicitly is a
 *    deliberate override of the business's own decision, so it is the second option
 *    and says so. §D's rule is that presentation "must not be inferred solely from
 *    spend" — a form that pre-filled an account from the size of a line would be
 *    exactly that inference.
 * 2. **It never shows a default as a decision.** When `policy.stored` is false the
 *    card reads «هنوز انتخاب نشده» and names the fallback separately, because a
 *    business that adopted a policy and one the software is standing in for are not in
 *    the same state and must not look alike.
 * 3. **It never re-derives where the money went.** The table prints `accounts.debitCode`
 *    as the API served it rather than mapping `presentation` back to a code locally:
 *    the ledger is the record of the posting, and a second mapping is a second answer
 *    that can disagree with it.
 * 4. **It never lets a recharge half-happen.** Only posted, unrecharged costs are
 *    selectable, and only costs of one client can be selected together — the three
 *    refusals `rechargeAgencyCosts` makes are shown as disabled controls with their
 *    reason, so a member is not handed a form that will refuse them.
 *
 * ## Permissions mirror the routes, not the page
 *
 * The door is `ledger.view`. Recording and changing the policy are
 * `finance.expenses_manage`; recharging also needs `orders.create`, because it raises
 * an invoice. The page hands those three booleans down, so a member who may read the
 * register but not move money sees the figures and no buttons — navigation is not
 * authorization, and neither is a hidden control.
 */

import { SupplierPartyPicker } from "./supplier-party-picker";
import { VendorPaymentControls } from "./vendor-payment-controls";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  SecondaryButton,
  errorMessage,
  inputClass,
} from "@/app/dashboard/ui";
import { EmptyState, LoadingSkeleton, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead } from "@/app/dashboard/data-table";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { CustomerSearchField } from "@/app/(app)/crm/customer-search";
import {
  AGENCY_COST_SETTLEMENTS,
  AGENCY_COST_SETTLEMENT_LABELS,
  type AgencyCostSettlement,
} from "@/lib/agency-reimbursable-cost";

/* ------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Declared here rather than imported from the service: that module imports `pg`, and a
 * client component reaching through it would drag the driver into the browser bundle.
 * The constants below come from `agency-reimbursable-cost.ts`, which is pure.
 */
type CostWire = {
  id: string;
  costNumber: string;
  partyId: string;
  clientName: string;
  projectId: string | null;
  projectName: string | null;
  vendorName: string;
  vendorPartyId?: string | null;
  vendorPartyName?: string | null;
  description: string;
  amountRial: number;
  spentOn: string;
  presentation: "net" | "gross";
  settledBy: AgencyCostSettlement;
  note: string;
  posted: boolean;
  accounts: { debitCode: string; creditCode: string };
  passThrough: boolean;
  rechargedOrderId: string | null;
  rechargedByName: string;
  recharged: boolean;
  settled?: boolean;
  settlementId?: string | null;
  settlementNumber?: string | null;
};

type PolicyWire = {
  policy: { presentation: "net" | "gross"; stored: boolean; updatedAt: string | null };
  /** The choice in the register's own words, served by the API so this screen cannot drift from it. */
  options: { value: string; label: string; hint: string }[];
  /** What happens while nobody has chosen — named separately from `policy.presentation`. */
  fallback: "net" | "gross";
};

type ProjectWire = { id: string; name: string };

type RechargeWire = { orderId: string; orderNumber: number; totalRial: number };

/** What the record form holds. Strings, because that is what an input holds. */
type Draft = {
  partyId: string | null;
  clientName: string;
  projectId: string;
  vendorName: string;
  vendorPartyId: string;
  description: string;
  amountRial: string;
  spentOn: string;
  settledBy: AgencyCostSettlement;
  /** Empty means «follow the business policy» — sent as absent, never as a guess. */
  presentation: "" | "net" | "gross";
  note: string;
};

const EMPTY_DRAFT: Draft = {
  partyId: null,
  clientName: "",
  projectId: "",
  vendorName: "",
  vendorPartyId: "",
  description: "",
  amountRial: "",
  spentOn: "",
  settledBy: "payable",
  presentation: "",
  note: "",
};

/** Why a cost cannot be part of a recharge, in the member's words. */
function rechargeBlocker(cost: CostWire): string | null {
  if (!cost.posted) return "هنوز در دفتر ثبت نشده";
  if (cost.recharged) return "بازدریافت شده";
  return null;
}

/* ------------------------------------------------------------------------- */
/* The screen                                                                 */
/* ------------------------------------------------------------------------- */

export function ClientCostsSection({
  canRecord,
  canRecharge,
  canSetPolicy,
  canSettle = false,
  canChooseVendor = false,
}: {
  /** `finance.expenses_manage` — record a cost. */
  canRecord: boolean;
  /** `orders.create` *and* `finance.expenses_manage` — raise the recharge invoice. */
  canRecharge: boolean;
  /** `finance.expenses_manage` — choose the business's presentation policy. */
  canSetPolicy: boolean;
  canSettle?: boolean;
  canChooseVendor?: boolean;
}) {
  const money = useMoney();

  const [costs, setCosts] = useState<CostWire[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [policy, setPolicy] = useState<PolicyWire | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);

  // Loaded best-effort: the picker is a convenience over an optional field, and a
  // member whose workspace is not activated must still be able to record a cost.
  const [projects, setProjects] = useState<ProjectWire[]>([]);

  const [query, setQuery] = useState("");
  const [postedFilter, setPostedFilter] = useState<"all" | "posted" | "pending">("all");
  const [selected, setSelected] = useState<readonly string[]>([]);

  const [recordOpen, setRecordOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyChoice, setPolicyChoice] = useState<string>("");
  const [policySaving, setPolicySaving] = useState(false);

  const [recharging, setRecharging] = useState(false);
  const [recharged, setRecharged] = useState<RechargeWire | null>(null);

  /* ------------------------------- loading ------------------------------- */

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ limit: "200" });
    if (query.trim()) params.set("q", query.trim());
    if (postedFilter === "posted") params.set("posted", "1");
    if (postedFilter === "pending") params.set("posted", "0");
    api<{ costs?: CostWire[]; error?: string }>(`/api/agency/reimbursable-costs?${params}`)
      .then((result) => {
        if (cancelled || result.aborted) return;
        if (!result.ok || !result.data.costs) {
          setLoadError(errorMessage(result.data.error ?? "load_failed"));
          setCosts(null);
          return;
        }
        setCosts(result.data.costs);
        setLoadError(null);
      })
      .catch(() => {
        if (!cancelled) setLoadError("خواندن هزینه‌ها ممکن نشد.");
      });
    return () => {
      cancelled = true;
    };
  }, [query, postedFilter, reloadKey]);

  const loadPolicy = useCallback(async () => {
    try {
      const result = await api<PolicyWire & { error?: string }>("/api/agency/reimbursable-costs/policy");
      if (result.aborted) return;
      if (!result.ok || !result.data.policy) {
        setPolicyError(errorMessage(result.data.error ?? "load_failed"));
        return;
      }
      setPolicy(result.data);
      setPolicyError(null);
    } catch {
      setPolicyError("خواندن سیاست ارائه ممکن نشد.");
    }
  }, []);

  useEffect(() => {
    void loadPolicy();
  }, [loadPolicy, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    api<{ projects?: ProjectWire[]; error?: string }>("/api/workspace/projects?status=all")
      .then((result) => {
        if (!cancelled && !result.aborted && result.ok) setProjects(result.data.projects ?? []);
      })
      .catch(() => {
        // A member without the workspace door simply records costs with no project.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* ------------------------------ the totals ----------------------------- */

  /**
   * Three figures, each computed only from rows this screen actually read: what the
   * agency has spent on clients' behalf, how much of it has come back, and how much
   * is still a claim on a client. A list must not print a figure it did not read, so
   * these are sums of the loaded page and say so.
   */
  const totals = useMemo(() => {
    const rows = costs ?? [];
    let spent = 0;
    let back = 0;
    for (const row of rows) {
      spent += row.amountRial;
      if (row.recharged) back += row.amountRial;
    }
    return { spent, back, outstanding: spent - back, count: rows.length };
  }, [costs]);

  /* ------------------------------ selection ------------------------------ */

  const selectable = useMemo(
    () => new Set((costs ?? []).filter((row) => rechargeBlocker(row) === null).map((row) => row.id)),
    [costs],
  );

  const chosen = useMemo(
    () => (costs ?? []).filter((row) => selected.includes(row.id)),
    [costs, selected],
  );

  /** One invoice bills one client: `orders.customer_id` is a single party. */
  const spansClients = useMemo(
    () => new Set(chosen.map((row) => row.partyId)).size > 1,
    [chosen],
  );

  const chosenTotal = useMemo(
    () => chosen.reduce((sum, row) => sum + row.amountRial, 0),
    [chosen],
  );

  const toggle = (id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((each) => each !== id) : [...current, id],
    );
  };

  /* -------------------------------- acts --------------------------------- */

  const openRecord = () => {
    setDraft(EMPTY_DRAFT);
    setRecordError(null);
    setRecordOpen(true);
  };

  const submitRecord = async () => {
    if (!draft.partyId || !draft.description.trim() || !draft.spentOn) {
      setRecordError("کارفرما، شرح و تاریخ پرداخت لازم است.");
      return;
    }
    const amount = Number(toLatinDigits(draft.amountRial));
    if (!Number.isFinite(amount) || amount <= 0) {
      setRecordError("مبلغ باید عددی بزرگ‌تر از صفر باشد.");
      return;
    }
    setSaving(true);
    setRecordError(null);
    try {
      const result = await api<{ cost?: CostWire; error?: string }>("/api/agency/reimbursable-costs", {
        method: "POST",
        body: JSON.stringify({
          partyId: draft.partyId,
          // Absent, not empty: an empty string would be a value the service has to
          // reject, while absence is how the form says «follow the policy».
          ...(draft.projectId ? { projectId: draft.projectId } : {}),
          ...(draft.vendorName.trim() ? { vendorName: draft.vendorName.trim() } : {}),
          ...(draft.vendorPartyId ? { vendorPartyId: draft.vendorPartyId } : {}),
          description: draft.description.trim(),
          amountRial: money.fromInput(amount),
          spentOn: draft.spentOn,
          settledBy: draft.settledBy,
          ...(draft.presentation ? { presentation: draft.presentation } : {}),
          ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
        }),
      });
      if (!result.ok || result.data.error) {
        setRecordError(errorMessage(result.data.error ?? "save_failed"));
        return;
      }
      setRecordOpen(false);
      setSelected([]);
      setReloadKey((key) => key + 1);
    } catch (err) {
      setRecordError(errorMessage(err instanceof Error ? err.message : undefined));
    } finally {
      setSaving(false);
    }
  };

  const openPolicy = () => {
    setPolicyChoice(policy?.policy.presentation ?? "");
    setPolicyOpen(true);
  };

  const submitPolicy = async () => {
    if (!policyChoice) return;
    setPolicySaving(true);
    try {
      const result = await api<{ policy?: PolicyWire["policy"]; error?: string }>(
        "/api/agency/reimbursable-costs/policy",
        { method: "PUT", body: JSON.stringify({ presentation: policyChoice }) },
      );
      if (!result.ok || result.data.error) {
        setPolicyError(errorMessage(result.data.error ?? "save_failed"));
        return;
      }
      setPolicyOpen(false);
      await loadPolicy();
      // The rows recorded before this choice keep the treatment they were given.
      setReloadKey((key) => key + 1);
    } catch (err) {
      setPolicyError(errorMessage(err instanceof Error ? err.message : undefined));
    } finally {
      setPolicySaving(false);
    }
  };

  const submitRecharge = async () => {
    if (chosen.length === 0 || spansClients) return;
    setRecharging(true);
    setRecharged(null);
    try {
      const result = await api<{ recharge?: RechargeWire; error?: string }>(
        "/api/agency/reimbursable-costs/recharge",
        { method: "POST", body: JSON.stringify({ costIds: chosen.map((row) => row.id) }) },
      );
      if (!result.ok || result.data.error) {
        setLoadError(errorMessage(result.data.error ?? "recharge_failed"));
        return;
      }
      setRecharged(result.data.recharge ?? null);
      setSelected([]);
      setReloadKey((key) => key + 1);
    } catch (err) {
      setLoadError(errorMessage(err instanceof Error ? err.message : undefined));
    } finally {
      setRecharging(false);
    }
  };

  /* ------------------------------- rendering ------------------------------ */

  const policyLabel = (value: string): string =>
    policy?.options.find((option) => option.value === value)?.label ?? value;

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  if (costs === null && loadError === null) return <SectionCardSkeleton />;

  return (
    <div className="space-y-4">
      {loadError ? <ErrorBox>{loadError}</ErrorBox> : null}
      {policyError ? <ErrorBox>{policyError}</ErrorBox> : null}

      {recharged ? (
        <InfoBox>
          فاکتور بازدریافت شمارهٔ {toPersianDigits(String(recharged.orderNumber))} برای{" "}
          {toPersianDigits(money.format(recharged.totalRial, { withUnit: true }))} صادر شد و هزینه‌های
          انتخاب‌شده به آن پیوستند.
        </InfoBox>
      ) : null}

      {/* Act three first: the choice governs what recording a cost means, so it is
          read before the rows rather than found after them. */}
      <SectionCard
        title="سیاست ارائهٔ درآمد"
        description="ناخالص یا خالص — انتخاب کسب‌وکار، نه نتیجهٔ اندازهٔ یک ردیف."
        actions={
          canSetPolicy ? <SecondaryButton onClick={openPolicy}>تغییر سیاست</SecondaryButton> : undefined
        }
      >
        {policy === null ? (
          <LoadingSkeleton rows={1} compact label="در حال خواندن سیاست ارائهٔ درآمد" />
        ) : policy.policy.stored ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="positive" dot>
                {policyLabel(policy.policy.presentation)}
              </StatusBadge>
              <span className="text-xs text-muted-foreground">
                انتخاب‌شده
                {policy.policy.updatedAt ? ` در ${formatJalali(policy.policy.updatedAt)}` : ""}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {policy.options.find((option) => option.value === policy.policy.presentation)?.hint}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <StatusBadge tone="active" dot>
              هنوز انتخاب نشده
            </StatusBadge>
            <p className="text-sm text-muted-foreground">
              تا وقتی این کسب‌وکار سیاستی انتخاب نکند، هزینه‌های تازه با رفتار پیش‌فرض ثبت می‌شوند:{" "}
              {policyLabel(policy.fallback)}. این یک تصمیم نیست — یک جای‌خالی است.
            </p>
          </div>
        )}
        <InfoBox>
          تغییر سیاست به گذشته نمی‌رسد: هزینه‌ای که سندش در دفتر نشسته، همان رفتار را نگه می‌دارد و
          سیاست تازه فقط بر هزینه‌های بعد از آن اثر می‌گذارد. اصلاح یک هزینهٔ ثبت‌شده، برگشت و ثبت
          دوباره است.
        </InfoBox>
      </SectionCard>

      <SectionCard
        title="هزینه‌های کارفرما"
        description={
          totals.count > 0
            ? `${toPersianDigits(String(totals.count))} ردیف — پرداختی ${toPersianDigits(
                money.format(totals.spent, { withUnit: true }),
              )}، بازدریافت‌شده ${toPersianDigits(
                money.format(totals.back, { withUnit: true }),
              )}، باقی‌مانده ${toPersianDigits(money.format(totals.outstanding, { withUnit: true }))}`
            : "پولی که آژانس از طرف کارفرما پرداخته و باید بازپس بگیرد."
        }
        actions={
          canRecord ? <PrimaryButton onClick={openRecord}>ثبت هزینه</PrimaryButton> : undefined
        }
        flush
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="جستجو در شرح، کارفرما یا فروشنده…"
            aria-label="جستجوی هزینه‌ها"
            className={`${inputClass} max-w-xs`}
          />
          <Field label="وضعیت ثبت" as="div">
            <select
              value={postedFilter}
              onChange={(event) => setPostedFilter(event.target.value as typeof postedFilter)}
              aria-label="وضعیت ثبت در دفتر"
              className={inputClass}
            >
              <option value="all">همه</option>
              <option value="posted">ثبت‌شده در دفتر</option>
              <option value="pending">در انتظار ثبت</option>
            </select>
          </Field>
        </div>

        {costs !== null && costs.length === 0 ? (
          <EmptyState title="هزینه‌ای ثبت نشده">
            نخستین هزینهٔ بازدریافتی را ثبت کنید تا هم در دفتر بنشیند و هم قابل بازدریافت از
            کارفرما شود.
          </EmptyState>
        ) : (
          <DataTable caption="فهرست هزینه‌های بازدریافتی از کارفرما" frame={false}>
            {/* `DataTableHead` renders the `<tr>` itself — it takes `<th>` children. */}
            <DataTableHead>
              {canRecharge ? (
                <th scope="col">
                  <span className="sr-only">انتخاب</span>
                </th>
              ) : null}
              <th scope="col">شماره</th>
              <th scope="col">کارفرما</th>
              <th scope="col">پروژه</th>
              <th scope="col">شرح</th>
              <th scope="col">مبلغ</th>
              <th scope="col">تاریخ</th>
              <th scope="col">نحوهٔ پرداخت</th>
              <th scope="col">وضعیت پرداخت به فروشنده</th>
              <th scope="col">حساب بدهکار</th>
              <th scope="col">بازدریافت</th>
            </DataTableHead>
            <DataTableBody>
              {(costs ?? []).map((row) => {
                const blocker = rechargeBlocker(row);
                return (
                  <tr key={row.id}>
                    {canRecharge ? (
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.includes(row.id)}
                          disabled={blocker !== null || !selectable.has(row.id)}
                          onChange={() => toggle(row.id)}
                          aria-label={`انتخاب ${row.costNumber} برای بازدریافت`}
                        />
                      </td>
                    ) : null}
                    <td className="whitespace-nowrap text-xs">{toPersianDigits(row.costNumber)}</td>
                    <td>{row.clientName}</td>
                    <td>{row.projectName ?? "—"}</td>
                    <td>
                      <div className="min-w-0">
                        <div className="truncate">{row.description}</div>
                        {row.vendorName ? (
                          <div className="truncate text-xs text-muted-foreground">{row.vendorName}{row.vendorPartyId ? " — پیوند به شخص" : " — نام متنی"}</div>
                        ) : null}
                      </div>
                    </td>
                    <td className="whitespace-nowrap">
                      {toPersianDigits(money.format(row.amountRial, { withUnit: true }))}
                    </td>
                    <td className="whitespace-nowrap text-xs">{formatJalali(row.spentOn)}</td>
                    <td className="text-xs">{AGENCY_COST_SETTLEMENT_LABELS[row.settledBy]}</td>
                    <td className="text-xs">
                      <StatusBadge tone={row.settledBy !== "payable" || row.settled ? "positive" : "neutral"}>
                        {row.settledBy !== "payable" ? "پرداخت هنگام ثبت هزینه" : row.settled ? "تسویه‌شده با فروشنده" : "پرداختنی به فروشنده"}
                      </StatusBadge>
                      {row.settlementNumber ? <div className="mt-1 text-muted-foreground">{toPersianDigits(row.settlementNumber)}</div> : null}
                    </td>
                    <td className="whitespace-nowrap">
                      <StatusBadge tone={row.passThrough ? "active" : "neutral"}>
                        {toPersianDigits(row.accounts.debitCode)}
                      </StatusBadge>
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      {blocker ? (
                        <StatusBadge tone={row.recharged ? "positive" : "neutral"}>{blocker}</StatusBadge>
                      ) : (
                        <StatusBadge tone="active">آمادهٔ بازدریافت</StatusBadge>
                      )}
                      {!row.posted ? (
                        <div className="mt-1 text-muted-foreground">سند: در انتظار</div>
                      ) : null}
                      {row.recharged && row.rechargedByName ? (
                        <div className="mt-1 text-muted-foreground">توسط {row.rechargedByName}</div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>

      {/* The recharge bar: the second act, and the place the three refusals are
          shown rather than discovered. */}
      {canRecharge && selected.length > 0 ? (
        <SectionCard title="بازدریافت از کارفرما">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm">
              {toPersianDigits(String(chosen.length))} هزینه —{" "}
              {toPersianDigits(money.format(chosenTotal, { withUnit: true }))}
              {chosen.length > 0 ? ` برای ${chosen[0].clientName}` : ""}
            </span>
            {spansClients ? (
              <span className="text-sm text-destructive">
                هزینه‌ها از دو کارفرما انتخاب شده‌اند؛ یک فاکتور فقط یک کارفرما را صورتحساب می‌کند.
              </span>
            ) : null}
            <PrimaryButton onClick={submitRecharge} disabled={recharging || spansClients}>
              {recharging ? "در حال صدور…" : "صدور فاکتور بازدریافت"}
            </PrimaryButton>
            <SecondaryButton onClick={() => setSelected([])}>پاک‌کردن انتخاب</SecondaryButton>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            یک فاکتور با یک ردیف به ازای هر هزینه صادر می‌شود و هر ردیف حساب ۱۲۷۰ را بستانکار
            می‌کند، نه یک حساب درآمد — تا بازدریافت، درآمد آژانس شمرده نشود.
          </p>
        </SectionCard>
      ) : null}

      {canSettle ? <VendorPaymentControls costs={costs ?? []} onChanged={() => setReloadKey(key => key + 1)} /> : null}

      {/* Act one: record a cost. */}
      <Sheet open={recordOpen} onOpenChange={setRecordOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>ثبت هزینهٔ کارفرما</SheetTitle>
          </SheetHeader>

          <div className="space-y-4 px-4 pb-4">
            {recordError ? <ErrorBox>{recordError}</ErrorBox> : null}

            <Field label="کارفرما" hint="هزینه به نام کدام مشتری است؛ یک فاکتور بازدریافت فقط یک کارفرما دارد.">
              <CustomerSearchField
                selectedId={draft.partyId}
                selectedName={draft.clientName}
                onPick={(match) => set({ partyId: match.id, clientName: match.name })}
                onClear={() => set({ partyId: null, clientName: "" })}
                emptyText="مشتری‌ای با این نام پیدا نشد."
              />
            </Field>

            <Field
              label="پروژه"
              as="div"
              hint={
                projects.length === 0
                  ? "پروژه‌ای در دسترس نیست — بدون پروژه، این هزینه در سود و زیان هیچ پروژه‌ای دیده نمی‌شود."
                  : "بدون پروژه، این هزینه در سود و زیان پروژه‌ها ظاهر نمی‌شود."
              }
            >
              <select
                value={draft.projectId}
                onChange={(event) => set({ projectId: event.target.value })}
                aria-label="پروژه"
                className={inputClass}
              >
                <option value="">بدون پروژه</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="شرح" hint="چه چیزی پرداخت شد — همان متنی که روی فاکتور بازدریافت می‌نشیند.">
              <input
                value={draft.description}
                onChange={(event) => set({ description: event.target.value })}
                className={inputClass}
                placeholder="مثلاً خرید فضای تبلیغاتی آبان"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="مبلغ">
                <PersianNumberInput
                  value={draft.amountRial}
                  onChange={(event) => set({ amountRial: event.target.value })}
                  placeholder="۰"
                  aria-label="مبلغ به ریال"
                />
              </Field>
              <Field label="تاریخ پرداخت">
                <input
                  type="date"
                  value={draft.spentOn}
                  onChange={(event) => set({ spentOn: event.target.value })}
                  className={inputClass}
                  aria-label="تاریخ پرداخت"
                />
              </Field>
            </div>

            {canChooseVendor ? <Field label="پیوند به تأمین‌کنندهٔ ثبت‌شده" as="div" hint="اختیاری؛ هویت از دفتر اشخاص انتخاب می‌شود، نه از تشابه نام.">
              <SupplierPartyPicker value={draft.vendorPartyId} name={draft.vendorName}
                onPick={(id, name) => set({ vendorPartyId: id, vendorName: name })} />
            </Field> : null}
            <Field label="فروشنده / تأمین‌کننده" as="div" hint="اختیاری — کسی که پول به او پرداخت شد.">
              <input
                value={draft.vendorName}
                disabled={Boolean(draft.vendorPartyId)}
                onChange={(event) => set({ vendorName: event.target.value })}
                className={inputClass}
                placeholder="مثلاً رسانهٔ آفتاب"
              />
            </Field>

            <Field label="نحوهٔ پرداخت" as="div" hint="حساب بستانکار سند را همین انتخاب تعیین می‌کند.">
              <select
                value={draft.settledBy}
                onChange={(event) => set({ settledBy: event.target.value as AgencyCostSettlement })}
                aria-label="نحوهٔ پرداخت"
                className={inputClass}
              >
                {AGENCY_COST_SETTLEMENTS.map((value) => (
                  <option key={value} value={value}>
                    {AGENCY_COST_SETTLEMENT_LABELS[value]}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="ارائهٔ درآمد"
              as="div"
              hint="پیش‌فرض، سیاست همین کسب‌وکار است. انتخاب صریح یعنی این ردیف از سیاست پیروی نکند."
            >
              <select
                value={draft.presentation}
                onChange={(event) => set({ presentation: event.target.value as Draft["presentation"] })}
                aria-label="ارائهٔ درآمد"
                className={inputClass}
              >
                <option value="">
                  {policy ? `پیروی از سیاست کسب‌وکار (${policyLabel(policy.policy.presentation)})` : "پیروی از سیاست کسب‌وکار"}
                </option>
                {(policy?.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>

            {draft.presentation ? (
              <InfoBox>{policy?.options.find((option) => option.value === draft.presentation)?.hint}</InfoBox>
            ) : null}

            <Field label="یادداشت" as="div" hint="اختیاری — برای خود آژانس، نه روی فاکتور.">
              <textarea
                value={draft.note}
                onChange={(event) => set({ note: event.target.value })}
                className={inputClass}
                rows={3}
              />
            </Field>
          </div>

          <SheetFooter>
            <SecondaryButton onClick={() => setRecordOpen(false)}>انصراف</SecondaryButton>
            <PrimaryButton onClick={submitRecord} disabled={saving}>
              {saving ? "در حال ثبت…" : "ثبت و صدور سند"}
            </PrimaryButton>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Act three: choose the policy, in the API's own words. */}
      <Sheet open={policyOpen} onOpenChange={setPolicyOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>سیاست ارائهٔ درآمد</SheetTitle>
          </SheetHeader>

          <div className="space-y-4 px-4 pb-4">
            <p className="text-sm text-muted-foreground">
              این انتخاب تعیین می‌کند هزینه‌های بازدریافتی از کارفرما در کدام حساب بنشینند. از اندازهٔ
              مبلغ یا نام فروشنده نتیجه‌گیری نمی‌شود — فقط آنچه کسب‌وکار انتخاب می‌کند.
            </p>
            <div role="radiogroup" aria-label="ارائهٔ درآمد" className="space-y-2">
              {(policy?.options ?? []).map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3"
                >
                  <input
                    type="radio"
                    name="presentation"
                    value={option.value}
                    checked={policyChoice === option.value}
                    onChange={() => setPolicyChoice(option.value)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{option.label}</span>
                    <span className="block text-xs text-muted-foreground">{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <InfoBox>
              پس از ذخیره، فقط هزینه‌هایی که از این لحظه ثبت می‌شوند این رفتار را می‌گیرند.
            </InfoBox>
          </div>

          <SheetFooter>
            <SecondaryButton onClick={() => setPolicyOpen(false)}>انصراف</SecondaryButton>
            <PrimaryButton onClick={submitPolicy} disabled={policySaving || !policyChoice}>
              {policySaving ? "در حال ذخیره…" : "ذخیرهٔ سیاست"}
            </PrimaryButton>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
