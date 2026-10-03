"use client";

/**
 * The Growth app's campaigns section (Phase 36b).
 *
 * The promotion engine is unchanged — one deterministic engine
 * (`src/lib/promotions.ts`) feeding both the F&B order path and the retail
 * invoice path. What this section adds around it is the management half the
 * old flat page never had: every campaign labelled with where it is in its
 * life («در حال اجرا» / «زمان‌بندی‌شده» / «پایان‌یافته» / «متوقف»), one-tap
 * pause/resume, and the effectiveness report — how often each campaign fired
 * and what it cost — sitting next to the form that creates the next one.
 *
 * ## What this screen has to get right
 *
 * The form writes rows that decide money on every sale, so its rules are not
 * cosmetic. They live in `src/lib/campaign-rules.ts` and are enforced again in
 * `promotions-service.ts` — the screen shows them early, the service is the
 * line of defence. Three failures that shaped the current shape:
 *
 *   - an empty «مبلغ» used to reach `money.parse("")`, which throws: the
 *     submit handler died before clearing `busy`, so the button stayed
 *     disabled with no message and the campaign was silently not saved;
 *   - the amount field was labelled «مبلغ» for every kind, but for a
 *     `bundle_price` the number is the set *price* of the bundle, not the
 *     discount — the same digits mean opposite things;
 *   - pause/resume POSTed the entire row back with `isActive` flipped, so a
 *     one-tap toggle rewrote every column from a possibly-stale list. It is a
 *     `PATCH` of one boolean now.
 *
 * Dates are Shamsi everywhere (`JalaliDatePicker`, `formatJalali`); only the
 * wire and storage stay Gregorian ISO.
 *
 * ## A discount rule, not an audience (issue #764)
 *
 * A promotion here is a *transaction* rule — it fires on any cart that matches
 * its products and schedule, for every customer, named or anonymous. The
 * screen used to show a CRM-segment audience picker beside this form, which
 * read as "create this discount for these customers" while nothing stored or
 * enforced that. The audience now lives only where it is real: the messaging
 * section, which sends a message to a segment and may attach a promotion. Each
 * campaign row links there («اطلاع‌رسانی با پیام»).
 *
 * The product scope *is* real: the engine has always matched `itemIds`,
 * `categoryIds`/`brandIds`, and the form now lets the owner pick them
 * (`campaign-targets.ts`) and reads the whole rule back as one sentence
 * before saving.
 */

