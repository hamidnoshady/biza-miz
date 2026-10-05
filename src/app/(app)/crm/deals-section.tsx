"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

/**
 * The sales pipeline (Phase 36) — a kanban over `crm_deals`.
 *
 * The one thing to keep in mind reading this screen: **a deal is an
 * expectation, not a transaction.** Moving a card to «برنده» posts nothing;
 * revenue appears when an order or invoice is settled through the sales path
 * that already posts correctly. That is why the footer says so in Persian, why
 * a won deal links to its order rather than replacing one, and why the weighted
 * total is shown next to the raw one — the raw sum counts a first-contact lead
 * the same as a signed-tomorrow deal.
 *
 * ## The columns are the business's, not the code's
 *
 * The board used to render `DEAL_STAGES` — six strings compiled into the
 * bundle — while the database had held pipelines and stages as rows since
 * migration 0157. So a jeweller with «ارزیابی» and «سفارش ساخت» was shown
 * «واجد شرایط» and «پیشنهاد», and the stage configurator in settings changed
 * nothing here. The columns now come from `GET /api/crm/deals`, which returns
 * the selected (or default) pipeline, and a move sends the **stage id** —
 * the canonical identity. The legacy `stage` string is still read, because
 * deals written before 0157 carry one and it is what every older report
 * compares against; see `legacyStageKey`.
 *
 * ## Won is a handoff, not a posting
 *
 * A «برنده» card offers **ثبت سند فروش**, which is a link into Accounting with
 * the customer and deal pre-filled plus a place to paste the document number
 * back. That round trip is the integration: the CRM records which invoice the
 * deal became, and never creates one.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PlusIcon, RefreshCwIcon, ChevronDownIcon, ArrowLeftRightIcon, ReceiptTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMoney } from "@/components/money/money-context";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { formatPersianNumber, toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import {
  DEAL_STAGES,
  DEAL_STAGE_META,
  weightedPipelineValue,
  winRate,
  type DealStage,
} from "@/lib/crm-shared";
import { cardClass, EmptyState, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessage, Field, InfoBox, inputClass } from "@/app/dashboard/ui";
import { crmCustomerHref, crmDealOrderHref } from "./crm-routes";
import { CustomerSearchField } from "./customer-search";
import { CrmCardHeading } from "./crm-card-heading";
import { CrmTodayQueues } from "./today-queues";
import { CrmAssigneePicker, UNASSIGNED } from "./crm-assignee-picker";
import { SavedViewsBar } from "./saved-views-bar";
import {
  dealViewErrorLine,
  dealViewFilterCount,
  dealViewQuery,
  dealViewSearchParams,
  describeDealView,
  EMPTY_DEAL_VIEW_FILTERS,
  hasDealViewFilters,
  type DealViewFilters,
} from "@/lib/crm-deal-views";

interface Deal {
  id: string;
  customerId: string | null;
  customerName: string | null;
  title: string;
  description: string;
  /** Compatibility key. The board matches on `stageId` first. */
  stage: DealStage;
  stageId: string | null;
  pipelineId: string | null;
  valueRial: number;
  probability: number | null;
  expectedCloseDate: string | null;
  ownerUser: string;
  /** The owner as a member id. Null when nobody is assigned. */
  ownerUserId: string | null;
  source: string;
  lostReason: string | null;
  orderId: string | null;
  closedAt: string | null;
  createdAt: string;
}

interface PipelineStageOption {
  id: string;
  name: string;
  legacyKey: string | null;
  displayOrder: number;
  defaultProbability: number;
  outcome: "open" | "won" | "lost";
  isActive: boolean;
  requirementNote: string;
}

interface PipelineOption {
  pipeline: { id: string; name: string; isDefault: boolean; stages: PipelineStageOption[] } | null;
  pipelines: { id: string; name: string; isDefault: boolean }[];
}

/**
 * The six seeded stages, as board columns.
 *
 * Only used when the pipeline could not be read — the board then degrades to
 * exactly what it looked like before stages became rows, rather than to an
 * empty page. `id` is the legacy key here, which can never collide with a real
 * stage uuid, and `legacyKey` is what the deal rows carry.
 */
const LEGACY_COLUMNS: PipelineStageOption[] = DEAL_STAGES.map((key, index) => ({
  id: key,
  name: DEAL_STAGE_META[key].label,
  legacyKey: key,
  displayOrder: index + 1,
  defaultProbability: DEAL_STAGE_META[key].probability,
  outcome: key === "won" ? "won" : key === "lost" ? "lost" : "open",
  isActive: true,
  requirementNote: "",
}));

/**
 * A stage id is a uuid; the degraded board's columns carry the legacy keys
 * instead. The form asks the same question the API's `stageId` guard does, so
 * it never posts a value the guard would reject.
 */
function isStageUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** The tone a column badge takes from the stage's meaning, not from its name. */
const OUTCOME_TONES: Record<PipelineStageOption["outcome"], "active" | "positive" | "danger"> = {
  open: "active",
  won: "positive",
  lost: "danger",
};

