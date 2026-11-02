"use client";

/**
 * CRM → پیشنهاد قیمت — the priced offer (issue #1128 §A + §D).
 *
 * ## Reading this screen
 *
 * §A calls this a proposal or quote and §D calls it an estimate; §B's stage list
 * puts both between «بریف کارفرما» and «قرارداد», so it is one screen. What it
 * answers is the only question an agency asks before it sends anything: **what
 * does this offer earn us?** The margin column is therefore not an analytics
 * afterthought, it is the reason the screen exists — and it is internal, which is
 * why the payload a client would ever see is a different shape entirely
 * (`agencyProposalClientView`, whose type cannot name a cost).
 *
 * ## A sent offer is closed, and the button says what to do instead
 *
 * The freeze starts at `sent`, a step earlier than a brief's, because a proposal
 * states a *price*: a client who reads one figure and returns to find another has
 * been given a reason to distrust every later figure. So on a frozen row «ویرایش»
 * becomes «نمایش» and the way forward is «پیشنهاد تازه از روی این» — a new number
 * in the series, pre-filled from this one. That is not a workaround for a missing
 * edit button; it is the correction the freeze exists to force, and it leaves the
 * offer the client actually saw on the record.
 *
 * ## The totals in the editor are the totals that will be stored
 *
 * Both are computed by `agency-proposal.ts`, the same pure module the service
 * calls, so the figure under the member's cursor and the figure in the row are
 * the same arithmetic and cannot drift. A discount larger than the offer is
 * refused here *and* by the service: the screen says so before the round trip,
 * and the service says so because a screen is not a boundary.
 *
 * ## Permissions are computed by `crm-section.tsx`, never here
 *
 * `canManage` and `canDelete` arrive as props from the same table the API guards
 * with, so a control is never drawn on a permission its own endpoint refuses. The
 * acts are likewise read off each row's own `actions`, which the service derives
 * from the status by the same function that decides what is allowed.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { CopyIcon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
import {
  AGENCY_PROPOSAL_ACTION_LABELS,
  AGENCY_PROPOSAL_REVENUE_ACCOUNTS,
  AGENCY_PROPOSAL_STATUS_LABELS,
  AGENCY_PROPOSAL_STATUS_TONES,
  AGENCY_PROPOSAL_STATUSES,
  agencyProposalDiscountAllowed,
  agencyProposalLineAmountRial,
  agencyProposalMargin,
  defaultAgencyProposalRevenueCode,
  isAgencyProposalStatus,
  normalizeAgencyProposalQuantity,
  type AgencyProposalAction,
  type AgencyProposalLine,
  type AgencyProposalMargin,
  type AgencyProposalStatus,
  type AgencyProposalTotals,
} from "@/lib/agency-proposal";
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
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead } from "@/app/dashboard/data-table";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { CustomerSearchField } from "./customer-search";

/* ------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* ------------------------------------------------------------------------- */

/**
 * The header is declared here rather than imported: the service module imports
 * `pg`, and a client component that reached through it would drag the driver into
 * the browser bundle. The line, totals and margin types *are* imported, because
 * `agency-proposal.ts` is pure — and importing them is what makes the screen's
 * arithmetic provably the service's arithmetic rather than a copy of it.
 */
interface ProposalWire {
  id: string;
  proposalNumber: string;
  partyId: string;
  partyName: string;
  briefId: string | null;
  briefNumber: string | null;
  briefTitle: string | null;
  dealId: string | null;
  dealTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  contractId: string | null;
  contractTitle: string | null;
  title: string;
  status: AgencyProposalStatus;
  scopeOfWork: string;
  terms: string;
  discountRial: number;
  taxRial: number;
  validUntil: string | null;
  clientContactPartyId: string | null;
  clientContactName: string;
  sentAt: string | null;
  decidedAt: string | null;
  decidedByName: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  lines: AgencyProposalLine[];
  totals: AgencyProposalTotals;
  margin: AgencyProposalMargin;
  lapsed: boolean;
  actions: AgencyProposalAction[];
  frozen: boolean;
  editable: boolean;
}

/** A brief this offer may price, from the chosen client's own briefs. */
interface BriefOption {
  id: string;
  briefNumber: string;
  title: string;
}

interface ContactOption {
  id: string;
  name: string;
  kind: string;
  roleTitle: string | null;
}

/* ------------------------------------------------------------------------- */
/* The editor's own draft state                                               */
/* ------------------------------------------------------------------------- */

/**
 * One line as the form holds it: every figure is a *string* in the business's own
 * money unit, because that is what an input can hold while it is being typed. The
 * conversion to rial happens once, in `bodyFrom`, so a toman tenant never sees a
 * rial figure and never sends one.
 */
interface LineDraft {
  description: string;
  quantity: string;
  unitPrice: string;
  revenueCode: string;
  cost: string;
  passThrough: boolean;
  note: string;
}

interface ProposalDraft {
  partyId: string | null;
  partyName: string;
  briefId: string | null;
  title: string;
  scopeOfWork: string;
  terms: string;
  discount: string;
  tax: string;
  validUntil: string;
  clientContactPartyId: string | null;
  clientContactName: string;
  /**
   * Carried through rather than picked. There is no endpoint a CRM-only member may
   * read a project or a contract list from — `/api/workspace/lookups` answers only
   * a `workspace.manage` holder — so offering a picker here would draw a control
   * that is always empty. Carrying the pointer is what keeps a PATCH from clearing
   * one another path wrote, which is the brief screen's arrangement too.
   */
  projectId: string | null;
  contractId: string | null;
  lines: LineDraft[];
}

