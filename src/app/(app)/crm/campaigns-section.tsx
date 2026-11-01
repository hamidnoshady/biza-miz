"use client";

/**
 * CRM → کمپین‌های کارفرما — the campaign as it ran, for a client (issue #1128 §A + §C).
 *
 * ## What this screen is, and the three things it refuses to pretend
 *
 * A campaign here is downstream of everything else: the brief says what the client
 * asked for, the proposal says what was priced, the contract says what was signed,
 * the project says who did the work — and this says **when it ran, in which
 * channels, what the media money was, and what figures came back**. So the screen
 * is mostly arithmetic and dates rather than workflow, and §C's rule "no fake
 * campaign performance" shows up as three refusals to pretend:
 *
 * 1. **No figure is invented.** Click-through rate, CPL, CPA and ROAS are derived
 *    from the counts the member entered, and every one of them renders as «—» when
 *    its denominator is zero. A CPL of 0 for a campaign that recorded no leads
 *    would read as the cheapest leads the agency ever bought; «—» reads as what it
 *    is, a number nobody has.
 * 2. **There is no platform to import from.** `metricsSource` has exactly two
 *    values, دستی and واردشده, because no ad-platform integration exists in this
 *    product. A third value would be a claim about a connection that is not there,
 *    and the picker below offers only the two.
 * 3. **Attribution is stated, not assumed.** «روش انتساب» is where the member
 *    records *how* the revenue figure was arrived at. §C asks for defensible
 *    attribution and a number with no stated method is not defensible — so the
 *    field sits beside the figure it explains rather than on a separate screen.
 *
 * ## What is frozen, and why that is shown rather than enforced silently
 *
 * A completed or cancelled campaign is closed: its window, its channels, its budget
 * and its five figures stop being editable, because they are what the client was
 * already reported. The note fields stay open, because after-the-fact knowledge
 * belongs on the record. A correction is a **new campaign**, not an edit — which is
 * also what leaves the trail an edit in place would destroy. Migration 0278
 * enforces this below the permission system entirely; the screen disables the
 * controls so a member is not handed a form that will refuse them.
 *
 * ## The two pickers that are populated, and the three that are not
 *
 * The brief and proposal pickers are filled from *this client's own* records, which
 * is §A's "without exposing another client's information" as a shape rather than a
 * warning: another client's brief is not among the options, and 0278's trigger
 * refuses the write anyway. The deal, project and contract pointers are shown but
 * not settable here — the project and contract live behind `workspace.view`, which
 * a CRM-only member does not hold, and enumerating them from this screen would be
 * handing that member a directory of work they have no permission to see.
 *
 * ## Permissions are computed by `crm-section.tsx`, never here
 *
 * `canManage` and `canDelete` arrive as props from the same table the API guards
 * with, so a control is never drawn on a permission its own endpoint refuses.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { PlusIcon, RefreshCwIcon, Trash2Icon, PencilIcon } from "lucide-react";
import {
  AGENCY_CAMPAIGN_ACTION_LABELS,
  AGENCY_CAMPAIGN_BUDGET_STATE_LABELS,
  AGENCY_CAMPAIGN_CHANNELS,
  AGENCY_CAMPAIGN_CHANNEL_LABELS,
  AGENCY_CAMPAIGN_CHANNEL_LIMIT,
  AGENCY_CAMPAIGN_METRICS_NOTE_LIMIT,
  AGENCY_CAMPAIGN_METRICS_SOURCES,
  AGENCY_CAMPAIGN_METRICS_SOURCE_LABELS,
  AGENCY_CAMPAIGN_NOTE_LIMIT,
  AGENCY_CAMPAIGN_OBJECTIVE_LIMIT,
  AGENCY_CAMPAIGN_OWNER_NAME_LIMIT,
  AGENCY_CAMPAIGN_STATUSES,
  AGENCY_CAMPAIGN_STATUS_LABELS,
  AGENCY_CAMPAIGN_STATUS_TONES,
  AGENCY_CAMPAIGN_TITLE_LIMIT,
  type AgencyCampaignAction,
  type AgencyCampaignChannel,
  type AgencyCampaignMetrics,
  type AgencyCampaignMetricsSource,
  type AgencyCampaignStatus,
} from "@/lib/agency-campaign";
import { api, ErrorBox, Field, InfoBox, PrimaryButton, SecondaryButton, errorMessage, inputClass } from "@/app/dashboard/ui";
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
 * Declared here rather than imported: the service module imports `pg`, and a client
 * component that reached through it would drag the driver into the browser bundle.
 * The vocabulary above *is* shared, because `agency-campaign.ts` is pure — that
 * split is the whole reason the two files exist.
 */