export function DealsSection({ canManage = false }: { canManage?: boolean }) {
  const money = useMoney();
  const searchParams = useSearchParams();
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [pipeline, setPipeline] = useState<PipelineOption["pipeline"]>(null);
  const [pipelines, setPipelines] = useState<PipelineOption["pipelines"]>([]);
  const [handoffDeal, setHandoffDeal] = useState<Deal | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Deal | "new" | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // A deal moving to «از دست رفته» waits here for its reason before the move
  // actually commits — see `requestStageChange`.
  const [pendingLostId, setPendingLostId] = useState<string | null>(null);
  // The «از دست رفته» column is whichever stage carries the `lost` outcome; a
  // business may have several (lost to price, lost to a competitor), and the
  // confirmation has to move the deal to the one that was actually dropped on.
  const [pendingLostStage, setPendingLostStage] = useState<PipelineStageOption | null>(null);

  /**
   * The one filter document this screen owns.
   *
   * It is what the request is built from, what the saved-view bar is handed and
   * what the chips are described from — so a view can only ever be a set of the
   * filters this screen honours, and a list can never be labelled with
   * something the server was not asked for (`crm-deal-views.ts`).
   */
  const [filters, setFilters] = useState<DealViewFilters>(EMPTY_DEAL_VIEW_FILTERS);
  /** Whether the board or the list is showing. The board is the default. */
  const [layout, setLayout] = useState<"board" | "list">("board");
  /** The member names the owner filter and the chips can use. */
  const [members, setMembers] = useState<{ id: string; name: string; isActive: boolean }[]>([]);
  const [filterError, setFilterError] = useState("");
  const [info, setInfo] = useState("");

  const load = useCallback((next: DealViewFilters) => {
    const params = dealViewSearchParams(next);
    api<{
      deals: Deal[];
      pipeline?: PipelineOption["pipeline"];
      pipelines?: PipelineOption["pipelines"];
      members?: { id: string; name: string; isActive: boolean }[];
      error?: string;
      field?: string;
    }>(`/api/crm/deals${params.size > 0 ? `?${params.toString()}` : ""}`).then(({ ok, data }) => {
      if (ok) {
        setDeals(data.deals);
        setPipeline(data.pipeline ?? null);
        setPipelines(data.pipelines ?? []);
        if (Array.isArray(data.members)) setMembers(data.members);
        setFilterError("");
        setError("");
        return;
      }
      // A filter the server refused is the reader's own control, so it is named
      // beside the control rather than swapped for the generic failure line —
      // and the list keeps whatever it was showing, because blanking it would
      // read as "no deals match" when the truth is "that filter is not valid".
      if (data.error === "bad_filter") {
        setFilterError(dealViewErrorLine(data.field ?? ""));
        return;
      }
      setError("بارگذاری قیف فروش ناموفق بود.");
    });
  }, []);
  useEffect(() => load(filters), [load, filters]);

  // `/crm/deals?deal=<id>` is how the customer timeline and other screens hand
  // a specific deal over (see `customer-timeline-service.ts`). Without this,
  // that link lands on the generic board and the deal it promised is nowhere
  // to be found — the same convention the directory's `?customer=` follows.
  useEffect(() => {
    const dealId = searchParams.get("deal");
    if (!dealId || !deals) return;
    const target = deals.find((deal) => deal.id === dealId);
    if (target) {
      setEditing(target);
      const url = new URL(window.location.href);
      url.searchParams.delete("deal");
      window.history.replaceState(null, "", url.toString());
    }
  }, [searchParams, deals]);

  const move = async (dealId: string, stage: PipelineStageOption, lostReason?: string) => {
    // Optimistic: the card follows the cursor, and a failure re-reads the
    // server's truth rather than leaving the board lying. The optimistic write
    // sets both the canonical id and the compatibility key, so the card lands
    // in the column the user dropped it on even before the response arrives.
    setDeals(
      (current) =>
        current?.map((deal) =>
          deal.id === dealId
            ? {
                ...deal,
                stageId: stage.id,
                stage: (stage.legacyKey ?? (stage.outcome === "won" ? "won" : stage.outcome === "lost" ? "lost" : "lead")) as DealStage,
              }
            : deal,
        ) ?? current,
    );
    const { ok, data } = await api<{ error?: string }>(`/api/crm/deals/${dealId}`, {
      method: "PATCH",
      body: JSON.stringify({ stageId: stage.id, lostReason }),
    });
    if (!ok) setError(errorMessage(data.error));
    load(filters);
  };

  /**
   * The one gate every stage change passes through, whether it came from a
   * drag or the fallback menu. Moving *into* «از دست رفته» asks why first — a
   * card that lands there with no reason is a loss report nobody can read
   * later, and the edit dialog already treats the reason as part of that
   * stage, not an afterthought.
   */
  const requestStageChange = (dealId: string, stage: PipelineStageOption) => {
    if (stage.outcome === "lost") {
      setPendingLostId(dealId);
      setPendingLostStage(stage);
      return;
    }
    void move(dealId, stage);
  };

  if (!deals) {
    return <SectionCardSkeleton rows={4} />;
  }

  /**
   * The board's columns.
   *
   * From the pipeline when the API returned one; from the seeded six only when
   * it did not (a tenant whose pipeline could not be read). The fallback exists
   * so the screen degrades to the board people had rather than to an empty
   * page, and it is marked by the legacy `stage` key on each column, which is
   * exactly what a pre-0157 deal carries.
   */
  const columns: PipelineStageOption[] =
    pipeline && pipeline.stages.length > 0
      ? pipeline.stages.filter((stage) => stage.isActive || deals.some((deal) => deal.stageId === stage.id))
      : LEGACY_COLUMNS;

  const columnFor = (deal: Deal): PipelineStageOption | undefined => {
    if (deal.stageId) return columns.find((stage) => stage.id === deal.stageId);
    // A deal written before 0157 (or by a legacy-shaped caller) has no stage
    // id: match it on the compatibility key, which is what migration 0157
    // itself used to point those rows at their stage.
    return columns.find((stage) => stage.legacyKey === deal.stage);
  };

  const open = deals.filter((deal) => {
    const column = columnFor(deal);
    return column ? column.outcome === "open" : deal.stage !== "won" && deal.stage !== "lost";
  });
  const weighted = weightedPipelineValue(open);
  const rawValue = open.reduce((sum, deal) => sum + deal.valueRial, 0);
  const pendingLostDeal = pendingLostId ? deals.find((deal) => deal.id === pendingLostId) ?? null : null;

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>

      {/* What is stuck and what is worth the most, before the board itself:
          «کدام معامله را باید جلو ببرم؟» is the question the fold answers. */}
      <CrmTodayQueues section="deals" title="معامله‌های نیازمند توجه" />

      {/* Named filter sets over this screen. The bar hands its filters back
          here and this screen applies every one of them — the board and the
          list are two renderings of the same filtered rows, which is what lets
          a shared view («مذاکره‌های بزرگ») show what it says. */}
      <SavedViewsBar
        entity="deals"
        current={dealViewQuery(filters)}
        onApply={(applied) =>
          setFilters((current) => ({ ...current, ...normaliseAppliedFilters(applied) }))
        }
        canSave={canManage}
        onNotice={setInfo}
      />

      {filterError ? <ErrorBox>{filterError}</ErrorBox> : null}
      {info ? <InfoBox>{info}</InfoBox> : null}

      <SectionCard
        title={
          <CrmCardHeading kicker="معامله و فروش" title="قیف فروش" />
        }
        description={`مرحله‌ها از تنظیمات همین برنامه می‌آیند${pipeline ? ` (${pipeline.name})` : ""}. کارت‌ها را بکشید یا از منوی «جابه‌جایی» استفاده کنید؛ رسیدن به مرحلهٔ «برنده» هیچ سندی ثبت نمی‌کند.`}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-1">
            {pipelines.length > 1 ? (
              <select
                className={`${inputClass} h-9 w-auto`}
                value={pipeline?.id ?? ""}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, pipelineId: event.target.value }))
                }
                aria-label="انتخاب قیف فروش"
              >
                {pipelines.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                    {entry.isDefault ? " (پیش‌فرض)" : ""}
                  </option>
                ))}
              </select>
            ) : null}
            {/* Board or list: the same rows, the same filters. The board is
                where deals are moved; the list is where they are *read*
                («کدام معامله بزرگ‌تر است؟»), and it is the only layout that
                scrolls sensibly on a phone. */}
            <div
              role="group"
              aria-label="نمایش"
              className="flex shrink-0 items-center rounded-xl border border-border/80 p-0.5"
            >
              <Button
                type="button"
                variant={layout === "board" ? "outline" : "ghost"}
                size="sm"
                aria-pressed={layout === "board"}
                onClick={() => setLayout("board")}
              >
                تخته
              </Button>
              <Button
                type="button"
                variant={layout === "list" ? "outline" : "ghost"}
                size="sm"
                aria-pressed={layout === "list"}
                onClick={() => setLayout("list")}
              >
                فهرست
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => load(filters)}
              aria-label="بازخوانی"
            >
              <RefreshCwIcon aria-hidden="true" className="size-4" />
            </Button>
            <Button type="button" onClick={() => setEditing("new")}>
              <PlusIcon aria-hidden="true" className="size-4" />
              معاملهٔ جدید
            </Button>
          </div>
        }
      >
        <DealFilterBar
          filters={filters}
          stages={columns}
          members={members}
          onChange={setFilters}
        />

        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">ارزش خام معامله‌های باز</p>
            <p className="mt-1 font-semibold text-foreground">{money.format(rawValue)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">ارزش وزنی (بر پایهٔ احتمال)</p>
            <p className="mt-1 font-semibold text-teal-700 dark:text-teal-300">{money.format(weighted)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">نرخ موفقیت</p>
            <p className="mt-1 font-semibold text-foreground">
              {toPersianDigits(String(winRate(deals)))}٪
            </p>
          </div>
        </div>

        {deals.length === 0 ? (
          <EmptyState
            title={hasDealViewFilters(filters) ? "چیزی با این فیلترها پیدا نشد" : undefined}
          >
            {hasDealViewFilters(filters)
              ? "فیلترها را بردارید تا همهٔ معامله‌ها را ببینید."
              : "هنوز معامله‌ای ثبت نشده است."}
          </EmptyState>
        ) : layout === "list" ? (
          <DealList
            deals={deals}
            columnFor={columnFor}
            money={money}
            onEdit={(deal) => setEditing(deal)}
          />
        ) : (
          <div className="overflow-x-auto">
            <div className="flex min-w-max gap-3">
              {columns.map((stage) => {
                const column = deals.filter((deal) => columnFor(deal)?.id === stage.id);
                const columnValue = column.reduce((sum, deal) => sum + deal.valueRial, 0);
                return (
                  <div
                    key={stage.id}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragging) requestStageChange(dragging, stage);
                      setDragging(null);
                    }}
                    className="flex w-64 shrink-0 flex-col gap-2 rounded-2xl border border-border/80 bg-muted/60 p-3"
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-foreground">{stage.name}</span>
                        <StatusBadge tone={OUTCOME_TONES[stage.outcome]}>
                          {formatPersianNumber(column.length)}
                        </StatusBadge>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {formatPersianNumber(stage.defaultProbability)}٪ · {money.format(columnValue)}
                      </p>
                    </div>

                    {column.map((deal) => (
                      <article
                        key={deal.id}
                        draggable
                        onDragStart={() => setDragging(deal.id)}
                        onDragEnd={() => setDragging(null)}
                        className={`cursor-grab p-3 active:cursor-grabbing ${cardClass}`}
                      >
                        <div className="flex items-start justify-between gap-1">
                          <button
                            type="button"
                            onClick={() => setEditing(deal)}
                            className="block min-w-0 flex-1 text-start text-sm font-medium text-foreground hover:underline"
                          >
                            <span className="block truncate">{deal.title}</span>
                          </button>
                          {/* HTML5 drag-and-drop has no touch/keyboard path, so a
                              phone or a keyboard-only user needs a real way to
                              move a card — not just a mouse gesture. */}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="-mt-1 -me-1 shrink-0"
                                aria-label={`جابه‌جایی «${deal.title}»`}
                              >
                                <ChevronDownIcon aria-hidden="true" className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="min-w-44">
                              <DropdownMenuLabel className="flex items-center gap-1.5 text-xs">
                                <ArrowLeftRightIcon aria-hidden="true" className="size-3.5" />
                                انتقال به مرحله
                              </DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              {columns
                                .filter((target) => target.id !== columnFor(deal)?.id)
                                .map((target) => (
                                  <DropdownMenuItem
                                    key={target.id}
                                    onClick={() => requestStageChange(deal.id, target)}
                                    className={
                                      target.outcome === "lost" ? "text-destructive focus:text-destructive" : ""
                                    }
                                  >
                                    {target.name}
                                  </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        <p className="mt-1 text-sm font-semibold text-foreground/80">
                          {money.format(deal.valueRial)}
                        </p>
                        {deal.customerId ? (
                          <Link
                            href={crmCustomerHref(deal.customerId)}
                            className="mt-1 block truncate text-xs text-muted-foreground hover:underline"
                          >
                            {deal.customerName}
                          </Link>
                        ) : null}
                        {deal.expectedCloseDate ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            موعد: {toPersianDigits(formatJalali(deal.expectedCloseDate))}
                          </p>
                        ) : null}
                        {columnFor(deal)?.outcome === "won" && deal.orderId ? (
                          <Link
                            href={crmDealOrderHref(deal.orderId)}
                            className="mt-1 flex items-center gap-1 text-xs text-teal-700 hover:underline dark:text-teal-300"
                          >
                            <ReceiptTextIcon aria-hidden="true" className="size-3.5" />
                            سند فروش ثبت‌شده
                          </Link>
                        ) : null}
                        {columnFor(deal)?.outcome === "won" && !deal.orderId ? (
                          <button
                            type="button"
                            onClick={() => setHandoffDeal(deal)}
                            className="mt-1 flex items-center gap-1 text-xs font-medium text-amber-800 hover:underline dark:text-amber-300"
                          >
                            <ReceiptTextIcon aria-hidden="true" className="size-3.5" />
                            ثبت سند فروش
                          </button>
                        ) : null}
                        {columnFor(deal)?.outcome === "lost" && deal.lostReason ? (
                          <p className="mt-1 text-xs text-rose-700 dark:text-rose-300">{deal.lostReason}</p>
                        ) : null}
                      </article>
                    ))}

                    {column.length === 0 ? (
                      <p className="py-4 text-center text-xs text-muted-foreground">خالی</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <p className="mt-4 text-xs leading-6 text-muted-foreground">
          مبلغ معامله یک انتظار است، نه یک سند. درآمد تنها زمانی ثبت می‌شود که فاکتور یا سفارش
          واقعی تسویه شود؛ بردن یک معامله در این صفحه هیچ اثری بر دفتر حساب‌ها ندارد.
        </p>
      </SectionCard>

      {editing ? (
        <DealDialog
          deal={editing === "new" ? null : editing}
          // The pipeline's own stages, so a business that renamed, added or
          // retired a column can pick it in the form too — the board and the
          // dialog reading two different stage lists was how a deal came to be
          // filed under a column that no longer existed.
          stages={columns}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            // Re-read the pipeline that was on screen, not the default one: a
            // save must not silently move the user to another board.
            load(filters);
          }}
        />
      ) : null}

      {handoffDeal ? (
        <HandoffDialog
          deal={handoffDeal}
          onClose={() => setHandoffDeal(null)}
          onLinked={() => {
            setHandoffDeal(null);
            load(filters);
          }}
        />
      ) : null}

      {pendingLostDeal ? (
        <LostReasonDialog
          dealTitle={pendingLostDeal.title}
          onClose={() => setPendingLostId(null)}
          onConfirm={(reason) => {
            if (pendingLostStage) void move(pendingLostDeal.id, pendingLostStage, reason);
            setPendingLostId(null);
            setPendingLostStage(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The one thing a card dropped (or menu-moved) onto «از دست رفته» needs before
 * it commits: why. The full edit dialog already carries this field for a
 * *typed* stage change; this is the same question for the kanban's own
 * gesture, so a drag cannot silently produce a loss report with no reason on
 * it.
 */
function LostReasonDialog({
  dealTitle,
  onClose,
  onConfirm,
}: {
  dealTitle: string;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>«{dealTitle}» از دست رفت؟</DialogTitle>
        </DialogHeader>
        <Field label="دلیل از دست رفتن (اختیاری)">
          <input
            autoFocus
            className={inputClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثلاً قیمت بالا بود"
          />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            انصراف
          </Button>
          <Button type="button" variant="destructive" onClick={() => onConfirm(reason.trim())}>
            انتقال به «از دست رفته»
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DealDialog({
  deal,
  stages,
  onClose,
  onSaved,
}: {
  deal: Deal | null;
  /** The board's live stages, in display order. Never empty for a readable pipeline. */
  stages: PipelineStageOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const money = useMoney();
  const options = stages.length > 0 ? stages : LEGACY_COLUMNS;
  // Resolve the deal's current stage: the canonical id first, then the
  // compatibility key it carries if it predates stages-as-rows.
  const initialStage =
    (deal?.stageId ? options.find((option) => option.id === deal.stageId) : undefined) ??
    (deal ? options.find((option) => option.legacyKey === deal.stage) : undefined) ??
    options[0];
  const [title, setTitle] = useState(deal?.title ?? "");
  const [description, setDescription] = useState(deal?.description ?? "");
  const [stageId, setStageId] = useState(initialStage?.id ?? "");
  const stage = options.find((option) => option.id === stageId) ?? options[0];
  const [value, setValue] = useState(String(money.toInput(deal?.valueRial ?? 0)));
  const [probability, setProbability] = useState(
    deal?.probability === null || deal?.probability === undefined ? "" : String(deal.probability),
  );
  const [expected, setExpected] = useState(deal?.expectedCloseDate?.slice(0, 10) ?? "");
  // Assignment is a member, not a typed name: a free-text owner field is how a
  // deal ends up owned by somebody who cannot sign in, and how «مال من» becomes
  // unanswerable. The typed name is kept only as the snapshot on the row.
  const [ownerId, setOwnerId] = useState(deal?.ownerUserId ?? "");
  const [members, setMembers] = useState<{ id: string; name: string; isActive: boolean }[] | null>(null);
  const [source, setSource] = useState(deal?.source ?? "");
  const [lostReason, setLostReason] = useState(deal?.lostReason ?? "");
  const [customerId, setCustomerId] = useState<string | null>(deal?.customerId ?? null);
  const [customerName, setCustomerName] = useState(deal?.customerName ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ members: { id: string; name: string; isActive: boolean }[] }>("/api/crm/members").then(
      ({ ok, data }) => {
        if (!cancelled && ok) setMembers(data.members ?? []);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    if (!title.trim()) {
      setError(errorMessage("deal_title_required"));
      return;
    }
    const probabilityValue = probability.trim() === "" ? null : Number(toLatinDigits(probability));
    if (
      probabilityValue !== null &&
      (!Number.isFinite(probabilityValue) || probabilityValue < 0 || probabilityValue > 100)
    ) {
      setError(errorMessage("deal_probability_invalid"));
      return;
    }
    setBusy(true);
    setError("");
    // The canonical stage id when the pipeline gave us one; the compatibility
    // key only when the board is in its degraded (unreadable-pipeline) mode and
    // there is no uuid to send.
    const canonical = stage && isStageUuid(stage.id) ? { stageId: stage.id } : {};
    const legacy = stage?.legacyKey ? { stage: stage.legacyKey as DealStage } : {};
    const { ok, data } = await api<{ error?: string }>("/api/crm/deals", {
      method: "POST",
      body: JSON.stringify({
        id: deal?.id,
        // `customerId` and `orderId` ride along even though this form cannot
        // set the second one itself: the API replaces a deal's row wholesale
        // on every save, so leaving a field out of the body is how it used to
        // get silently cleared — a customer link vanishing the moment someone
        // fixed a typo in the title.
        customerId,
        title: title.trim(),
        description: description.trim(),
        ...canonical,
        ...legacy,
        valueRial: money.fromInput(Number(toLatinDigits(value).replace(/[^\d]/g, "")) || 0),
        probability: probabilityValue,
        expectedCloseDate: expected || null,
        // The member id is the ownership; the name rides along as the
        // snapshot the row keeps for history.
        ownerUserId: ownerId || null,
        ownerUser: members?.find((member) => member.id === ownerId)?.name ?? deal?.ownerUser ?? "",
        source: source.trim(),
        lostReason: stage?.outcome === "lost" ? lostReason.trim() : null,
        orderId: deal?.orderId ?? null,
      }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    onSaved();
  };

  const remove = async () => {
    if (!deal || !window.confirm(`«${deal.title}» حذف شود؟`)) return;
    const { ok } = await api(`/api/crm/deals/${deal.id}`, { method: "DELETE" });
    if (ok) onSaved();
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{deal ? `ویرایش ${deal.title}` : "معاملهٔ جدید"}</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>

        <Field label="عنوان">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="مشتری (اختیاری)">
          {/* Same live-directory search the activity and ticket dialogs use — a
              deal attached to a customer is what makes it show on that
              customer's 360° file and lets the pipeline link back to them. */}
          <CustomerSearchField
            selectedId={customerId}
            selectedName={customerName}
            onPick={(match) => {
              setCustomerId(match.id);
              setCustomerName(match.name);
            }}
            onClear={() => {
              setCustomerId(null);
              setCustomerName("");
            }}
            emptyText="مشتری‌ای با این نام یا شماره پیدا نشد."
          />
        </Field>
        <Field label={`مبلغ (${money.unitLabel})`} hint="انتظار فروش؛ هیچ سند حسابداری از این مبلغ ساخته نمی‌شود.">
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            allowNegative={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="۰"
          />
        </Field>
        <Field label="مرحله">
          <select
            className={inputClass}
            value={stage?.id ?? ""}
            onChange={(e) => setStageId(e.target.value)}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
                {option.isActive ? "" : " (غیرفعال)"}
              </option>
            ))}
          </select>
        </Field>
        {stage?.outcome === "won" && deal?.orderId ? (
          <p className="mb-4 -mt-2 text-xs text-muted-foreground">
            این معامله به{" "}
            <Link href={crmDealOrderHref(deal.orderId)} className="text-teal-700 hover:underline dark:text-teal-300">
              سفارش تسویه‌شده
            </Link>{" "}
            وصل است.
          </p>
        ) : null}
        {stage?.outcome === "lost" ? (
          <Field label="دلیل از دست رفتن">
            <input
              className={inputClass}
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
            />
          </Field>
        ) : null}
        <Field
          label="احتمال موفقیت (٪)"
          hint={
            stage
              ? `خالی بگذارید تا احتمال پیش‌فرض این مرحله (${toPersianDigits(String(stage.defaultProbability))}٪) به کار برود.`
              : "خالی بگذارید تا احتمال پیش‌فرض این مرحله به کار برود."
          }
        >
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            allowNegative={false}
            grouping={false}
            value={probability}
            onChange={(e) => setProbability(e.target.value)}
            placeholder="۰"
          />
        </Field>
        <Field label="موعد پیش‌بینی‌شده (اختیاری)">
          <JalaliDatePicker value={expected} onChange={setExpected} placeholder="بدون موعد" />
        </Field>
        <Field
          label="مسئول پیگیری (اختیاری)"
          hint="از میان اعضای کسب‌وکار انتخاب می‌شود تا «کارهای من» همیشه یک معنی داشته باشد."
        >
          <select
            className={inputClass}
            value={ownerId}
            onChange={(event) => setOwnerId(event.target.value)}
          >
            <option value="">بدون مسئول</option>
            {(members ?? []).map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
                {member.isActive ? "" : " (غیرفعال)"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="منبع (اختیاری)" hint="این معامله از کجا شروع شد؛ مثلاً اینستاگرام، معرفی مشتری یا تماس تلفنی.">
          <input
            className={inputClass}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="مثلاً اینستاگرام"
          />
        </Field>
        <Field label="توضیح (اختیاری)">
          <textarea
            className={inputClass}
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <DialogFooter>
          {deal ? (
            <Button
              type="button"
              variant="ghost"
              onClick={remove}
              disabled={busy}
              className="me-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              حذف
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            انصراف
          </Button>
          <Button type="button" onClick={save} disabled={busy}>
            ذخیره
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * «ثبت سند فروش» — the won-deal handoff, in a dialog.
 *
 * This is the whole of the CRM → Accounting integration on the screen the deal
 * lives on, and it is a *round trip through a human* on purpose:
 *
 *  1. The dialog asks `GET /api/crm/deals/<id>/handoff` whether the deal is
 *     ready and shows **every** blocker at once — no customer, not won, the
 *     customer archived, already linked. Learning them one round trip at a time
 *     is how the same field gets fixed twice.
 *  2. «باز کردن فرم فروش» opens Accounting with the customer and deal
 *     pre-filled, in a new tab. The CRM cannot create the document and does not
 *     pretend to: an invoice needs stock, pricing, tax and payment terms, and
 *     the person issuing it is answerable for those.
 *  3. When the document exists, its number is pasted back here and
 *     `linkDealToSalesDocument` attaches it — verifying the order belongs to
 *     this business first, recording `createdByCrm: false` in the audit trail,
 *     and idempotently, so a retried request after a success is not an error.
 *
 * Recording that a sale happened is not the same act as claiming one did. That
 * distinction is the reason the card's value is a forecast and the ledger's is
 * a fact, and it is why «برنده» posts nothing.
 */
function HandoffDialog({
  deal,
  onClose,
  onLinked,
}: {
  deal: Deal;
  onClose: () => void;
  onLinked: () => void;
}) {
  const money = useMoney();
  const [handoff, setHandoff] = useState<{
    href: string;
    suggestedValueRial: number;
    customerName: string;
    blockers: { code: string; message: string }[];
  } | null>(null);
  const [orderId, setOrderId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ handoff?: typeof handoff; error?: string }>(`/api/crm/deals/${deal.id}/handoff`).then(
      ({ ok, data }) => {
        if (cancelled) return;
        if (ok && data.handoff) setHandoff(data.handoff);
        else setError(errorMessage(data.error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [deal.id]);

  const link = async () => {
    if (!orderId.trim() || busy) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>(`/api/crm/deals/${deal.id}/handoff`, {
      method: "POST",
      body: JSON.stringify({ orderId: orderId.trim() }),
    });
    setBusy(false);
    if (ok) {
      onLinked();
      return;
    }
    setError(errorMessage(data.error));
  };

  const blocked = (handoff?.blockers.length ?? 0) > 0;

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>ثبت سند فروش برای «{deal.title}»</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>

        <p className="text-sm leading-6 text-muted-foreground">
          این صفحه سند حسابداری نمی‌سازد و مبلغ معامله را در دفتر ثبت نمی‌کند. فاکتور یا سفارش در برنامهٔ
          حسابداری صادر می‌شود؛ اینجا فقط وصل می‌شود تا بعداً بدانیم این معامله به کدام سند رسید.
        </p>

        {handoff === null ? (
          <EmptyState>در حال بررسی وضعیت این معامله…</EmptyState>
        ) : blocked ? (
          <ul className="space-y-2">
            {handoff.blockers.map((blocker) => (
              <li key={blocker.code}>
                <InfoBox>{blocker.message}</InfoBox>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <InfoBox>
              مبلغ پیشنهادی از این معامله {money.format(handoff.suggestedValueRial)} است؛ ولی مبلغ نهایی را
              فرم فروش تعیین می‌کند.
            </InfoBox>
            <Button type="button" variant="outline" className="min-h-11 w-full" asChild>
              <a href={handoff.href} target="_blank" rel="noreferrer">
                باز کردن فرم فروش در حسابداری
              </a>
            </Button>
            <Field
              label="شمارهٔ سند فروش"
              hint="پس از صدور فاکتور یا سفارش در حسابداری، شناسهٔ آن را اینجا بچسبانید."
            >
              <input
                className={inputClass}
                value={orderId}
                onChange={(event) => setOrderId(event.target.value)}
                dir="ltr"
                placeholder=""
              />
            </Field>
          </>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            بستن
          </Button>
          <Button type="button" onClick={link} disabled={busy || blocked || orderId.trim() === ""}>
            وصل کردن سند
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A saved view's filters, back in the screen's own document.
 *
 * The stored vocabulary and the live one are the same keys, but a stored view
 * may carry only some of them; anything absent is reset rather than left from
 * the previous view, because applying «مذاکره‌های بزرگ» after having searched
 * for a name must not show one person's deals filtered by last week's word.
 * `open` is stored as `"1"`, and amounts arrive as strings in Toman — exactly
 * what `PersianNumberInput` shows.
 */
function normaliseAppliedFilters(applied: Record<string, string>): DealViewFilters {
  const toman = (raw: string | undefined) => {
    if (!raw) return null;
    const parsed = Number(toLatinDigits(raw).replace(/[^\d]/g, ""));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  return {
    q: applied.q ?? "",
    stageId: applied.stageId ?? "",
    pipelineId: applied.pipelineId ?? "",
    owner: applied.owner ?? "",
    openOnly: applied.open === "1",
    minToman: toman(applied.minValue),
    maxToman: toman(applied.maxValue),
  };
}

/**
 * The deals filters, as controls.
 *
 * Every control writes into the one document the request is built from, and the
 * chips under it are described *from* that document — so a filter that is on is
 * a filter that is visible, and removing it is one click rather than a hunt
 * through the form. The count is the honest one (`dealViewQuery`), so a chip
 * that resets everything can say how much it is about to reset.
 */
function DealFilterBar({
  filters,
  stages,
  members,
  onChange,
}: {
  filters: DealViewFilters;
  stages: PipelineStageOption[];
  members: { id: string; name: string; isActive: boolean }[];
  onChange: (next: DealViewFilters) => void;
}) {
  const chips = describeDealView(filters, {
    stageName: (id) => stages.find((stage) => stage.id === id)?.name ?? null,
    memberName: (id) => members.find((member) => member.id === id)?.name ?? null,
  });
  const count = dealViewFilterCount(filters);

  return (
    <div className="mb-4 grid gap-3 rounded-2xl border border-border/80 p-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="min-w-0">
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="deal-search">
            جست‌وجو
          </label>
          <input
            id="deal-search"
            className={inputClass}
            value={filters.q}
            onChange={(event) => onChange({ ...filters, q: event.target.value })}
            placeholder="عنوان معامله یا نام مشتری"
          />
        </div>

        <div className="min-w-0">
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="deal-stage">
            مرحله
          </label>
          <select
            id="deal-stage"
            className={inputClass}
            value={filters.stageId}
            onChange={(event) => onChange({ ...filters, stageId: event.target.value })}
          >
            <option value="">همهٔ مرحله‌ها</option>
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-0">
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="deal-owner">
            مسئول
          </label>
          <select
            id="deal-owner"
            className={inputClass}
            value={filters.owner}
            onChange={(event) => onChange({ ...filters, owner: event.target.value })}
          >
            <option value="">همه</option>
            <option value="mine">معامله‌های من</option>
            <option value="none">بدون مسئول</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
                {member.isActive ? "" : " (غیرفعال)"}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="min-w-0">
            <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="deal-min">
              از (تومان)
            </label>
            <PersianNumberInput
              id="deal-min"
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              allowNegative={false}
              grouping
              value={filters.minToman === null ? "" : String(filters.minToman)}
              onChange={(event) =>
                onChange({ ...filters, minToman: readToman(event.target.value) })
              }
              placeholder="۰"
            />
          </div>
          <div className="min-w-0">
            <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="deal-max">
              تا (تومان)
            </label>
            <PersianNumberInput
              id="deal-max"
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              allowNegative={false}
              grouping
              value={filters.maxToman === null ? "" : String(filters.maxToman)}
              onChange={(event) =>
                onChange({ ...filters, maxToman: readToman(event.target.value) })
              }
              placeholder="بی‌نهایت"
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-h-10 items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="size-4 rounded border-input"
            checked={filters.openOnly}
            onChange={(event) => onChange({ ...filters, openOnly: event.target.checked })}
          />
          فقط معامله‌های باز
        </label>
        <span className="text-xs text-muted-foreground">
          {count > 0
            ? `${toPersianDigits(count)} فیلتر فعال`
            : "بدون فیلتر — همهٔ معامله‌ها"}
        </span>
        {count > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(EMPTY_DEAL_VIEW_FILTERS)}
          >
            برداشتن فیلترها
          </Button>
        ) : null}
      </div>

      {chips.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="فیلترهای اعمال‌شده">
          {chips.map((chip) => (
            <li key={chip}>
              <StatusBadge tone="neutral">{chip}</StatusBadge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A typed Toman amount, or `null` for "unbounded". */
function readToman(raw: string): number | null {
  const parsed = Number(toLatinDigits(raw).replace(/[^\d]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The list view: the same filtered rows as the board, in the shape a phone can
 * scroll and a person can sort by eye.
 *
 * The board answers «کدام معامله را جلو ببرم؟»; the list answers «کدام معامله
 * بزرگ‌تر است؟» — sorted by value, with the stage, the owner and the close date
 * on one line. Rows are buttons that open the same edit dialog the cards do, so
 * there is one form for a deal whichever layout it was found in.
 */
function DealList({
  deals,
  columnFor,
  money,
  onEdit,
}: {
  deals: Deal[];
  columnFor: (deal: Deal) => PipelineStageOption | undefined;
  money: { format: (rial: number) => string };
  onEdit: (deal: Deal) => void;
}) {
  const sorted = [...deals].sort((a, b) => b.valueRial - a.valueRial || a.title.localeCompare(b.title, "fa"));
  const total = sorted.reduce((sum, deal) => sum + deal.valueRial, 0);

  return (
    <div className="grid gap-2">
      <p className="text-xs text-muted-foreground">
        {toPersianDigits(sorted.length)} معامله، به ترتیب ارزش — جمع {money.format(total)}
      </p>
      <ul className="grid gap-2">
        {sorted.map((deal) => {
          const stage = columnFor(deal);
          return (
            <li key={deal.id}>
              <button
                type="button"
                onClick={() => onEdit(deal)}
                className={`w-full p-3 text-start ${cardClass}`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium text-foreground">
                    {deal.title}
                  </span>
                  <span className="shrink-0 text-sm font-semibold text-foreground">
                    {money.format(deal.valueRial)}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {stage ? (
                    <StatusBadge tone={OUTCOME_TONES[stage.outcome]}>{stage.name}</StatusBadge>
                  ) : (
                    <StatusBadge tone="neutral">{deal.stage}</StatusBadge>
                  )}
                  {deal.customerName ? <span className="truncate">{deal.customerName}</span> : null}
                  {/* Both halves of ownership, and the id first: a row owned by
                      a member says who, and a legacy row says the name it kept. */}
                  <span>
                    {deal.ownerUserId
                      ? (deal.ownerUser || "بدون نام")
                      : deal.ownerUser
                        ? `${deal.ownerUser} (نام ثبت‌شده)`
                        : "بدون مسئول"}
                  </span>
                  {deal.expectedCloseDate ? (
                    <span>موعد: {toPersianDigits(formatJalali(deal.expectedCloseDate))}</span>
                  ) : null}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