function emptyLine(): LineDraft {
  return {
    description: "",
    quantity: "1",
    unitPrice: "",
    revenueCode: defaultAgencyProposalRevenueCode(),
    cost: "",
    passThrough: false,
    note: "",
  };
}

function emptyDraft(): ProposalDraft {
  return {
    partyId: null,
    partyName: "",
    briefId: null,
    title: "",
    scopeOfWork: "",
    terms: "",
    discount: "",
    tax: "",
    validUntil: "",
    clientContactPartyId: null,
    clientContactName: "",
    projectId: null,
    contractId: null,
    lines: [emptyLine()],
  };
}

function draftFrom(proposal: ProposalWire, money: ReturnType<typeof useMoney>): ProposalDraft {
  return {
    partyId: proposal.partyId,
    partyName: proposal.partyName,
    briefId: proposal.briefId,
    title: proposal.title,
    scopeOfWork: proposal.scopeOfWork,
    terms: proposal.terms,
    discount: proposal.discountRial === 0 ? "" : String(money.toInput(proposal.discountRial)),
    tax: proposal.taxRial === 0 ? "" : String(money.toInput(proposal.taxRial)),
    validUntil: proposal.validUntil ?? "",
    clientContactPartyId: proposal.clientContactPartyId,
    clientContactName: proposal.clientContactName,
    projectId: proposal.projectId,
    contractId: proposal.contractId,
    lines: proposal.lines.map((line) => ({
      description: line.description,
      quantity: String(line.quantity),
      unitPrice: line.unitPriceRial === 0 ? "" : String(money.toInput(line.unitPriceRial)),
      revenueCode: line.revenueCode,
      cost: line.costRial === null ? "" : String(money.toInput(line.costRial)),
      passThrough: line.passThrough,
      note: line.note,
    })),
  };
}

/** Digits only, in Latin, for a whole-money field. */
function digitsOf(value: string): string {
  return toLatinDigits(value).replace(/[^\d]/g, "");
}

/**
 * Digits and a decimal separator, for a quantity.
 *
 * Not `digitsOf`: agency work is sold in halves and thirds, and stripping the
 * separator would turn «۱٫۵» into ۱۵ — a tenfold overcharge that looks exactly
 * like what was typed.
 */
function decimalOf(value: string): string {
  return toLatinDigits(value).replace(/[^\d.]/g, "");
}

/** A money field's rial figure, where empty is zero rather than absent. */
function rialOf(value: string, money: ReturnType<typeof useMoney>): number {
  const digits = digitsOf(value);
  return digits === "" ? 0 : money.fromInput(Number(digits));
}

/**
 * The figures under the member's cursor, from the same pure module the service
 * calls.
 *
 * Lines that cannot be parsed contribute zero rather than being dropped: a
 * half-typed quantity must not make the total jump to a plausible-looking smaller
 * number, which is the failure a live total is most capable of.
 */
function previewOf(draft: ProposalDraft, money: ReturnType<typeof useMoney>): AgencyProposalMargin {
  const rows = draft.lines.map((line) => ({
    amountRial: agencyProposalLineAmountRial(
      normalizeAgencyProposalQuantity(decimalOf(line.quantity)) ?? 0,
      rialOf(line.unitPrice, money),
    ),
    // A cost of zero and a cost not stated are different facts, and the second is
    // what makes a margin a guess — so an empty field stays `null`.
    costRial: digitsOf(line.cost) === "" ? null : rialOf(line.cost, money),
    passThrough: line.passThrough,
  }));
  return agencyProposalMargin(rows, rialOf(draft.discount, money), rialOf(draft.tax, money));
}

/**
 * The body a save sends.
 *
 * A field the draft cannot express is left *out* rather than sent as an empty
 * string, because the service reads absence as "leave it alone" and an empty
 * string as a decision — sending both for every field would clear whatever the
 * form does not show.
 */
function bodyFrom(
  draft: ProposalDraft,
  frozen: boolean,
  money: ReturnType<typeof useMoney>,
): Record<string, unknown> {
  if (frozen) {
    // A sent offer accepts only the pointers that record where the work went, and
    // the contract it became — the one commercial write that happens *after* the
    // decision. Everything the client read is refused by the service and by 0276.
    const body: Record<string, unknown> = {};
    if (draft.projectId) body.projectId = draft.projectId;
    if (draft.contractId) body.contractId = draft.contractId;
    return body;
  }
  return {
    partyId: draft.partyId,
    title: draft.title.trim(),
    scopeOfWork: draft.scopeOfWork.trim(),
    terms: draft.terms.trim(),
    briefId: draft.briefId,
    clientContactPartyId: draft.clientContactPartyId,
    clientContactName: draft.clientContactName.trim(),
    validUntil: draft.validUntil || null,
    discountRial: rialOf(draft.discount, money),
    taxRial: rialOf(draft.tax, money),
    lines: draft.lines.map((line) => ({
      description: line.description.trim(),
      quantity: normalizeAgencyProposalQuantity(decimalOf(line.quantity)) ?? 1,
      unitPriceRial: rialOf(line.unitPrice, money),
      revenueCode: line.revenueCode,
      costRial: digitsOf(line.cost) === "" ? null : rialOf(line.cost, money),
      passThrough: line.passThrough,
      note: line.note.trim(),
    })),
    ...(draft.projectId ? { projectId: draft.projectId } : {}),
    ...(draft.contractId ? { contractId: draft.contractId } : {}),
  };
}

/**
 * The app's own date formatter, never the browser's.
 *
 * Reaching for a built-in locale formatter would render a Gregorian date in a
 * Persian product — silently, and only for some locales — which is exactly what
 * `crm-rtl.test.ts` exists to refuse. An offer's dates arrive as ISO from Postgres
 * and are displayed on the Shamsi calendar like every other date in the app.
 *
 * Money is not formatted here at all: `useMoney()` owns the business's unit, so a
 * tenant that works in toman is never shown a rial figure, and the column keeps
 * storing rial exactly as §D's registers do.
 */