interface CampaignWire {
  id: string;
  campaignNumber: string;
  partyId: string;
  clientName: string;
  title: string;
  status: AgencyCampaignStatus;
  objective: string;
  channels: AgencyCampaignChannel[];
  startDate: string | null;
  endDate: string | null;
  budgetRial: number | null;
  spendRial: number;
  impressions: number;
  clicks: number;
  leadsGenerated: number;
  conversions: number;
  revenueRial: number | null;
  metricsSource: AgencyCampaignMetricsSource;
  metricsNote: string;
  note: string;
  ownerName: string;
  briefId: string | null;
  briefNumber: string | null;
  briefTitle: string | null;
  proposalId: string | null;
  proposalNumber: string | null;
  proposalTitle: string | null;
  dealId: string | null;
  dealTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  contractId: string | null;
  contractTitle: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  metrics: AgencyCampaignMetrics;
  budget: { state: keyof typeof AGENCY_CAMPAIGN_BUDGET_STATE_LABELS; differenceRial: number; percentOfBudget: number | null };
  current: boolean;
  actions: AgencyCampaignAction[];
  closed: boolean;
  editable: boolean;
  deletable: boolean;
}

/** The two reference pickers are populated from the chosen client's own records. */
interface ReferenceOption {
  id: string;
  label: string;
}

/* ------------------------------------------------------------------------- */
/* The refusals, in words                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Every code `agency-campaign-service.ts` can throw, translated.
 *
 * `errorMessage` is the shared fallback, but it cannot know this feature's
 * vocabulary, and §C's refusals are the ones a member most needs to hear plainly:
 * «این کمپین بسته شده» tells them the correction is a new campaign, where a
 * generic failure tells them nothing at all.
 */
const CAMPAIGN_ERROR_LABELS: Record<string, string> = {
  campaign_not_found: "کمپین پیدا نشد.",
  client_required: "کارفرما را انتخاب کنید؛ کمپین بی‌کارفرما معنی ندارد.",
  title_required: "عنوان کمپین را بنویسید.",
  text_too_long: "متن واردشده از حد مجاز بلندتر است.",
  invalid_channel: "یکی از کانال‌های انتخاب‌شده شناخته‌شده نیست.",
  too_many_channels: `حداکثر ${toPersianDigits(AGENCY_CAMPAIGN_CHANNEL_LIMIT)} کانال را می‌توان ثبت کرد.`,
  invalid_date: "تاریخ واردشده معتبر نیست.",
  window_reversed: "تاریخ پایان نمی‌تواند پیش از تاریخ آغاز باشد.",
  invalid_metric: "عدد واردشده برای این شاخص معتبر نیست.",
  clicks_exceed_impressions: "کلیک‌ها نمی‌توانند از نمایش‌ها بیشتر باشند.",
  invalid_metrics_source: "منبع شاخص‌ها شناخته‌شده نیست.",
  invalid_reference: "سند انتخاب‌شده به این کسب‌وکار تعلق ندارد.",
  invalid_action: "این عملیات برای کمپین تعریف نشده است.",
  invalid_transition: "این عملیات از وضعیت فعلی کمپین ممکن نیست.",
  campaign_closed: "این کمپین بسته شده است؛ اصلاح آن یک کمپین تازه است، نه ویرایش همین.",
  start_date_required: "برای آغاز اجرا، تاریخ شروع کمپین لازم است.",
  end_date_required: "برای پایان، تاریخ انتهای کمپین لازم است.",
  campaign_not_deletable: "تنها کمپین برنامه‌ریزی‌شده را می‌توان حذف کرد.",
};

function campaignErrorLabel(code: string): string {
  return CAMPAIGN_ERROR_LABELS[code] ?? errorMessage(code);
}

/* ------------------------------------------------------------------------- */
/* Small renderers                                                            */
/* ------------------------------------------------------------------------- */

function formatDate(value: string | null): string {
  return value ? formatJalali(value) : "—";
}

function windowOf(campaign: CampaignWire): string {
  if (campaign.startDate === null && campaign.endDate === null) return "بدون بازه";
  return `${formatDate(campaign.startDate)} تا ${formatDate(campaign.endDate)}`;
}

function channelNames(channels: AgencyCampaignChannel[]): string {
  if (channels.length === 0) return "—";
  return channels.map((channel) => AGENCY_CAMPAIGN_CHANNEL_LABELS[channel] ?? channel).join("، ");
}

/**
 * A derived ratio, or the honest absence of one.
 *
 * The `null` case is the whole point: «—» says nobody has this number, where ۰
 * would say the number is zero. A campaign with no recorded leads has no CPL; it
 * does not have the cheapest leads ever bought.
 */
function ratio(value: number | null, suffix: string, digits = 0): string {
  if (value === null) return "—";
  return `${toPersianDigits(value.toFixed(digits))}${suffix}`;
}

/* ------------------------------------------------------------------------- */
/* The editor's own draft state                                               */
/* ------------------------------------------------------------------------- */