import Link from "next/link";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
// Labels, tones and the ordered state list are the Growth app's shared
// vocabulary — this screen used to keep private copies whose tones disagreed
// with the dashboard's, so the same campaign changed colour between screens.
import {
  CAMPAIGN_STATES,
  CAMPAIGN_STATE_LABELS,
  CAMPAIGN_STATE_TONES,
  campaignStateCounts,
  classifyCampaign,
  rollingWindow,
} from "@/lib/growth-shared";
import {
  CAMPAIGN_KIND_LABELS,
  CAMPAIGN_KINDS,
  CAMPAIGN_STACKING_LABELS,
  CAMPAIGN_WEEKDAYS,
  campaignValueHint,
  campaignValueLabel,
  campaignWarnings,
  formatWeekdays,
  isPercentKind,
  needsMinQuantity,
  validateCampaignDraft,
} from "@/lib/campaign-rules";
import {
  CardTitle,
  EmptyState,
  LoadingSkeleton,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { FilterChip, FilterChipRow, SearchField } from "@/app/dashboard/filters";
import {
  CAMPAIGN_TARGET_AXIS_LABELS,
  describeCampaignScope,
  isWholeCatalogue,
  normaliseCampaignScope,
  type CampaignTargetAxis,
  type CampaignTargetCatalogue,
  type CampaignTargetOption,
} from "@/lib/campaign-targets";
import { growthSectionHref } from "./growth-routes";
import {
  api,
  ErrorBox,
  errorMessage,
  Field,
  InfoBox,
  inputClass,
} from "@/app/dashboard/ui";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";

interface PromotionRow {
  id: string;
  name: string;
  kind: "percent" | "amount" | "bundle_price" | "buy_x_get_y";
  value: number;
  minQuantity: number | null;
  itemIds: string[];
  brandIds: string[];
  categoryIds: string[];
  activeFrom: string | null;
  activeTo: string | null;
  daysOfWeek: number[];
  timeFrom: string | null;
  timeTo: string | null;
  priority: number;
  stacking: "exclusive" | "stackable";
  isActive: boolean;
}

interface EffectivenessRow {
  promotionId: string;
  promotionName: string;
  applications: number;
  totalDiscountRial: number;
}

/**
 * The filters the list offers: «همه» first, then the life-cycle states in
 * `CAMPAIGN_STATES`'s own order, so this bar can never offer a different set —
 * or a different order — from the dashboard's badge row.
 */
const STATE_FILTERS = ["all", ...CAMPAIGN_STATES] as const;
type StateFilter = (typeof STATE_FILTERS)[number];

const STATE_FILTER_LABELS: Record<StateFilter, string> = {
  all: "همه",
  ...CAMPAIGN_STATE_LABELS,
};

export function CampaignsSection({ canManage }: { canManage: boolean }) {
  const money = useMoney();
  const [promotions, setPromotions] = useState<PromotionRow[] | null>(null);
  const [effect, setEffect] = useState<EffectivenessRow[] | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [filter, setFilter] = useState<StateFilter>("all");
  /** The campaign whose toggle is in flight, so only that row's button is busy. */
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    const [list, report] = await Promise.all([
      api<{ promotions: PromotionRow[] }>("/api/promotions"),
      // The effectiveness report over the same rolling window the dashboard's
      // KPIs use, so the two screens never disagree about "last month".
      (() => {
        const { from, to } = rollingWindow(new Date().toISOString().slice(0, 10));
        return api<{ rows: EffectivenessRow[] }>(`/api/promotions/reports?from=${from}&to=${to}`);
      })(),
    ]);

    // A failed list is a real failure state: leaving `promotions` null left the
    // screen on its skeleton for ever, with no message and nothing to retry.
    if (list.ok) setPromotions(list.data.promotions ?? []);
    else {
      setPromotions([]);
      setLoadFailed(true);
      setError(errorMessage((list.data as { error?: string })?.error));
    }
    setEffect(report.ok ? (report.data.rows ?? []) : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const today = new Date().toISOString().slice(0, 10);

  async function toggle(promotion: PromotionRow) {
    setError("");
    setDone("");
    setTogglingId(promotion.id);
    const nextActive = !promotion.isActive;

    // One boolean, not the whole row: a full re-POST would overwrite any change
    // made since this list was read, and a row stored before today's validation
    // rules could no longer be switched off at all.
    const { ok, data } = await api<{ error?: string; message?: string }>("/api/promotions", {
      method: "PATCH",
      body: JSON.stringify({ id: promotion.id, isActive: nextActive }),
    });
    setTogglingId(null);

    if (!ok) {
      setError(data.message ?? errorMessage(data.error) ?? "تغییر وضعیت کمپین ناموفق بود.");
      return;
    }
    setDone(nextActive ? "کمپین فعال شد." : "کمپین متوقف شد.");
    await load();
  }

  const states = useMemo(
    () => (promotions ?? []).map((p) => classifyCampaign(p, today)),
    [promotions, today],
  );

  if (!promotions) return <SectionCardSkeleton rows={4} />;

  const counts = campaignStateCounts(states);

  const rows = promotions
    .map((promotion, index) => ({ promotion, state: states[index] }))
    .filter(({ state }) => filter === "all" || state === filter);

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>
      {done ? <InfoBox>{done}</InfoBox> : null}

      <InfoBox>
        کمپین تخفیف یک قاعدهٔ فروش است: روی هر سبدی که کالا و زمانش بخورد اعمال می‌شود، برای همهٔ مشتریان. برای
        رساندن آن به یک گروه از مشتریان، از «اطلاع‌رسانی با پیام» کنار هر کمپین استفاده کنید.
      </InfoBox>

      <div className={canManage ? "grid gap-4 lg:grid-cols-2" : "grid gap-4"}>
        {canManage ? (
          <PromotionForm
            onSaved={(m) => {
              setDone(m);
              setError("");
              void load();
            }}
            onError={(m) => {
              setError(m);
              setDone("");
            }}
          />
        ) : null}
        <SectionCard
          title={<CardTitle eyebrow="اثربخشی کمپین" title="اثربخشی کمپین‌ها" />}
          description="چند بار هر کمپین روی فروش اعمال شد و چقدر تخفیف داد — ۳۰ روز گذشته"
        >
          {!effect || effect.length === 0 ? (
            <EmptyState>هنوز کمپینی روی فروشی اعمال نشده است.</EmptyState>
          ) : (
            <ul className="divide-y divide-border/80 text-sm">
              {effect.map((row) => (
                <li
                  key={row.promotionId}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-medium text-foreground">{row.promotionName}</span>
                    {/* `ms-2` (logical) rather than `mr-2`: the two render
                        identically under this RTL page, but the logical form
                        stays correct if the subtree is ever rendered LTR. */}
                    <span className="ms-2 text-xs text-muted-foreground">
                      {formatPersianNumber(row.applications)} بار اعمال
                    </span>
                  </div>
                  <span className="shrink-0 font-semibold text-amber-700 dark:text-amber-300">
                    {money.format(row.totalDiscountRial)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            تخفیف کمپین همان‌جا در سند فروش می‌نشیند که خط تخفیف‌خورده ثبت می‌شود؛ این گزارش فقط همان اعداد را
            جمع می‌زند، حساب دیگری باز نمی‌کند.
          </p>
        </SectionCard>
      </div>

      {/*
        The description reads «۳ در حال اجرا · ۱ زمان‌بندی‌شده · …», built from
        the shared labels so the summary line cannot name a state differently
        from the chip directly beside it — which is what four hand-typed
        labels allowed.
      */}
      <SectionCard
        title={<CardTitle eyebrow="مدیریت کمپین‌ها" title="کمپین‌ها" />}
        description={CAMPAIGN_STATES.map(
          (state) => `${formatPersianNumber(counts[state])} ${CAMPAIGN_STATE_LABELS[state]}`,
        ).join(" · ")}
        actions={
          promotions.length > 0 ? (
            /*
              `w-full sm:w-auto` matters: SectionCard wraps its actions in a
              `shrink-0` box and clips its own overflow, so five chips at their
              max-content width would be cut off the side of the card on a
              phone. Full width below `sm` gives them a row of their own to
              wrap inside.
            */
            <FilterChipRow label="فیلتر وضعیت کمپین" className="w-full gap-1.5 sm:w-auto">
              {STATE_FILTERS.map((key) => (
                <FilterChip
                  key={key}
                  selected={filter === key}
                  onClick={() => setFilter(key)}
                  className="text-xs"
                >
                  {STATE_FILTER_LABELS[key]}
                  {key === "all" ? "" : ` (${formatPersianNumber(counts[key])})`}
                </FilterChip>
              ))}
            </FilterChipRow>
          ) : null
        }
      >
        {loadFailed ? (
          <div className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            <p>خواندن فهرست کمپین‌ها ممکن نشد.</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
              تلاش دوباره
            </Button>
          </div>
        ) : promotions.length === 0 ? (
          <EmptyState>هنوز کمپینی تعریف نشده است.</EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState>در این وضعیت کمپینی نیست.</EmptyState>
        ) : (
          <ul className="divide-y divide-border/80 text-sm">
            {rows.map(({ promotion: p, state }) => {
              const weekdays = formatWeekdays(p.daysOfWeek);
              return (
                <li
                  key={p.id}
                  className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 py-3"
                >
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="flex flex-wrap items-center gap-2 leading-6">
                      <span className="font-medium text-foreground break-words">{p.name}</span>
                      <StatusBadge tone={CAMPAIGN_STATE_TONES[state]}>
                        {CAMPAIGN_STATE_LABELS[state]}
                      </StatusBadge>
                    </p>
                    <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                      {CAMPAIGN_KIND_LABELS[p.kind]} ·{" "}
                      {isPercentKind(p.kind)
                        ? `${formatPersianNumber(p.value)}٪`
                        : money.format(p.value)}
                      {needsMinQuantity(p.kind) && p.minQuantity
                        ? ` · از ${formatPersianNumber(p.minQuantity)} عدد`
                        : ""}{" "}
                      · اولویت {formatPersianNumber(p.priority)} ·{" "}
                      {CAMPAIGN_STACKING_LABELS[p.stacking]}
                      {p.activeFrom || p.activeTo ? (
                        <>
                          {" · "}
                          {p.activeFrom ? toPersianDigits(formatJalali(p.activeFrom)) : "…"} تا{" "}
                          {p.activeTo ? toPersianDigits(formatJalali(p.activeTo)) : "…"}
                        </>
                      ) : null}
                      {p.timeFrom || p.timeTo ? (
                        <>
                          {" · "}
                          {toPersianDigits(p.timeFrom ?? "…")} تا {toPersianDigits(p.timeTo ?? "…")}
                        </>
                      ) : null}
                      {weekdays ? ` · ${weekdays}` : ""}
                      {isWholeCatalogue(p) ? "" : " · محدود به کالاهای انتخاب‌شده"}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                  <Button asChild variant="ghost" size="sm" className="min-h-11">
                    <Link href={`${growthSectionHref("messaging")}?promotion=${encodeURIComponent(p.id)}`}>
                      اطلاع‌رسانی با پیام
                    </Link>
                  </Button>
                  {canManage ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11 shrink-0"
                    /*
                      An ended campaign can still be switched off, and a paused
                      one can still be resumed: `ended` describes the date
                      window, not the switch. Disabling the button here left a
                      campaign whose window has closed permanently marked
                      «فعال» with no way to change it.
                    */
                    disabled={togglingId === p.id}
                    aria-label={`${p.isActive ? "توقف" : "فعال‌سازی"} کمپین ${p.name}`}
                    onClick={() => void toggle(p)}
                  >
                    {togglingId === p.id ? "در حال ثبت…" : p.isActive ? "توقف" : "فعال‌سازی"}
                  </Button>
                  ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

/**
 * The builder's steps (issue #764). A promotion has no "goal" field and no
 * audience — it is a transaction rule — so the steps are exactly the parts the
 * engine stores, followed by a plain-language review. Distribution is offered
 * after saving: a message campaign carries the new promotion to a segment.
 */
const BUILDER_STEPS = [
  { key: "offer", label: "پیشنهاد" },
  { key: "products", label: "کالاها" },
  { key: "schedule", label: "زمان‌بندی" },
  { key: "review", label: "بازبینی" },
] as const;

function PromotionForm({ onSaved, onError }: { onSaved: (m: string) => void; onError: (m: string) => void }) {
  const money = useMoney();
  const [step, setStep] = useState(0);
  /** The campaign just saved, so the last screen can offer to distribute it. */
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PromotionRow["kind"]>("percent");
  const [value, setValue] = useState("");
  const [minQuantity, setMinQuantity] = useState("");
  const [priority, setPriority] = useState("0");
  const [stacking, setStacking] = useState<PromotionRow["stacking"]>("exclusive");
  const [activeFrom, setActiveFrom] = useState("");
  const [activeTo, setActiveTo] = useState("");
  const [timeFrom, setTimeFrom] = useState("");
  const [timeTo, setTimeTo] = useState("");
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
  /** «همه» or the one axis the owner is narrowing by. */
  const [scopeAxis, setScopeAxis] = useState<"all" | CampaignTargetAxis>("all");
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  const [catalogue, setCatalogue] = useState<CampaignTargetCatalogue | null>(null);
  const [catalogueFailed, setCatalogueFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Problems are shown only after a submit attempt, not while first typing. */
  const [showProblems, setShowProblems] = useState(false);
  const problemRef = useRef<HTMLDivElement>(null);

  /**
   * The amount is entered in the business's display unit (Toman or Rial) and
   * stored as integer Rial. Percent is not money and must never go through the
   * money parser — «۲۰» would become 200 Rial.
   */
  const valueForApi = (): number | null => {
    const raw = value.trim();
    if (raw === "") return null;
    if (isPercentKind(kind)) {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    }
    try {
      return money.parse(raw);
    } catch {
      // Unparseable input is reported by the shared rules below as "enter an
      // amount", instead of throwing out of the submit handler.
      return null;
    }
  };

  const loadCatalogue = useCallback(async () => {
    setCatalogueFailed(false);
    const { ok, data } = await api<{ targets?: CampaignTargetCatalogue }>("/api/promotions/targets");
    if (ok && data.targets) setCatalogue(data.targets);
    else setCatalogueFailed(true);
  }, []);

  useEffect(() => {
    void loadCatalogue();
  }, [loadCatalogue]);

  const scope = normaliseCampaignScope(
    {
      itemIds: scopeAxis === "items" ? scopeIds : [],
      categoryIds: scopeAxis === "categories" ? scopeIds : [],
      brandIds: scopeAxis === "brands" ? scopeIds : [],
    },
    catalogue?.axes ?? [],
  );

  const draft = {
    name,
    kind,
    value: valueForApi(),
    minQuantity: minQuantity.trim() === "" ? null : Number(minQuantity),
    priority: priority.trim() === "" ? 0 : Number(priority),
    stacking,
    activeFrom: activeFrom || null,
    activeTo: activeTo || null,
    timeFrom: timeFrom || null,
    timeTo: timeTo || null,
    daysOfWeek,
    itemIds: scope.itemIds,
  };

  const problems = validateCampaignDraft(draft);
  const warnings = campaignWarnings(draft);
  // Per-step validation with the same shared rules: the offer step is checked
  // with an empty schedule, and the schedule step owns whatever is left.
  const offerProblems = validateCampaignDraft({
    ...draft,
    priority: 0,
    activeFrom: null,
    activeTo: null,
    timeFrom: null,
    timeTo: null,
    daysOfWeek: [],
  });
  const scheduleProblems = problems.filter((problem) => !offerProblems.includes(problem));
  const stepProblems = [offerProblems, warnings, scheduleProblems, [...problems, ...warnings]][step] ?? [];

  function goNext() {
    setShowProblems(true);
    if (stepProblems.length > 0) {
      problemRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    setShowProblems(false);
    setStep((current) => Math.min(current + 1, BUILDER_STEPS.length - 1));
  }

  function toggleDay(day: number) {
    setDaysOfWeek((current) =>
      current.includes(day) ? current.filter((d) => d !== day) : [...current, day],
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Enter in a field before the last step advances rather than saving a
    // campaign whose later steps were never seen.
    if (step < BUILDER_STEPS.length - 1) {
      goNext();
      return;
    }
    setShowProblems(true);

    // Checked before anything else: the old form only tested `name`, so an
    // empty amount reached `money.parse("")`, which throws — the handler died
    // with `busy` still true and the button stuck disabled.
    if (problems.length > 0 || warnings.length > 0) {
      problemRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }

    setBusy(true);
    onError("");
    const { ok, data } = await api<{ error?: string; message?: string; promotion?: { id: string } }>("/api/promotions", {
      method: "POST",
      // An empty scope is "the whole catalogue" to the engine — sent only when
      // the owner chose «همهٔ کالاها», never as a placeholder.
      body: JSON.stringify({ ...draft, ...scope }),
    });
    setBusy(false);

    if (!ok) {
      onError(data.message ?? errorMessage(data.error));
      return;
    }
    setName("");
    setValue("");
    setMinQuantity("");
    setDaysOfWeek([]);
    setActiveFrom("");
    setActiveTo("");
    setTimeFrom("");
    setTimeTo("");
    setScopeAxis("all");
    setScopeIds([]);
    setShowProblems(false);
    setStep(0);
    // The name is the one the owner typed; the engine's row does not echo it.
    setSaved(data.promotion ? { id: data.promotion.id, name: draft.name.trim() } : null);
    onSaved("کمپین ذخیره شد.");
  }

  const showBlockers = showProblems && stepProblems.length > 0;
  const summary = campaignSummary({
    kind,
    value: draft.value,
    minQuantity: draft.minQuantity,
    scopeText: describeCampaignScope(scope, catalogue ?? { items: [], categories: [], brands: [] }),
    daysOfWeek,
    activeFrom,
    activeTo,
    timeFrom,
    timeTo,
    formatMoney: (rial) => money.format(rial),
  });

  return (
    <SectionCard title="کمپین جدید" bodyClassName="space-y-3 p-4 sm:p-5">
      {saved ? (
        <div className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-sm dark:border-emerald-500/30 dark:bg-emerald-500/10">
          <p className="font-medium text-foreground">«{saved.name}» ذخیره شد.</p>
          <p className="text-xs leading-5 text-muted-foreground">
            قدم بعد، رساندن آن به مشتریان است: یک کمپین پیامی بسازید که همین تخفیف را به یک بخش از مشتریان اطلاع دهد.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild className="min-h-11">
              <Link href={`${growthSectionHref("messaging")}?promotion=${encodeURIComponent(saved.id)}`}>اطلاع‌رسانی با پیام</Link>
            </Button>
            <Button type="button" variant="outline" className="min-h-11" onClick={() => setSaved(null)}>
              ساخت کمپین دیگر
            </Button>
          </div>
        </div>
      ) : null}
      <ol className="flex flex-wrap gap-1.5" aria-label="مراحل ساخت کمپین">
        {BUILDER_STEPS.map((item, index) => (
          <li key={item.key}>
            <button
              type="button"
              aria-current={index === step ? "step" : undefined}
              // A finished step can be revisited; a later one is reached by «بعدی».
              disabled={index > step}
              onClick={() => setStep(index)}
              className={`min-h-11 rounded-full border px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                index === step
                  ? "border-amber-200 bg-amber-100 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200"
                  : index < step
                    ? "border-border/80 bg-card text-foreground"
                    : "border-border/80 bg-card text-muted-foreground"
              }`}
            >
              {formatPersianNumber(index + 1)}. {item.label}
            </button>
          </li>
        ))}
      </ol>
      <form onSubmit={submit} className="grid gap-3" noValidate>
        <div ref={problemRef} aria-live="polite">
          {showBlockers ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-6 text-destructive">
              <ul className="list-inside list-disc">
                {stepProblems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {step === 0 ? (
        <>
        <Field label="نام کمپین">
          <input
            className={inputClass}
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="نوع">
            <select
              className={inputClass}
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as PromotionRow["kind"]);
                // The amount means a different quantity per kind (a discount
                // vs. a set price), so keeping the old number would silently
                // change what it does.
                setValue("");
                setMinQuantity("");
              }}
            >
              {CAMPAIGN_KINDS.map((k) => (
                <option key={k} value={k}>
                  {CAMPAIGN_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={campaignValueLabel(kind, money.unitLabel)} hint={campaignValueHint(kind)}>
            <PersianNumberInput
              inputMode="numeric"
              allowDecimal={false}
              allowNegative={false}
              className={inputClass}
              dir="ltr"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
        </div>

        {needsMinQuantity(kind) ? (
          <Field
            label="حداقل تعداد برای قیمت ثابت"
            hint="بدون این عدد، کمپین هرگز روی سبد خرید اعمال نمی‌شود."
          >
            <PersianNumberInput
              inputMode="numeric"
              allowDecimal={false}
              allowNegative={false}
              className={inputClass}
              dir="ltr"
              value={minQuantity}
              onChange={(e) => setMinQuantity(e.target.value)}
            />
          </Field>
        ) : null}

        </>
        ) : null}

        {step === 2 ? (
        <>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="اولویت (بیشتر = زودتر)">
            <PersianNumberInput
              inputMode="numeric"
              allowDecimal={false}
              className={inputClass}
              dir="ltr"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            />
          </Field>
          <Field label="قانون ترکیب">
            <select
              className={inputClass}
              value={stacking}
              onChange={(e) => setStacking(e.target.value as PromotionRow["stacking"])}
            >
              <option value="exclusive">{CAMPAIGN_STACKING_LABELS.exclusive}</option>
              <option value="stackable">{CAMPAIGN_STACKING_LABELS.stackable}</option>
            </select>
          </Field>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="از تاریخ (شمسی)" hint="خالی یعنی از همین حالا">
            <JalaliDatePicker
              className={inputClass}
              value={activeFrom}
              onChange={setActiveFrom}
              ariaLabel="از تاریخ"
              placeholder="بدون محدودیت"
            />
          </Field>
          <Field label="تا تاریخ (شمسی)" hint="خالی یعنی بدون تاریخ پایان">
            <JalaliDatePicker
              className={inputClass}
              value={activeTo}
              onChange={setActiveTo}
              ariaLabel="تا تاریخ"
              placeholder="بدون محدودیت"
            />
          </Field>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="از ساعت">
            <input
              className={inputClass}
              dir="ltr"
              type="time"
              value={timeFrom}
              onChange={(e) => setTimeFrom(e.target.value)}
            />
          </Field>
          <Field label="تا ساعت">
            <input
              className={inputClass}
              dir="ltr"
              type="time"
              value={timeTo}
              onChange={(e) => setTimeTo(e.target.value)}
            />
          </Field>
        </div>

        {/*
          `as="div"`: a <label> forwards a click on its text to its first
          labelable descendant, which would press شنبه. The group names itself.
        */}
        <Field label="روزهای هفته" as="div" hint="هیچ‌کدام انتخاب نشود یعنی همهٔ روزها.">
          <div role="group" aria-label="روزهای هفته" className="flex flex-wrap gap-1.5">
            {CAMPAIGN_WEEKDAYS.map((day) => (
              <FilterChip
                key={day.value}
                selected={daysOfWeek.includes(day.value)}
                onClick={() => toggleDay(day.value)}
                className="min-h-11 min-w-11 px-3 text-xs"
              >
                {day.label}
              </FilterChip>
            ))}
          </div>
        </Field>
        </>
        ) : null}

        {step === 1 ? (
        <Field label="شامل چه کالاهایی می‌شود؟" as="div" hint="خالی گذاشتن یعنی همهٔ کالاها. استثنا (به‌جز…) را موتور تخفیف پشتیبانی نمی‌کند.">
          {catalogueFailed ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              فهرست کالاها خوانده نشد؛ کمپین روی همهٔ کالاها ذخیره می‌شود.
              <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => void loadCatalogue()}>
                تلاش دوباره
              </Button>
            </div>
          ) : !catalogue ? (
            <LoadingSkeleton rows={1} compact label="در حال بارگذاری فهرست کالاها" />
          ) : (
            <div className="space-y-2">
              <div role="radiogroup" aria-label="دامنهٔ کالاها" className="flex flex-wrap gap-1.5">
                <FilterChip
                  selected={scopeAxis === "all"}
                  onClick={() => {
                    setScopeAxis("all");
                    setScopeIds([]);
                  }}
                  className="min-h-11 px-3 text-xs"
                >
                  همهٔ کالاها
                </FilterChip>
                {catalogue.axes.map((axis) => (
                  <FilterChip
                    key={axis}
                    selected={scopeAxis === axis}
                    onClick={() => {
                      if (scopeAxis !== axis) setScopeIds([]);
                      setScopeAxis(axis);
                    }}
                    className="min-h-11 px-3 text-xs"
                  >
                    {CAMPAIGN_TARGET_AXIS_LABELS[axis]}
                  </FilterChip>
                ))}
              </div>
              {scopeAxis !== "all" ? (
                <TargetPicker
                  label={CAMPAIGN_TARGET_AXIS_LABELS[scopeAxis]}
                  options={catalogue[scopeAxis]}
                  selected={scopeIds}
                  onChange={setScopeIds}
                />
              ) : null}
            </div>
          )}
        </Field>
        ) : null}

        {step === 3 ? (
        <div aria-live="polite" className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm leading-6 text-foreground dark:border-amber-500/30 dark:bg-amber-500/10">
          <span className="block text-xs font-medium text-muted-foreground">خلاصهٔ کمپین پیش از ذخیره</span>
          {summary}
        </div>

        ) : null}

        <div className="flex flex-wrap justify-between gap-2">
          {step > 0 ? (
            <Button type="button" variant="outline" className="min-h-11" onClick={() => setStep(step - 1)}>
              قبلی
            </Button>
          ) : (
            <span />
          )}
          {step < BUILDER_STEPS.length - 1 ? (
            // A submit button, so Enter in any field advances; `submit` routes
            // every step before the last to `goNext`.
            <Button type="submit" className="min-h-11">
              بعدی: {BUILDER_STEPS[step + 1].label}
            </Button>
          ) : (
            <Button type="submit" disabled={busy} className="min-h-11">
              {busy ? "در حال ذخیره…" : "ذخیره کمپین"}
            </Button>
          )}
        </div>
      </form>
    </SectionCard>
  );
}

/**
 * A search-and-tick list over one catalogue axis. A plain list rather than a
 * combobox: a campaign usually picks a handful of rows, and ticking from a
 * filtered list works the same with a finger, a mouse and a keyboard.
 */
function TargetPicker({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: readonly CampaignTargetOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const chosen = new Set(selected);
  const matches = options
    .filter((option) => !needle || option.name.toLowerCase().includes(needle) || option.branch?.toLowerCase().includes(needle))
    .slice(0, 40);
  const nameOf = new Map(options.map((option) => [option.id, option]));
  const toggle = (id: string) => onChange(chosen.has(id) ? selected.filter((item) => item !== id) : [...selected, id]);

  if (options.length === 0) {
    return <EmptyState>موردی برای انتخاب در «{label}» وجود ندارد.</EmptyState>;
  }

  return (
    <div className="space-y-2 rounded-xl border border-border/80 p-3">
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" aria-label={`${label} انتخاب‌شده`}>
          {selected.map((id) => (
            <FilterChip key={id} selected onClick={() => toggle(id)} className="min-h-11 px-3 text-xs">
              {nameOf.get(id)?.name ?? "مورد حذف‌شده"} ✕
            </FilterChip>
          ))}
        </div>
      ) : null}
      <SearchField value={query} onChange={setQuery} label={`جست‌وجو در ${label}`} placeholder={`جست‌وجو در ${label}…`} />
      <ul className="max-h-56 overflow-y-auto text-sm" aria-label={label}>
        {matches.map((option) => (
          <li key={option.id}>
            <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 hover:bg-muted/50">
              <input type="checkbox" className="size-4" checked={chosen.has(option.id)} onChange={() => toggle(option.id)} />
              <span className="min-w-0 flex-1 truncate">{option.name}</span>
              {option.branch ? <span className="shrink-0 text-xs text-muted-foreground">{option.branch}</span> : null}
            </label>
          </li>
        ))}
        {matches.length === 0 ? <li className="px-2 py-3 text-xs text-muted-foreground">موردی پیدا نشد.</li> : null}
      </ul>
    </div>
  );
}

/** «۲۰٪ تخفیف روی کالاهای دستهٔ نوشیدنی گرم، شنبه و یکشنبه، ساعت ۱۸ تا ۲۲.» */
function campaignSummary(input: {
  kind: PromotionRow["kind"];
  value: number | null;
  minQuantity: number | null;
  scopeText: string;
  daysOfWeek: number[];
  activeFrom: string;
  activeTo: string;
  timeFrom: string;
  timeTo: string;
  formatMoney: (rial: number) => string;
}): string {
  const value = input.value ?? 0;
  const offer =
    input.kind === "percent"
      ? `${formatPersianNumber(value)}٪ تخفیف`
      : input.kind === "amount"
        ? `${input.formatMoney(value)} تخفیف`
        : `قیمت ثابت ${input.formatMoney(value)}${input.minQuantity ? ` برای ${formatPersianNumber(input.minQuantity)} عدد` : ""}`;
  const parts = [`${offer} ${input.scopeText}`];
  const days = formatWeekdays(input.daysOfWeek);
  parts.push(days ? days : "همهٔ روزها");
  if (input.timeFrom || input.timeTo) {
    parts.push(`ساعت ${toPersianDigits(input.timeFrom || "۰۰:۰۰")} تا ${toPersianDigits(input.timeTo || "۲۴:۰۰")}`);
  }
  if (input.activeFrom || input.activeTo) {
    parts.push(
      `${input.activeFrom ? `از ${toPersianDigits(formatJalali(input.activeFrom))}` : ""}${input.activeFrom && input.activeTo ? " " : ""}${input.activeTo ? `تا ${toPersianDigits(formatJalali(input.activeTo))}` : ""}`,
    );
  }
  return `${parts.join("، ")}.`;
}