function formatDate(value: string | null): string {
  return value ? formatJalali(value) : "—";
}

/* ------------------------------------------------------------------------- */
/* The screen                                                                 */
/* ------------------------------------------------------------------------- */

export function ProposalsSection({
  canManage,
  canDelete,
}: {
  canManage: boolean;
  canDelete: boolean;
}) {
  const money = useMoney();
  const [proposals, setProposals] = useState<ProposalWire[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("open");
  const [search, setSearch] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const [editing, setEditing] = useState<{ proposal: ProposalWire | null } | null>(null);
  const [draft, setDraft] = useState<ProposalDraft>(emptyDraft);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [acting, setActing] = useState<{
    proposal: ProposalWire;
    action: AgencyProposalAction;
  } | null>(null);
  const [deciderName, setDeciderName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actingBusy, setActingBusy] = useState(false);

  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [briefs, setBriefs] = useState<BriefOption[]>([]);

  const params = useMemo(() => {
    const query = new URLSearchParams();
    if (statusFilter === "open") query.set("openOnly", "1");
    // A lapsed offer is a live one whose clock has run out, which is a fact about
    // a date rather than a status anybody maintains — so this filter finds the
    // quotes that quietly stopped being offers, which «منقضی‌شده» would miss.
    else if (statusFilter === "lapsed") query.set("lapsedOnly", "1");
    else if (statusFilter !== "all" && isAgencyProposalStatus(statusFilter)) {
      query.set("status", statusFilter);
    }
    const trimmed = search.trim();
    if (trimmed) query.set("q", trimmed);
    return query.toString();
  }, [statusFilter, search]);

  const load = useCallback(async () => {
    setLoadError(null);
    const { ok, data, aborted } = await api<{ proposals?: ProposalWire[]; error?: string }>(
      `/api/crm/proposals${params ? `?${params}` : ""}`,
    );
    if (aborted) return;
    if (!ok) {
      setLoadError(errorMessage(data.error) ?? "بارگذاری پیشنهادها ناموفق بود");
      setProposals(null);
      return;
    }
    setProposals(data.proposals ?? []);
  }, [params]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const editorPartyId = editing?.proposal === null ? draft.partyId : (draft.partyId ?? null);

  // The stakeholder picker is the chosen client's own contacts — both directions
  // of the relationship, which is exactly what migration 0276's trigger accepts.
  useEffect(() => {
    if (!editing || !editorPartyId) {
      setContacts([]);
      return;
    }
    let cancelled = false;
    void api<{ relationships?: Array<Record<string, unknown>> }>(
      `/api/crm/customers/${editorPartyId}/relationships`,
    ).then(({ ok, data }) => {
      if (cancelled) return;
      if (!ok) {
        setContacts([]);
        return;
      }
      const rows = (data.relationships ?? []).map((row) => {
        const inverse = row.inverse === true;
        return {
          id: String(inverse ? row.fromPartyId : row.toPartyId),
          name: String(inverse ? row.fromName : row.toName),
          kind: String(row.kind ?? ""),
          roleTitle: typeof row.roleTitle === "string" ? row.roleTitle : null,
        };
      });
      // Never offer the client as its own approver.
      setContacts(rows.filter((row) => row.id !== editorPartyId));
    });
    return () => {
      cancelled = true;
    };
  }, [editing, editorPartyId]);

  // The briefs this offer may price are the chosen client's own, which is the
  // shape of §A's rule rather than a warning about it: another client's brief is
  // not among the options, and 0276 refuses the write anyway.
  useEffect(() => {
    if (!editing || !editorPartyId) {
      setBriefs([]);
      return;
    }
    let cancelled = false;
    void api<{ briefs?: Array<{ id: string; briefNumber: string; title: string }> }>(
      `/api/crm/briefs?partyId=${encodeURIComponent(editorPartyId)}`,
    ).then(({ ok, data }) => {
      if (cancelled) return;
      setBriefs(ok ? (data.briefs ?? []) : []);
    });
    return () => {
      cancelled = true;
    };
  }, [editing, editorPartyId]);

  function openNew() {
    setSaveError(null);
    setDraft(emptyDraft());
    setEditing({ proposal: null });
  }

  function openView(proposal: ProposalWire) {
    setSaveError(null);
    setDraft(draftFrom(proposal, money));
    setEditing({ proposal });
  }

  /**
   * The correction the freeze makes necessary, as a button.
   *
   * A sent offer cannot be edited, and the answer is not "you cannot" but "here is
   * the next number in the series, already carrying what you wrote". The declined
   * offer stays on the record as the offer that was actually refused, which is the
   * only evidence of what the client said no to.
   */
  function copyAsNew(proposal: ProposalWire) {
    setSaveError(null);
    const copied = draftFrom(proposal, money);
    // Not the pointers: a new offer is a new negotiation, and silently inheriting
    // this one's contract would attach a fresh price to a signed agreement.
    copied.contractId = null;
    copied.projectId = null;
    setDraft(copied);
    setEditing({ proposal: null });
  }

  async function save() {
    if (!editing) return;
    setSaving(true);
    setSaveError(null);
    const frozen = editing.proposal?.frozen ?? false;
    const body = bodyFrom(draft, frozen, money);
    const { ok, data } = await api<{ proposal?: ProposalWire; error?: string }>(
      editing.proposal ? `/api/crm/proposals/${editing.proposal.id}` : "/api/crm/proposals",
      {
        method: editing.proposal ? "PATCH" : "POST",
        body: JSON.stringify(body),
      },
    );
    setSaving(false);
    if (!ok || !data.proposal) {
      setSaveError(errorMessage(data.error) ?? "ذخیرهٔ پیشنهاد ناموفق بود");
      return;
    }
    setEditing(null);
    setReloadKey((key) => key + 1);
  }

  function openAction(proposal: ProposalWire, action: AgencyProposalAction) {
    setActionError(null);
    // A decision falls back to the stakeholder the offer already names, so the
    // field arrives pre-filled with the person the agency recorded as the client's
    // decision-maker rather than empty.
    setDeciderName(
      action === "accept" || action === "decline" ? proposal.clientContactName : "",
    );
    setActing({ proposal, action });
  }

  async function runAction() {
    if (!acting) return;
    setActingBusy(true);
    setActionError(null);
    const needsName = acting.action === "accept" || acting.action === "decline";
    const { ok, data } = await api<{ proposal?: ProposalWire; error?: string }>(
      `/api/crm/proposals/${acting.proposal.id}/status`,
      {
        method: "POST",
        body: JSON.stringify({
          action: acting.action,
          ...(needsName ? { decidedByName: deciderName.trim() } : {}),
        }),
      },
    );
    setActingBusy(false);
    if (!ok) {
      setActionError(errorMessage(data.error) ?? "این تغییر وضعیت ناموفق بود");
      return;
    }
    setActing(null);
    setReloadKey((key) => key + 1);
  }

  async function remove(proposal: ProposalWire) {
    setActionError(null);
    const { ok, data } = await api<{ error?: string }>(`/api/crm/proposals/${proposal.id}`, {
      method: "DELETE",
    });
    if (!ok) {
      setLoadError(errorMessage(data.error) ?? "حذف پیشنهاد ناموفق بود");
      return;
    }
    setReloadKey((key) => key + 1);
  }

  if (proposals === null && loadError === null) {
    return <SectionCardSkeleton />;
  }

  const frozen = editing?.proposal?.frozen ?? false;
  const preview = previewOf(draft, money);
  // A margin over a half-costed offer is a guess, and the count is what says so
  // instead of printing a confident figure.
  const previewPartial = preview.costedLineCount < preview.lineCount;
  // The raw figure, not `preview.discountRial`: the totals cap a discount at the
  // subtotal so the offer can never go negative, which is the right arithmetic and
  // the wrong warning — capped silently, a member who typed ۹٬۰۰۰٬۰۰۰ would see a
  // total of صفر and no reason for it. The service refuses the same write, so this
  // is the sentence that arrives before the round trip.
  const discountRefused =
    !frozen && !agencyProposalDiscountAllowed(preview.subtotalRial, rialOf(draft.discount, money));

  return (
    <div className="space-y-4">
      <SectionCard
        title="پیشنهادهای قیمت"
        description="چه چیزی، به چه قیمتی، تا چه اعتباری — و چقدر از آن سود می‌ماند."
        actions={
          <div className="flex items-center gap-2">
            <SecondaryButton onClick={() => setReloadKey((key) => key + 1)}>
              <RefreshCwIcon className="size-4" aria-hidden="true" />
              تازه‌سازی
            </SecondaryButton>
            {canManage ? (
              <PrimaryButton type="button" onClick={openNew}>
                <PlusIcon className="size-4" aria-hidden="true" />
                پیشنهاد تازه
              </PrimaryButton>
            ) : null}
          </div>
        }
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="جست‌وجو">
            <input
              className={inputClass}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="نام پیشنهاد، شماره یا نام کارفرما…"
              aria-label="جست‌وجوی پیشنهاد"
            />
          </Field>
          <Field label="وضعیت">
            <select
              className={inputClass}
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              aria-label="فیلتر وضعیت پیشنهاد"
            >
              <option value="open">باز (پیش‌نویس و ارسال‌شده)</option>
              <option value="lapsed">اعتبارشان تمام شده</option>
              <option value="all">همه</option>
              {AGENCY_PROPOSAL_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {AGENCY_PROPOSAL_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {loadError ? <ErrorBox>{loadError}</ErrorBox> : null}

        {!loadError && proposals !== null && proposals.length === 0 ? (
          <EmptyState title="پیشنهادی نیست">
            {canManage
              ? "نخستین پیشنهاد قیمت را بنویسید: ردیف‌ها، تخفیف، مالیات و اعتبار زمانی. حاشیهٔ سود همان‌جا حساب می‌شود، پیش از آنکه چیزی برای کارفرما ارسال شود."
              : "پیشنهادی برای نمایش نیست."}
          </EmptyState>
        ) : null}

        {!loadError && proposals !== null && proposals.length > 0 ? (
          <DataTable caption="پیشنهادهای قیمت کارفرمایان">
            <DataTableHead>
              <th className="py-2 text-start font-medium">شماره</th>
              <th className="py-2 text-start font-medium">عنوان</th>
              <th className="py-2 text-start font-medium">کارفرما</th>
              <th className="py-2 text-start font-medium">وضعیت</th>
              <th className="py-2 text-start font-medium">مبلغ کل</th>
              <th className="py-2 text-start font-medium">حاشیهٔ سود</th>
              <th className="py-2 text-start font-medium">اعتبار تا</th>
              <th className="py-2 text-end font-medium">عملیات</th>
            </DataTableHead>
            <DataTableBody>
              {proposals.map((proposal) => {
                // A list row reports how much of its margin was actually costed, so
                // a figure built on one line of five is marked rather than trusted.
                const partial =
                  proposal.margin.costedLineCount < proposal.margin.lineCount;
                return (
                  <tr key={proposal.id} className="border-b last:border-0">
                    <td className="py-2 whitespace-nowrap">
                      {toPersianDigits(proposal.proposalNumber)}
                    </td>
                    <td className="py-2">
                      <div className="font-medium">{proposal.title}</div>
                      {proposal.briefNumber ? (
                        <div className="text-xs text-muted-foreground">
                          از بریف {toPersianDigits(proposal.briefNumber)}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2">{proposal.partyName || "—"}</td>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center gap-1">
                        <StatusBadge tone={AGENCY_PROPOSAL_STATUS_TONES[proposal.status]} dot>
                          {AGENCY_PROPOSAL_STATUS_LABELS[proposal.status]}
                        </StatusBadge>
                        {/* Lapsing is a fact about a date and is independent of the
                            status: an offer can be sent and lapsed at once, which
                            is exactly the case worth saying out loud. */}
                        {proposal.lapsed ? <StatusBadge tone="danger">بی‌اعتبار</StatusBadge> : null}
                      </div>
                    </td>
                    <td className="py-2 whitespace-nowrap">{money.format(proposal.totals.totalRial)}</td>
                    <td className="py-2 whitespace-nowrap">
                      {/* INTERNAL. This column is the reason the screen exists, and
                          it is the one figure that must never reach a client — the
                          payload a client sees is a different type that cannot name
                          a cost. */}
                      {money.format(proposal.margin.marginRial)}
                      {partial ? (
                        <span className="text-xs text-muted-foreground"> (ناقص)</span>
                      ) : null}
                    </td>
                    <td className="py-2 whitespace-nowrap">{formatDate(proposal.validUntil)}</td>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        {/* The acts are the offer's own, read off the row: the screen
                            never offers a button the route would refuse. */}
                        {canManage
                          ? proposal.actions.map((action) => (
                              <SecondaryButton
                                key={action}
                                type="button"
                                onClick={() => openAction(proposal, action)}
                              >
                                {AGENCY_PROPOSAL_ACTION_LABELS[action]}
                              </SecondaryButton>
                            ))
                          : null}
                        {canManage ? (
                          <SecondaryButton type="button" onClick={() => openView(proposal)}>
                            <PencilIcon className="size-4" aria-hidden="true" />
                            {proposal.frozen ? "نمایش" : "ویرایش"}
                          </SecondaryButton>
                        ) : null}
                        {canManage && proposal.frozen ? (
                          <SecondaryButton type="button" onClick={() => copyAsNew(proposal)}>
                            <CopyIcon className="size-4" aria-hidden="true" />
                            پیشنهاد تازه از روی این
                          </SecondaryButton>
                        ) : null}
                        {canDelete && proposal.status === "draft" ? (
                          <SecondaryButton type="button" onClick={() => void remove(proposal)}>
                            <Trash2Icon className="size-4" aria-hidden="true" />
                            حذف
                          </SecondaryButton>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </DataTableBody>
          </DataTable>
        ) : null}

        <InfoBox>
          پیشنهاد ارسال‌شده منجمد است، ردیف‌هایش هم: قیمت چیزی است که کارفرما
          می‌خواند و نباید زیر پایش عوض شود. اصلاح، پیشنهاد تازه‌ای در همان
          سری است. پذیرش یا رد، تصمیم کارفرماست و اینجا فقط ثبت می‌شود — پیشنهاد
          پذیرفته‌شده مطالبهٔ قطعی نیست و سند حسابداری نمی‌سازد؛ آن کار رجیسترهای
          صورتحساب است.
        </InfoBox>
      </SectionCard>

      <Sheet open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle>
              {editing?.proposal
                ? `${frozen ? "نمایش" : "ویرایش"} پیشنهاد ${toPersianDigits(editing.proposal.proposalNumber)}`
                : "پیشنهاد قیمت تازه"}
            </SheetTitle>
          </SheetHeader>

          <div className="space-y-4 px-4 pb-4">
            {saveError ? <ErrorBox>{saveError}</ErrorBox> : null}

            {discountRefused ? (
              <ErrorBox>
                تخفیف از جمع ردیف‌ها بیشتر است؛ مبلغ کل منفی می‌شود. تخفیف برابر با
                جمع ردیف‌ها مجاز است — پیشنهاد رایگان چیز دیگری است و اشتباه نیست.
              </ErrorBox>
            ) : null}

            {frozen ? (
              <InfoBox>
                این پیشنهاد ارسال شده و منجمد است؛ آنچه کارفرما خوانده تغییر
                نمی‌کند. برای تغییر قیمت، از «پیشنهاد تازه از روی این» یک شمارهٔ
                تازه در همان سری بسازید — پیشنهاد قبلی به‌عنوان آنچه واقعاً
                فرستاده شد باقی می‌ماند.
              </InfoBox>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="کارفرما" as="div">
                <CustomerSearchField
                  selectedId={draft.partyId}
                  selectedName={draft.partyName}
                  onPick={(match) =>
                    setDraft((current) => ({
                      ...current,
                      partyId: match.id,
                      partyName: match.name,
                      // A different client has different briefs and different
                      // contacts, so neither choice can carry over.
                      briefId: null,
                      clientContactPartyId: null,
                      clientContactName: "",
                    }))
                  }
                  onClear={() =>
                    setDraft((current) => ({
                      ...current,
                      partyId: null,
                      partyName: "",
                      briefId: null,
                      clientContactPartyId: null,
                      clientContactName: "",
                    }))
                  }
                  emptyText="مشتری‌ای با این نام پیدا نشد."
                  ariaLabel="جست‌وجوی کارفرما"
                  placeholder="نام کارفرما یا شماره…"
                />
              </Field>

              <Field label="عنوان پیشنهاد">
                {frozen ? (
                  <div className={inputClass}>{draft.title}</div>
                ) : (
                  <input
                    className={inputClass}
                    value={draft.title}
                    onChange={(event) => setDraft((c) => ({ ...c, title: event.target.value }))}
                    placeholder="کمپین بهارهٔ کارفرما"
                    aria-label="عنوان پیشنهاد"
                  />
                )}
              </Field>

              <Field
                label="از بریف کارفرما"
                hint="فقط بریف‌های همین کارفرما؛ قیمت‌گذاری بریف یک کارفرما برای کارفرمای دیگر ممکن نیست."
              >
                {frozen ? (
                  <div className={inputClass}>
                    {draft.briefId
                      ? toPersianDigits(
                          briefs.find((b) => b.id === draft.briefId)?.briefNumber ?? "—",
                        )
                      : "—"}
                  </div>
                ) : (
                  <select
                    className={inputClass}
                    value={draft.briefId ?? ""}
                    onChange={(event) =>
                      setDraft((c) => ({ ...c, briefId: event.target.value || null }))
                    }
                    disabled={!draft.partyId}
                    aria-label="بریف کارفرما"
                  >
                    <option value="">بدون بریف</option>
                    {briefs.map((brief) => (
                      <option key={brief.id} value={brief.id}>
                        {toPersianDigits(brief.briefNumber)} — {brief.title}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              <Field label="اعتبار تا">
                {frozen ? (
                  <div className={inputClass}>{formatDate(draft.validUntil || null)}</div>
                ) : (
                  <input
                    className={inputClass}
                    type="date"
                    value={draft.validUntil}
                    onChange={(event) =>
                      setDraft((c) => ({ ...c, validUntil: event.target.value }))
                    }
                    aria-label="تاریخ پایان اعتبار پیشنهاد"
                  />
                )}
              </Field>

              <Field
                label="تصمیم‌گیرندهٔ کارفرما"
                hint="§A: ذی‌نقش کارفرما ثبت می‌شود، بدون آنکه اطلاعات کارفرمای دیگری دیده شود."
              >
                {frozen ? (
                  <div className={inputClass}>{draft.clientContactName || "—"}</div>
                ) : (
                  <select
                    className={inputClass}
                    value={draft.clientContactPartyId ?? ""}
                    onChange={(event) => {
                      const id = event.target.value || null;
                      setDraft((c) => ({
                        ...c,
                        clientContactPartyId: id,
                        clientContactName:
                          contacts.find((contact) => contact.id === id)?.name ?? "",
                      }));
                    }}
                    disabled={!draft.partyId}
                    aria-label="تماس تصمیم‌گیرندهٔ کارفرما"
                  >
                    <option value="">انتخاب نشده</option>
                    {contacts.map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.name}
                        {contact.roleTitle ? ` — ${contact.roleTitle}` : ""}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              <Field label="نام تصمیم‌گیرنده">
                {frozen ? (
                  <div className={inputClass}>{draft.clientContactName || "—"}</div>
                ) : (
                  <input
                    className={inputClass}
                    value={draft.clientContactName}
                    onChange={(event) =>
                      setDraft((c) => ({ ...c, clientContactName: event.target.value }))
                    }
                    placeholder="نام کسی که پیشنهاد را می‌پذیرد"
                    aria-label="نام تصمیم‌گیرندهٔ کارفرما"
                  />
                )}
              </Field>
            </div>

            <Field label="دامنهٔ کار" hint="چه چیزی شامل می‌شود، به زبان ساده.">
              {frozen ? (
                <div className={`${inputClass} whitespace-pre-wrap`}>{draft.scopeOfWork || "—"}</div>
              ) : (
                <textarea
                  className={`${inputClass} min-h-28`}
                  value={draft.scopeOfWork}
                  onChange={(event) => setDraft((c) => ({ ...c, scopeOfWork: event.target.value }))}
                  aria-label="دامنهٔ کار"
                />
              )}
            </Field>

            <Field label="شرایط">
              {frozen ? (
                <div className={`${inputClass} whitespace-pre-wrap`}>{draft.terms || "—"}</div>
              ) : (
                <textarea
                  className={`${inputClass} min-h-20`}
                  value={draft.terms}
                  onChange={(event) => setDraft((c) => ({ ...c, terms: event.target.value }))}
                  aria-label="شرایط پیشنهاد"
                />
              )}
            </Field>

            {/* ------------------------------------------------------------ */}
            {/* The lines, which are the price                                */}
            {/* ------------------------------------------------------------ */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">ردیف‌های پیشنهاد</h3>
                {!frozen ? (
                  <SecondaryButton
                    type="button"
                    onClick={() =>
                      setDraft((c) => ({ ...c, lines: [...c.lines, emptyLine()] }))
                    }
                  >
                    <PlusIcon className="size-4" aria-hidden="true" />
                    ردیف تازه
                  </SecondaryButton>
                ) : null}
              </div>

              <DataTable caption="ردیف‌های پیشنهاد قیمت">
                <DataTableHead>
                  <th className="py-2 text-start font-medium">شرح</th>
                  <th className="py-2 text-start font-medium">تعداد</th>
                  <th className="py-2 text-start font-medium">
                    فی ({money.unitLabel})
                  </th>
                  <th className="py-2 text-start font-medium">مبلغ</th>
                  <th className="py-2 text-start font-medium">حساب درآمد</th>
                  {/* INTERNAL — the two columns a client must never see. */}
                  <th className="py-2 text-start font-medium">بهای تمام‌شده</th>
                  <th className="py-2 text-start font-medium">گذرگاه</th>
                  {!frozen ? <th className="py-2 text-end font-medium">حذف</th> : null}
                </DataTableHead>
                <DataTableBody>
                  {draft.lines.map((line, index) => {
                    const amount = agencyProposalLineAmountRial(
                      normalizeAgencyProposalQuantity(decimalOf(line.quantity)) ?? 0,
                      rialOf(line.unitPrice, money),
                    );
                    const patch = (changes: Partial<LineDraft>) =>
                      setDraft((current) => ({
                        ...current,
                        lines: current.lines.map((entry, at) =>
                          at === index ? { ...entry, ...changes } : entry,
                        ),
                      }));
                    const removeLine = () =>
                      setDraft((current) => ({
                        ...current,
                        lines: current.lines.filter((_, at) => at !== index),
                      }));
                    return (
                      <tr key={index} className="border-b last:border-0 align-top">
                        <td className="py-2">
                          {frozen ? (
                            <div className="py-1">{line.description}</div>
                          ) : (
                            <input
                              className={inputClass}
                              value={line.description}
                              onChange={(event) => patch({ description: event.target.value })}
                              placeholder="مدیریت کمپین"
                              aria-label={`شرح ردیف ${toPersianDigits(index + 1)}`}
                            />
                          )}
                          {!frozen ? (
                            <input
                              className={`${inputClass} mt-1 text-xs`}
                              value={line.note}
                              onChange={(event) => patch({ note: event.target.value })}
                              placeholder="توضیح اختیاری"
                              aria-label={`توضیح ردیف ${toPersianDigits(index + 1)}`}
                            />
                          ) : null}
                        </td>
                        <td className="py-2">
                          {frozen ? (
                            <div className="py-1">{toPersianDigits(line.quantity)}</div>
                          ) : (
                            <PersianNumberInput
                              className={`${inputClass} w-24`}
                              allowDecimal
                              allowNegative={false}
                              value={line.quantity}
                              aria-label={`تعداد ردیف ${toPersianDigits(index + 1)}`}
                              onChange={(event) => patch({ quantity: decimalOf(event.target.value) })}
                            />
                          )}
                        </td>
                        <td className="py-2">
                          {frozen ? (
                            <div className="py-1 whitespace-nowrap">
                              {money.format(rialOf(line.unitPrice, money))}
                            </div>
                          ) : (
                            <PersianNumberInput
                              className={`${inputClass} w-32`}
                              inputMode="numeric"
                              allowNegative={false}
                              value={line.unitPrice}
                              aria-label={`فی ردیف ${toPersianDigits(index + 1)}`}
                              onChange={(event) => patch({ unitPrice: digitsOf(event.target.value) })}
                            />
                          )}
                        </td>
                        <td className="py-2 whitespace-nowrap">{money.format(amount)}</td>
                        <td className="py-2">
                          {frozen ? (
                            <div className="py-1 text-xs">
                              {AGENCY_PROPOSAL_REVENUE_ACCOUNTS.find(
                                (account) => account.code === line.revenueCode,
                              )?.label ?? line.revenueCode}
                            </div>
                          ) : (
                            <select
                              className={`${inputClass} text-xs`}
                              value={line.revenueCode}
                              onChange={(event) => patch({ revenueCode: event.target.value })}
                              aria-label={`حساب درآمد ردیف ${toPersianDigits(index + 1)}`}
                            >
                              {AGENCY_PROPOSAL_REVENUE_ACCOUNTS.map((account) => (
                                <option key={account.code} value={account.code}>
                                  {toPersianDigits(account.code)} — {account.label}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td className="py-2">
                          {frozen ? (
                            <div className="py-1 whitespace-nowrap">
                              {line.cost === "" ? "—" : money.format(rialOf(line.cost, money))}
                            </div>
                          ) : (
                            <PersianNumberInput
                              className={`${inputClass} w-32`}
                              inputMode="numeric"
                              allowNegative={false}
                              value={line.cost}
                              aria-label={`بهای تمام‌شدهٔ ردیف ${toPersianDigits(index + 1)}`}
                              onChange={(event) => patch({ cost: digitsOf(event.target.value) })}
                            />
                          )}
                        </td>
                        <td className="py-2">
                          {frozen ? (
                            <div className="py-1">{line.passThrough ? "بله" : "خیر"}</div>
                          ) : (
                            <label className="flex items-center gap-2 text-xs">
                              <input
                                type="checkbox"
                                checked={line.passThrough}
                                onChange={(event) => patch({ passThrough: event.target.checked })}
                                aria-label={`ردیف ${toPersianDigits(index + 1)} گذرگاه است`}
                              />
                              پول کارفرما
                            </label>
                          )}
                        </td>
                        {!frozen ? (
                          <td className="py-2 text-end">
                            <SecondaryButton
                              type="button"
                              onClick={removeLine}
                              aria-label={`حذف ردیف ${toPersianDigits(index + 1)}`}
                            >
                              <XIcon className="size-4" aria-hidden="true" />
                            </SecondaryButton>
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </DataTableBody>
              </DataTable>
            </div>

            {/* ------------------------------------------------------------ */}
            {/* The figures, live and from the same arithmetic the service uses */}
            {/* ------------------------------------------------------------ */}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={`تخفیف (${money.unitLabel})`}>
                {frozen ? (
                  <div className={inputClass}>{money.format(rialOf(draft.discount, money))}</div>
                ) : (
                  <PersianNumberInput
                    className={inputClass}
                    inputMode="numeric"
                    allowNegative={false}
                    value={draft.discount}
                    onChange={(event) => setDraft((c) => ({ ...c, discount: digitsOf(event.target.value) }))}
                    aria-label="تخفیف پیشنهاد"
                  />
                )}
              </Field>
              <Field label={`مالیات (${money.unitLabel})`}>
                {frozen ? (
                  <div className={inputClass}>{money.format(rialOf(draft.tax, money))}</div>
                ) : (
                  <PersianNumberInput
                    className={inputClass}
                    inputMode="numeric"
                    allowNegative={false}
                    value={draft.tax}
                    onChange={(event) => setDraft((c) => ({ ...c, tax: digitsOf(event.target.value) }))}
                    aria-label="مالیات پیشنهاد"
                  />
                )}
              </Field>
            </div>

            {/* A summary rather than a stored figure: every number here is derived
                from the lines above by the pure module, so there is nothing to
                keep in step and nothing that can disagree. */}
            <div className="rounded-lg border p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">جمع ردیف‌ها</span>
                <span>{money.format(preview.subtotalRial)}</span>
              </div>
              {preview.discountRial > 0 ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">تخفیف</span>
                  <span>− {money.format(preview.discountRial)}</span>
                </div>
              ) : null}
              {preview.taxRial > 0 ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">مالیات</span>
                  <span>+ {money.format(preview.taxRial)}</span>
                </div>
              ) : null}
              <div className="mt-1 flex items-center justify-between gap-2 border-t pt-1 font-medium">
                <span>مبلغ کل پیشنهاد</span>
                <span>{money.format(preview.totalRial)}</span>
              </div>
              {/* INTERNAL — the reason the screen exists, and the figure that must
                  never reach a client. */}
              <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2">
                <span className="text-muted-foreground">
                  حاشیهٔ سود داخلی
                  {previewPartial ? " (ناقص — برخی ردیف‌ها بها ندارند)" : ""}
                </span>
                <span className="font-medium">{money.format(preview.marginRial)}</span>
              </div>
              {preview.passThroughRial > 0 ? (
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>از این مبلغ، پول کارفرما که از حساب ما می‌گذرد</span>
                  <span>{money.format(preview.passThroughRial)}</span>
                </div>
              ) : null}
            </div>

            {editing?.proposal ? (
              <div className="text-xs text-muted-foreground">
                {editing.proposal.contractTitle
                  ? `قرارداد: ${editing.proposal.contractTitle}`
                  : null}
                {editing.proposal.projectName ? ` · پروژه: ${editing.proposal.projectName}` : null}
                {editing.proposal.decidedByName
                  ? ` · تصمیم‌گیرنده: ${editing.proposal.decidedByName}`
                  : null}
              </div>
            ) : null}
          </div>

          <SheetFooter>
            <SecondaryButton type="button" onClick={() => setEditing(null)}>
              {frozen ? "بستن" : "انصراف"}
            </SecondaryButton>
            {/* A frozen offer has nothing this form may write, so there is no save
                button on it: drawing one would invite a click that can only fail. */}
            {canManage && !frozen ? (
              <PrimaryButton type="button" onClick={() => void save()} disabled={saving}>
                {saving ? "در حال ذخیره…" : "ذخیرهٔ پیشنهاد"}
              </PrimaryButton>
            ) : null}
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Sheet open={acting !== null} onOpenChange={(open) => !open && setActing(null)}>
        <SheetContent className="w-full gap-0 sm:max-w-md">
          <SheetHeader>
            <SheetTitle>
              {acting ? AGENCY_PROPOSAL_ACTION_LABELS[acting.action] : ""}
            </SheetTitle>
          </SheetHeader>
          {acting ? (
            <div className="space-y-3 px-4 pb-4">
              <p className="text-sm text-muted-foreground">
                {toPersianDigits(acting.proposal.proposalNumber)} — {acting.proposal.title}
              </p>
              <div className="rounded-lg border p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">مبلغ کل</span>
                  <span>{money.format(acting.proposal.totals.totalRial)}</span>
                </div>
                {acting.proposal.validUntil ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">اعتبار تا</span>
                    <span>{formatDate(acting.proposal.validUntil)}</span>
                  </div>
                ) : null}
              </div>

              {acting.action === "accept" || acting.action === "decline" ? (
                <Field
                  label="تصمیم‌گیرندهٔ کارفرما"
                  hint="پذیرش یا رد، تصمیم کارفرماست و اینجا فقط ثبت می‌شود. بدون نام ثبت نمی‌شود: یک تصمیم بی‌نام، ادعاست نه سند."
                >
                  <input
                    className={inputClass}
                    value={deciderName}
                    onChange={(event) => setDeciderName(event.target.value)}
                    placeholder="نام کسی که تصمیم گرفت"
                    aria-label="نام تصمیم‌گیرنده"
                  />
                </Field>
              ) : null}

              {acting.action === "send" && acting.proposal.margin.lineCount === 0 ? (
                <InfoBox>
                  این پیشنهاد ردیفی ندارد؛ پیش از ارسال باید دست‌کم یک ردیف قیمت
                  داشته باشد.
                </InfoBox>
              ) : null}

              {acting.action === "accept" && acting.proposal.lapsed ? (
                <InfoBox>
                  اعتبار این پیشنهاد تمام شده و پذیرفته نمی‌شود. اگر کارفرما همان
                  قیمت را می‌خواهد، یک پیشنهاد تازه در همان سری بسازید.
                </InfoBox>
              ) : null}

              {actionError ? <ErrorBox>{actionError}</ErrorBox> : null}
            </div>
          ) : null}
          <SheetFooter>
            <SecondaryButton type="button" onClick={() => setActing(null)}>
              انصراف
            </SecondaryButton>
            <PrimaryButton type="button" onClick={() => void runAction()} disabled={actingBusy}>
              {actingBusy ? "در حال ثبت…" : "ثبت"}
            </PrimaryButton>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