interface CampaignDraft {
  partyId: string | null;
  partyName: string;
  title: string;
  objective: string;
  channels: AgencyCampaignChannel[];
  startDate: string;
  endDate: string;
  budgetRial: string;
  spendRial: string;
  impressions: string;
  clicks: string;
  leadsGenerated: string;
  conversions: string;
  revenueRial: string;
  metricsSource: AgencyCampaignMetricsSource;
  metricsNote: string;
  note: string;
  ownerName: string;
  briefId: string;
  proposalId: string;
}

function emptyDraft(): CampaignDraft {
  return {
    partyId: null,
    partyName: "",
    title: "",
    objective: "",
    channels: [],
    startDate: "",
    endDate: "",
    budgetRial: "",
    spendRial: "",
    impressions: "",
    clicks: "",
    leadsGenerated: "",
    conversions: "",
    revenueRial: "",
    metricsSource: "manual",
    metricsNote: "",
    note: "",
    ownerName: "",
    briefId: "",
    proposalId: "",
  };
}

function draftOf(campaign: CampaignWire, money: { toInput: (value: number) => number }): CampaignDraft {
  return {
    partyId: campaign.partyId,
    partyName: campaign.clientName,
    title: campaign.title,
    objective: campaign.objective,
    channels: [...campaign.channels],
    // Gregorian ISO, as the input's `type="date"` wants and as the database stores.
    // Displayed Jalali everywhere else — the two are different jobs and mixing them
    // is how a date stops being a date.
    startDate: campaign.startDate ?? "",
    endDate: campaign.endDate ?? "",
    budgetRial: campaign.budgetRial === null ? "" : String(money.toInput(campaign.budgetRial)),
    spendRial: String(money.toInput(campaign.spendRial)),
    impressions: String(campaign.impressions),
    clicks: String(campaign.clicks),
    leadsGenerated: String(campaign.leadsGenerated),
    conversions: String(campaign.conversions),
    revenueRial: campaign.revenueRial === null ? "" : String(money.toInput(campaign.revenueRial)),
    metricsSource: campaign.metricsSource,
    metricsNote: campaign.metricsNote,
    note: campaign.note,
    ownerName: campaign.ownerName,
    briefId: campaign.briefId ?? "",
    proposalId: campaign.proposalId ?? "",
  };
}

/* ------------------------------------------------------------------------- */
/* The screen                                                                 */
/* ------------------------------------------------------------------------- */

export function CampaignsSection({
  canManage,
  canDelete,
}: {
  canManage: boolean;
  canDelete: boolean;
}) {
  const money = useMoney();
  const [campaigns, setCampaigns] = useState<CampaignWire[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [currentOnly, setCurrentOnly] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<{ campaign: CampaignWire | null; draft: CampaignDraft } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CampaignWire | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /** The two pickers' options, refetched whenever the client changes. */
  const [briefOptions, setBriefOptions] = useState<ReferenceOption[]>([]);
  const [proposalOptions, setProposalOptions] = useState<ReferenceOption[]>([]);

  const load = useCallback(async () => {
    setLoadError(null);
    const search = new URLSearchParams();
    const trimmed = toLatinDigits(query).trim();
    if (trimmed) search.set("q", trimmed);
    if (statusFilter) search.set("status", statusFilter);
    if (currentOnly) search.set("currentOnly", "1");
    const result = await api<{ campaigns?: CampaignWire[]; error?: string }>(
      `/api/crm/campaigns?${search.toString()}`,
    );
    if (result.aborted) return;
    if (!result.ok || !result.data.campaigns) {
      setLoadError(campaignErrorLabel(result.data.error ?? "load_failed"));
      setCampaigns(null);
      return;
    }
    setCampaigns(result.data.campaigns);
  }, [query, statusFilter, currentOnly]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  // Reference options follow the client, and are fetched from that client's own
  // records: §A's separation rule as a shape. Another client's brief is not among
  // the options, and 0278's trigger would refuse the write anyway.
  useEffect(() => {
    const partyId = editing?.draft.partyId;
    if (!partyId) {
      setBriefOptions([]);
      setProposalOptions([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const [briefs, proposals] = await Promise.all([
        api<{ briefs?: { id: string; briefNumber: string; title: string }[] }>(
          `/api/crm/briefs?partyId=${encodeURIComponent(partyId)}`,
        ),
        api<{ proposals?: { id: string; proposalNumber: string; title: string }[] }>(
          `/api/crm/proposals?partyId=${encodeURIComponent(partyId)}`,
        ),
      ]);
      if (cancelled) return;
      setBriefOptions(
        (briefs.data.briefs ?? []).map((brief) => ({
          id: brief.id,
          label: `${brief.briefNumber} — ${brief.title}`,
        })),
      );
      setProposalOptions(
        (proposals.data.proposals ?? []).map((item) => ({
          id: item.id,
          label: `${item.proposalNumber} — ${item.title}`,
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [editing?.draft.partyId]);

  const openCreate = () => {
    setSaveError(null);
    setEditing({ campaign: null, draft: emptyDraft() });
    setEditorOpen(true);
  };

  const openEdit = (campaign: CampaignWire) => {
    setSaveError(null);
    setEditing({ campaign, draft: draftOf(campaign, money) });
    setEditorOpen(true);
  };

  const patchDraft = (patch: Partial<CampaignDraft>) =>
    setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current));

  const toggleChannel = (channel: AgencyCampaignChannel) =>
    setEditing((current) => {
      if (!current) return current;
      const has = current.draft.channels.includes(channel);
      // Refused rather than silently dropped: the cap is the member's to hit and
      // see, and a picker that quietly ignores the thirteenth click looks broken.
      if (!has && current.draft.channels.length >= AGENCY_CAMPAIGN_CHANNEL_LIMIT) return current;
      return {
        ...current,
        draft: {
          ...current.draft,
          channels: has
            ? current.draft.channels.filter((item) => item !== channel)
            : [...current.draft.channels, channel],
        },
      };
    });

  /**
   * Build the request body.
   *
   * A patch sends only what the member means to change, and `undefined` leaves a
   * field alone while an empty string clears it. Sending every field on every save
   * would be indistinguishable from clearing the ones the member never touched —
   * which is how a rename wipes a budget.
   */
  const bodyOf = (): Record<string, unknown> => {
    const draft = editing!.draft;
    const campaign = editing!.campaign;
    const body: Record<string, unknown> = {
      partyId: draft.partyId,
      title: draft.title.trim(),
      objective: draft.objective.trim(),
      channels: draft.channels,
      startDate: draft.startDate || null,
      endDate: draft.endDate || null,
      budgetRial: draft.budgetRial === "" ? null : money.fromInput(Number(toLatinDigits(draft.budgetRial))),
      spendRial: draft.spendRial === "" ? null : money.fromInput(Number(toLatinDigits(draft.spendRial))),
      impressions: draft.impressions === "" ? null : Number(toLatinDigits(draft.impressions)),
      clicks: draft.clicks === "" ? null : Number(toLatinDigits(draft.clicks)),
      leadsGenerated: draft.leadsGenerated === "" ? null : Number(toLatinDigits(draft.leadsGenerated)),
      conversions: draft.conversions === "" ? null : Number(toLatinDigits(draft.conversions)),
      revenueRial: draft.revenueRial === "" ? null : money.fromInput(Number(toLatinDigits(draft.revenueRial))),
      metricsSource: draft.metricsSource,
      metricsNote: draft.metricsNote.trim(),
      note: draft.note.trim(),
      ownerName: draft.ownerName.trim(),
      briefId: draft.briefId || null,
      proposalId: draft.proposalId || null,
    };
    if (campaign === null) return body;
    // On edit, drop what did not change: the service merges over the stored row, so
    // an unchanged field is better left unsaid than repeated.
    const before: Record<string, unknown> = {
      partyId: campaign.partyId,
      title: campaign.title,
      objective: campaign.objective,
      channels: campaign.channels,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      budgetRial: campaign.budgetRial,
      spendRial: campaign.spendRial,
      impressions: campaign.impressions,
      clicks: campaign.clicks,
      leadsGenerated: campaign.leadsGenerated,
      conversions: campaign.conversions,
      revenueRial: campaign.revenueRial,
      metricsSource: campaign.metricsSource,
      metricsNote: campaign.metricsNote,
      note: campaign.note,
      ownerName: campaign.ownerName,
      briefId: campaign.briefId,
      proposalId: campaign.proposalId,
    };
    for (const key of Object.keys(body)) {
      const mine = body[key];
      const theirs = before[key];
      const same = Array.isArray(mine) && Array.isArray(theirs)
        ? mine.length === theirs.length && mine.every((item, index) => item === theirs[index])
        : mine === theirs;
      if (same) delete body[key];
    }
    return body;
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setSaveError(null);
    const body = bodyOf();
    const result = await api<{ campaign?: CampaignWire; error?: string }>(
      editing.campaign === null ? "/api/crm/campaigns" : `/api/crm/campaigns/${editing.campaign.id}`,
      {
        method: editing.campaign === null ? "POST" : "PATCH",
        body: JSON.stringify(body),
      },
    );
    setSaving(false);
    if (result.aborted) return;
    if (!result.ok) {
      setSaveError(campaignErrorLabel(result.data.error ?? "save_failed"));
      return;
    }
    setEditorOpen(false);
    setEditing(null);
    setReloadKey((key) => key + 1);
  };

  const applyAction = async (campaign: CampaignWire, action: AgencyCampaignAction) => {
    setActionError(null);
    const result = await api<{ campaign?: CampaignWire; error?: string }>(
      `/api/crm/campaigns/${campaign.id}/status`,
      { method: "POST", body: JSON.stringify({ action }) },
    );
    if (result.aborted) return;
    if (!result.ok) {
      setActionError(campaignErrorLabel(result.data.error ?? "action_failed"));
      return;
    }
    setReloadKey((key) => key + 1);
  };

  const remove = async () => {
    if (!confirmDelete) return;
    setDeleteError(null);
    const result = await api<{ result?: string; error?: string }>(
      `/api/crm/campaigns/${confirmDelete.id}`,
      { method: "DELETE" },
    );
    if (result.aborted) return;
    if (!result.ok) {
      setDeleteError(campaignErrorLabel(result.data.error ?? "delete_failed"));
      return;
    }
    setConfirmDelete(null);
    setReloadKey((key) => key + 1);
  };

  /* What the header row says about the list as a whole. Derived from the rows
   * actually loaded, never from a figure the list did not read. */
  const totals = useMemo(() => {
    const rows = campaigns ?? [];
    return {
      count: rows.length,
      inFlight: rows.filter((row) => row.status === "running" || row.status === "paused").length,
      current: rows.filter((row) => row.current).length,
      spend: rows.reduce((sum, row) => sum + row.spendRial, 0),
    };
  }, [campaigns]);

  if (campaigns === null && loadError === null) {
    return <SectionCardSkeleton />;
  }

  const closed = editing?.campaign?.closed ?? false;
  const draft = editing?.draft ?? emptyDraft();

  return (
    <div className="space-y-4">
      <SectionCard
        title="کمپین‌های کارفرما"
        description="چه زمانی، در کدام کانال‌ها، با چه هزینه‌ای — و چه بازدهی. شاخص‌ها ادعای عضو تیم‌اند و روش انتساب کنارشان ثبت می‌شود."
        actions={
          <div className="flex items-center gap-2">
            <SecondaryButton onClick={() => setReloadKey((key) => key + 1)}>
              <RefreshCwIcon className="size-4" aria-hidden="true" />
              تازه‌سازی
            </SecondaryButton>
            {canManage ? (
              <PrimaryButton onClick={openCreate}>
                <PlusIcon className="size-4" aria-hidden="true" />
                کمپین تازه
              </PrimaryButton>
            ) : null}
          </div>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
            <Field label="جستجو">
              <input
                className={inputClass}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="عنوان، شماره یا نام کارفرما…"
                aria-label="جستجوی کمپین"
              />
            </Field>
            </div>
            <div className="min-w-40">
            <Field label="وضعیت">
              <select
                className={inputClass}
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                aria-label="فیلتر وضعیت کمپین"
              >
                <option value="">همه</option>
                {AGENCY_CAMPAIGN_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {AGENCY_CAMPAIGN_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </Field>
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                checked={currentOnly}
                onChange={(event) => setCurrentOnly(event.target.checked)}
              />
              فقط کمپین‌های در جریان امروز
            </label>
          </div>

          <InfoBox>
            {campaigns === null
              ? "—"
              : `${toPersianDigits(totals.count)} کمپین · ${toPersianDigits(totals.inFlight)} در جریان · ${toPersianDigits(totals.current)} روی هوا امروز · هزینهٔ رسانه ${money.format(totals.spend)}`}
          </InfoBox>

          {loadError ? <ErrorBox>{loadError}</ErrorBox> : null}
          {actionError ? <ErrorBox>{actionError}</ErrorBox> : null}

          {campaigns !== null && campaigns.length === 0 ? (
            <EmptyState title="کمپینی با این فیلترها پیدا نشد">
              {canManage
                ? "یک کمپین تازه ثبت کنید تا بازهٔ اجرا، کانال‌ها، هزینهٔ رسانه و بازده آن برای کارفرما بماند."
                : "کمپینی ثبت نشده است."}
            </EmptyState>
          ) : null}

          {campaigns !== null && campaigns.length > 0 ? (
            <DataTable caption="کمپین‌های کارفرما">
              <DataTableHead>
                {[
                  "شماره",
                  "عنوان",
                  "کارفرما",
                  "کانال‌ها",
                  "بازهٔ اجرا",
                  "وضعیت",
                  "بودجه و هزینه",
                  "نمایش / کلیک",
                  "سرنخ / تبدیل",
                  "CTR",
                  "CPL",
                  "CPA",
                  "ROAS",
                  "",
                ].map((column) => (
                  <th key={column || "عملیات"} className="py-2 text-start font-medium whitespace-nowrap">
                    {column}
                  </th>
                ))}
              </DataTableHead>
              <DataTableBody>
                {campaigns.map((campaign) => (
                  <tr key={campaign.id} className="border-t border-border/60">
                    <td className="py-2 whitespace-nowrap">{toPersianDigits(campaign.campaignNumber)}</td>
                    <td className="py-2">
                      <div className="font-medium">{campaign.title}</div>
                      {campaign.briefNumber ? (
                        <div className="text-xs text-muted-foreground">
                          بریف {toPersianDigits(campaign.briefNumber)}
                          {campaign.proposalNumber ? ` · پیشنهاد ${toPersianDigits(campaign.proposalNumber)}` : ""}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 whitespace-nowrap">{campaign.clientName}</td>
                    <td className="py-2 max-w-56 text-xs">{channelNames(campaign.channels)}</td>
                    <td className="py-2 whitespace-nowrap text-xs">{windowOf(campaign)}</td>
                    <td className="py-2 whitespace-nowrap">
                      <StatusBadge tone={AGENCY_CAMPAIGN_STATUS_TONES[campaign.status]}>
                        {AGENCY_CAMPAIGN_STATUS_LABELS[campaign.status]}
                      </StatusBadge>
                      {campaign.current ? (
                        <span className="ms-2 text-xs text-muted-foreground">روی هوا</span>
                      ) : null}
                    </td>
                    <td className="py-2 whitespace-nowrap text-xs">
                      <div>
                        هزینه {money.format(campaign.spendRial)}
                        {campaign.budgetRial === null ? "" : ` از ${money.format(campaign.budgetRial)}`}
                      </div>
                      <div className="text-muted-foreground">
                        {AGENCY_CAMPAIGN_BUDGET_STATE_LABELS[campaign.budget.state]}
                        {campaign.budget.state === "over"
                          ? ` · ${money.format(campaign.budget.differenceRial)} بیش از بودجه`
                          : ""}
                      </div>
                    </td>
                    <td className="py-2 whitespace-nowrap text-xs">
                      {toPersianDigits(campaign.impressions)} / {toPersianDigits(campaign.clicks)}
                    </td>
                    <td className="py-2 whitespace-nowrap text-xs">
                      {toPersianDigits(campaign.leadsGenerated)} / {toPersianDigits(campaign.conversions)}
                    </td>
                    <td className="py-2 whitespace-nowrap text-xs">{ratio(campaign.metrics.ctrPct, "٪", 2)}</td>
                    <td className="py-2 whitespace-nowrap text-xs">
                      {campaign.metrics.cplRial === null ? "—" : money.format(campaign.metrics.cplRial)}
                    </td>
                    <td className="py-2 whitespace-nowrap text-xs">
                      {campaign.metrics.cpaRial === null ? "—" : money.format(campaign.metrics.cpaRial)}
                    </td>
                    <td className="py-2 whitespace-nowrap text-xs">{ratio(campaign.metrics.roas, "", 2)}</td>
                    <td className="py-2 whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1">
                        {canManage && campaign.actions.length > 0
                          ? campaign.actions.map((action) => (
                              <SecondaryButton key={action} onClick={() => void applyAction(campaign, action)}>
                                {AGENCY_CAMPAIGN_ACTION_LABELS[action]}
                              </SecondaryButton>
                            ))
                          : null}
                        {canManage ? (
                          <SecondaryButton onClick={() => openEdit(campaign)} aria-label={`ویرایش ${campaign.title}`}>
                            <PencilIcon className="size-4" aria-hidden="true" />
                          </SecondaryButton>
                        ) : null}
                        {canDelete && campaign.deletable ? (
                          <SecondaryButton
                            onClick={() => {
                              setDeleteError(null);
                              setConfirmDelete(campaign);
                            }}
                            aria-label={`حذف ${campaign.title}`}
                          >
                            <Trash2Icon className="size-4" aria-hidden="true" />
                          </SecondaryButton>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </DataTableBody>
            </DataTable>
          ) : null}
        </div>
      </SectionCard>

      <Sheet open={editorOpen} onOpenChange={setEditorOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>
              {editing?.campaign
                ? `کمپین ${toPersianDigits(editing.campaign.campaignNumber)}`
                : "کمپین تازه"}
            </SheetTitle>
          </SheetHeader>

          <div className="space-y-4 px-4 pb-4">
            {saveError ? <ErrorBox>{saveError}</ErrorBox> : null}

            {closed ? (
              <InfoBox>
                این کمپین بسته شده است: بازه، کانال‌ها، بودجه و شاخص‌ها همان‌اند که به کارفرما گزارش شده‌اند.
                یادداشت‌ها باز می‌مانند و اصلاح محتوا یک کمپین تازه است، نه ویرایش همین.
              </InfoBox>
            ) : null}

            <CustomerSearchField
              selectedId={draft.partyId}
              selectedName={draft.partyName}
              emptyText="مشتری‌ای با این نام پیدا نشد."
              ariaLabel="جستجوی کارفرمای کمپین"
              onPick={(match) => patchDraft({ partyId: match.id, partyName: match.name, briefId: "", proposalId: "" })}
              onClear={() => patchDraft({ partyId: null, partyName: "", briefId: "", proposalId: "" })}
            />

            <Field label="عنوان کمپین">
              <input
                className={inputClass}
                value={draft.title}
                maxLength={AGENCY_CAMPAIGN_TITLE_LIMIT}
                disabled={closed}
                onChange={(event) => patchDraft({ title: event.target.value })}
                placeholder="بهارهٔ ۱۴۰۵ — شبکه‌های اجتماعی"
                aria-label="عنوان کمپین"
              />
            </Field>

            <Field label="هدف کمپین">
              <textarea
                className={inputClass}
                value={draft.objective}
                rows={3}
                maxLength={AGENCY_CAMPAIGN_OBJECTIVE_LIMIT}
                disabled={closed}
                onChange={(event) => patchDraft({ objective: event.target.value })}
                aria-label="هدف کمپین"
              />
            </Field>

            <Field
              label={`کانال‌های رسانه (حداکثر ${toPersianDigits(AGENCY_CAMPAIGN_CHANNEL_LIMIT)})`}
            >
              <div className="flex flex-wrap gap-2">
                {AGENCY_CAMPAIGN_CHANNELS.map((channel) => {
                  const picked = draft.channels.includes(channel);
                  return (
                    <label
                      key={channel}
                      className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                        picked ? "border-primary bg-primary/10" : "border-border"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={picked}
                        disabled={closed}
                        onChange={() => toggleChannel(channel)}
                      />
                      {AGENCY_CAMPAIGN_CHANNEL_LABELS[channel]}
                    </label>
                  );
                })}
              </div>
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="تاریخ آغاز">
                <input
                  className={inputClass}
                  type="date"
                  value={draft.startDate}
                  disabled={closed}
                  onChange={(event) => patchDraft({ startDate: event.target.value })}
                  aria-label="تاریخ آغاز کمپین"
                />
              </Field>
              <Field label="تاریخ پایان">
                <input
                  className={inputClass}
                  type="date"
                  value={draft.endDate}
                  disabled={closed}
                  onChange={(event) => patchDraft({ endDate: event.target.value })}
                  aria-label="تاریخ پایان کمپین"
                />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={`بودجهٔ رسانه (${money.unitLabel})`}>
                <PersianNumberInput
                  className={inputClass}
                  value={draft.budgetRial}
                  disabled={closed}
                  onChange={(event) => patchDraft({ budgetRial: event.target.value })}
                  aria-label={`بودجهٔ رسانه به ${money.unitLabel}`}
                />
              </Field>
              <Field label={`هزینهٔ رسانهٔ انجام‌شده (${money.unitLabel})`}>
                <PersianNumberInput
                  className={inputClass}
                  value={draft.spendRial}
                  disabled={closed}
                  onChange={(event) => patchDraft({ spendRial: event.target.value })}
                  aria-label={`هزینهٔ رسانه به ${money.unitLabel}`}
                />
              </Field>
            </div>

            <InfoBox>
              هزینهٔ بیشتر از بودجه ثبت‌شدنی است و «فراتر از بودجه» یک وضعیت است، نه خطا: عدد واقعی را
              در یادداشت پنهان کردن، گزارشی می‌سازد که هیچ‌کس نمی‌تواند به آن تکیه کند.
            </InfoBox>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="نمایش‌ها">
                <PersianNumberInput
                  className={inputClass}
                  value={draft.impressions}
                  disabled={closed}
                  onChange={(event) => patchDraft({ impressions: event.target.value })}
                  aria-label="تعداد نمایش‌ها"
                />
              </Field>
              <Field label="کلیک‌ها">
                <PersianNumberInput
                  className={inputClass}
                  value={draft.clicks}
                  disabled={closed}
                  onChange={(event) => patchDraft({ clicks: event.target.value })}
                  aria-label="تعداد کلیک‌ها"
                />
              </Field>
              <Field label="سرنخ‌های تولیدشده">
                <PersianNumberInput
                  className={inputClass}
                  value={draft.leadsGenerated}
                  disabled={closed}
                  onChange={(event) => patchDraft({ leadsGenerated: event.target.value })}
                  aria-label="تعداد سرنخ‌ها"
                />
              </Field>
              <Field label="تبدیل‌ها">
                <PersianNumberInput
                  className={inputClass}
                  value={draft.conversions}
                  disabled={closed}
                  onChange={(event) => patchDraft({ conversions: event.target.value })}
                  aria-label="تعداد تبدیل‌ها"
                />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={`درآمد منتسب به کمپین (${money.unitLabel})`}>
                <PersianNumberInput
                  className={inputClass}
                  value={draft.revenueRial}
                  disabled={closed}
                  onChange={(event) => patchDraft({ revenueRial: event.target.value })}
                  aria-label={`درآمد منتسب به ${money.unitLabel}`}
                />
              </Field>
              <Field label="منبع شاخص‌ها">
                <select
                  className={inputClass}
                  value={draft.metricsSource}
                  disabled={closed}
                  onChange={(event) =>
                    patchDraft({ metricsSource: event.target.value as AgencyCampaignMetricsSource })
                  }
                  aria-label="منبع شاخص‌ها"
                >
                  {/* Two values and no third: there is no ad-platform integration in
                      this product, so a «پلتفرم» option would be a claim about a
                      connection that does not exist. */}
                  {AGENCY_CAMPAIGN_METRICS_SOURCES.map((source) => (
                    <option key={source} value={source}>
                      {AGENCY_CAMPAIGN_METRICS_SOURCE_LABELS[source]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="روش انتساب — این درآمد چگونه به این کمپین نسبت داده شد؟">
              <textarea
                className={inputClass}
                value={draft.metricsNote}
                rows={2}
                maxLength={AGENCY_CAMPAIGN_METRICS_NOTE_LIMIT}
                onChange={(event) => patchDraft({ metricsNote: event.target.value })}
                placeholder="مثلاً: فروش‌های دارای کد تخفیف کمپین، در بازهٔ اجرا"
                aria-label="روش انتساب"
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="بریف کارفرما">
                <select
                  className={inputClass}
                  value={draft.briefId}
                  disabled={closed}
                  onChange={(event) => patchDraft({ briefId: event.target.value })}
                  aria-label="بریف کارفرما"
                >
                  <option value="">—</option>
                  {briefOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="پیشنهاد قیمت">
                <select
                  className={inputClass}
                  value={draft.proposalId}
                  disabled={closed}
                  onChange={(event) => patchDraft({ proposalId: event.target.value })}
                  aria-label="پیشنهاد قیمت"
                >
                  <option value="">—</option>
                  {proposalOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {editing?.campaign?.dealTitle || editing?.campaign?.projectName || editing?.campaign?.contractTitle ? (
              <InfoBox>
                {editing.campaign?.dealTitle ? `فرصت: ${editing.campaign.dealTitle}` : ""}
                {editing.campaign?.projectName ? ` · پروژه: ${editing.campaign.projectName}` : ""}
                {editing.campaign?.contractTitle ? ` · قرارداد: ${editing.campaign.contractTitle}` : ""}
              </InfoBox>
            ) : null}

            <Field label="مسئول کمپین">
              <input
                className={inputClass}
                value={draft.ownerName}
                maxLength={AGENCY_CAMPAIGN_OWNER_NAME_LIMIT}
                onChange={(event) => patchDraft({ ownerName: event.target.value })}
                aria-label="مسئول کمپین"
              />
            </Field>

            <Field label="یادداشت داخلی">
              <textarea
                className={inputClass}
                value={draft.note}
                rows={3}
                maxLength={AGENCY_CAMPAIGN_NOTE_LIMIT}
                onChange={(event) => patchDraft({ note: event.target.value })}
                aria-label="یادداشت داخلی"
              />
            </Field>

            {/* The note fields stay open on a closed campaign, because
                after-the-fact knowledge belongs on the record. */}
            {closed ? (
              <InfoBox>
                یادداشت‌ها و روش انتساب باز می‌مانند: دانشی که بعد از پایان به دست می‌آید جای آن روی
                همین سند است.
              </InfoBox>
            ) : null}
          </div>

          <SheetFooter>
            <SecondaryButton onClick={() => setEditorOpen(false)}>بستن</SecondaryButton>
            {canManage ? (
              <PrimaryButton onClick={() => void save()} disabled={saving}>
                {saving ? "در حال ذخیره…" : "ذخیره"}
              </PrimaryButton>
            ) : null}
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Sheet open={confirmDelete !== null} onOpenChange={(open) => (open ? null : setConfirmDelete(null))}>
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>حذف کمپین</SheetTitle>
          </SheetHeader>
          <div className="space-y-4 px-4 pb-4">
            {deleteError ? <ErrorBox>{deleteError}</ErrorBox> : null}
            <p className="text-sm">
              «{confirmDelete?.title}» حذف شود؟ تنها کمپین برنامه‌ریزی‌شده حذف‌شدنی است؛ کمپینی که اجرا
              شده بخشی از گزارش کارفرماست و می‌ماند.
            </p>
          </div>
          <SheetFooter>
            <SecondaryButton onClick={() => setConfirmDelete(null)}>انصراف</SecondaryButton>
            <PrimaryButton onClick={() => void remove()}>حذف</PrimaryButton>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
