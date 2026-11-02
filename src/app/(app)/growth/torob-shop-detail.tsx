"use client";

/**
 * `/growth/torob/[shopId]` — one shop's channel, product by product (issue #894).
 *
 * The section answers "which of my websites publish to Torob"; this page answers
 * the question behind it: **what exactly would Torob receive, and what can I do
 * about the products it would not?** Every row is one catalogue product in one of
 * four states, and the three the merchant can change are changed right here:
 *
 *   در فید ترب          published by the rule, complete, priced
 *   کنار گذاشته‌اید       switched off by hand (rule «همه») — click to undo
 *   انتخاب نشده          rule is «فقط انتخابی» and not chosen yet
 *   منتشر نمی‌شود         wanted, but the catalogue stops it: the reason and the
 *                        link that fixes it, because «why is this not on Torob»
 *                        is the question this page exists to answer
 *
 * Two things it never says. It never says a product is *on Torob* — «در فید ترب»
 * means the platform would send it; Torob accepting and indexing are their own
 * facts, arriving later. And it never presents a blocked product as broken: the
 * reason comes from the feed builder's own closed vocabulary, so the sentence a
 * merchant reads is the sentence the crawler acts on.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRightIcon, ExternalLinkIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  LoadingSkeleton,
  PageHeader,
  SectionCard,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessageOrRaw, InfoBox, inputClass } from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { cmsSectionHref, wpSectionHref } from "@/app/(app)/websites/website-routes";
import type { TorobV3Response } from "@/lib/torob/contract";
import { TOROB_FEED_SKIP_COPY, type TorobFeedSkipReason } from "@/lib/torob/feed";
import {
  PRODUCT_STATE_COPY,
  PUBLICATION_RULE_COPY,
  type ProductPublicationState,
  type PublicationRule,
  type ShopPublication,
  type TorobDecision,
} from "@/lib/torob/publication";
import {
  TOROB_LISTING_STAGE_COPY,
  TOROB_OBSERVATION_ERROR_COPY,
  TOROB_PRODUCT_STATUS_COPY,
  TOROB_SHOP_STATUS_COPY,
  summaryGroups,
  summaryUnaccounted,
  torobStatusTone,
  type TorobProductStatus,
  type TorobShopStatusView,
} from "@/lib/torob/observed-state";

type PublicationResponse = ShopPublication & {
  capabilities: { feed: boolean; sent: boolean; listing: boolean };
};

type FeedPreview = {
  status: "built" | "blocked";
  builtAt: string;
  blocked: { reason: string; message: string } | null;
  summary: { total: number; pageCount: number; inStock: number; outOfStock: number } | null;
  page: TorobV3Response | null;
  skipped: { productId: string; name: string; reason: TorobFeedSkipReason }[];
};

/** One page Torob is reporting a problem for, as the panel lists them. */
type TorobProblemRow = {
  pageUnique: string;
  productId: string | null;
  mainStatus: TorobProductStatus;
  errorTitle: string | null;
  torobUpdatedAt: string | null;
};

type StatusResponse = TorobShopStatusView & {
  problems: TorobProblemRow[];
  /** Present only on a refresh: why the read did not produce a snapshot. */
  failure?: { code: string; message: string } | null;
};

const STATE_TONE: Record<ProductPublicationState, "positive" | "neutral" | "active" | "danger"> = {
  published: "positive",
  excluded: "neutral",
  unselected: "neutral",
  blocked: "danger",
};

export function TorobShopDetail({ shopId, canConfigure }: { shopId: string; canConfigure: boolean }) {
  const [data, setData] = useState<PublicationResponse | null>(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [feed, setFeed] = useState<FeedPreview | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState("");

  const load = useCallback(async () => {
    const query = new URLSearchParams({ page: String(page), ...(search ? { search } : {}) });
    const { ok, data: body } = await api<PublicationResponse & { error?: string }>(
      `/api/growth/torob/shops/${shopId}/publication?${query.toString()}`,
    );
    if (!ok) {
      setLoadError(errorMessageOrRaw(body.error) ?? "اطلاعات این فروشگاه خوانده نشد.");
      return;
    }
    setLoadError("");
    setData(body);
  }, [shopId, page, search]);

  /**
   * Torob's own answer, read from the platform's tables — a `GET`, so opening the
   * page never spends the provider's per-shop rate limit.
   */
  const loadStatus = useCallback(async () => {
    const { ok, data: body } = await api<StatusResponse & { error?: string }>(
      `/api/growth/torob/shops/${shopId}/status`,
    );
    if (!ok) {
      setStatusError(errorMessageOrRaw(body.error) ?? "وضعیت این فروشگاه در ترب خوانده نشد.");
      return;
    }
    setStatusError("");
    setStatus(body);
  }, [shopId]);

  useEffect(() => {
    void load();
    void loadStatus();
  }, [load, loadStatus]);

  /** The merchant's explicit refresh: the only path that talks to Torob. */
  async function refreshStatus() {
    setBusy(true);
    setActionError("");
    const { ok, data: answer } = await api<StatusResponse & { error?: string }>(
      `/api/growth/torob/shops/${shopId}/status`,
      { method: "POST" },
    );
    setBusy(false);
    if (!ok) {
      setActionError(errorMessageOrRaw(answer.error) ?? "خواندن وضعیت از ترب ناموفق بود.");
      return;
    }
    setStatus(answer);
  }

  async function write(body: Record<string, unknown>, message: string) {
    setBusy(true);
    setActionError("");
    const { ok, data: answer } = await api<{ error?: string }>(`/api/growth/torob/shops/${shopId}/publication`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!ok) {
      setActionError(errorMessageOrRaw(answer.error) ?? message);
      return;
    }
    await load();
  }

  async function buildPreview() {
    setBusy(true);
    setActionError("");
    const { ok, data: answer } = await api<FeedPreview & { error?: string }>(
      `/api/growth/torob/shops/${shopId}/feed`,
      { method: "POST" },
    );
    setBusy(false);
    if (!ok) {
      setActionError(errorMessageOrRaw(answer.error) ?? "ساخت پیش‌نمایش فید ناموفق بود.");
      return;
    }
    setFeed(answer);
  }

  if (loadError) return <ErrorBox>{loadError}</ErrorBox>;
  if (!data) return <LoadingSkeleton />;

  const { shop, counts, page: paging, products, ruleCopy } = data;
  const rule = shop.publicationRule as PublicationRule;
  const fixHref = shop.kind === "woocommerce" ? wpSectionHref("overview") : cmsSectionHref("overview");

  return (
    <div className="space-y-5">
      <PageHeader
        title={shop.domain}
        description="چه محصولاتی از این فروشگاه به ترب می‌رود، و هر محصولی که نمی‌رود چرا."
        actions={
          <Link
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            href="/growth/torob"
          >
            <ArrowRightIcon className="h-4 w-4" aria-hidden />
            بازگشت به مدیریت ترب
          </Link>
        }
      />

      {actionError ? <ErrorBox>{actionError}</ErrorBox> : null}

      <InfoBox>
        «در فید ترب» یعنی بیزامیز این محصول را برای ترب آماده می‌کند؛ پذیرش و ایندکس‌شدن آن را فقط خود ترب
        تأیید می‌کند و در این صفحه نمایش داده نمی‌شود.
      </InfoBox>

      <KpiRow>
        <KpiCard label="کل محصولات" value={toPersianDigits(counts.total)} />
        <KpiCard label="در فید" value={toPersianDigits(counts.published)} />
        <KpiCard label="کنار گذاشته‌شده" value={toPersianDigits(counts.excluded)} />
        {rule === "selected" ? <KpiCard label="انتخاب‌نشده" value={toPersianDigits(counts.unselected)} /> : null}
        <KpiCard label="منتشر نمی‌شود" value={toPersianDigits(counts.blocked)} />
      </KpiRow>

      {statusError ? <ErrorBox>{statusError}</ErrorBox> : null}
      {status ? (
        <TorobStatusPanel view={status} busy={busy} onRefresh={() => void refreshStatus()} />
      ) : null}

      <SectionCard
        title="قاعدهٔ انتشار"
        description={ruleCopy[rule].summary}
        actions={
          canConfigure ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={rule === "all" ? "default" : "outline"}
                disabled={busy || rule === "all"}
                onClick={() => void write({ rule: "all" }, "قاعدهٔ انتشار ذخیره نشد.")}
              >
                {ruleCopy.all.label}
              </Button>
              <Button
                variant={rule === "selected" ? "default" : "outline"}
                disabled={busy || rule === "selected"}
                onClick={() => void write({ rule: "selected" }, "قاعدهٔ انتشار ذخیره نشد.")}
              >
                {ruleCopy.selected.label}
              </Button>
            </div>
          ) : null
        }
      >
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>{ruleCopy[rule].untouched}</p>
          <label className="flex items-center gap-2 text-foreground">
            <input
              type="checkbox"
              className="size-4 rounded border-border"
              checked={shop.includeOutOfStock}
              disabled={busy || !canConfigure}
              onChange={(event) =>
                void write(
                  { rule, includeOutOfStock: event.target.checked },
                  "تنظیم ناموجودها ذخیره نشد.",
                )
              }
            />
            محصولات ناموجود هم در فید بمانند
          </label>
          <p className="text-xs">
            محصولی که در فروشگاه منتشر نشده باشد در هر حالتی به ترب نمی‌رود؛ برای انتشار باید نخست در خود
            فروشگاه منتشر شود.
          </p>
        </div>
      </SectionCard>

      <SectionCard
        title="محصولات"
        description={`${toPersianDigits(paging.matching)} محصول در این فهرست`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={inputClass}
              placeholder="جست‌وجوی نام محصول"
              value={search}
              onChange={(event) => {
                setPage(1);
                setSearch(event.target.value);
              }}
            />
            <Button variant="outline" disabled={busy} onClick={() => void buildPreview()}>
              پیش‌نمایش فید
            </Button>
          </div>
        }
      >
        {products.length === 0 ? (
          <EmptyState icon={SearchIcon} title="محصولی با این نام نیست">
            {search ? "جست‌وجو را کوتاه‌تر کنید یا پاک کنید." : "این فروشگاه هنوز محصولی در کاتالوگ ندارد."}
          </EmptyState>
        ) : (
          <DataTable caption="محصولات این فروشگاه و وضعیت انتشار هر یک در ترب">
            <DataTableHead>
              <DataTableRow>
                <Th>محصول</Th>
                <Th>قیمت (تومان)</Th>
                <Th>وضعیت</Th>
                <Th>در ترب</Th>
                <Th>دلیل</Th>
                <Th>{""}</Th>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {products.map((product) => (
                <DataTableRow key={product.id}>
                  <Td>
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{product.name}</p>
                      {product.categoryName ? (
                        <p className="text-xs text-muted-foreground">{product.categoryName}</p>
                      ) : null}
                    </div>
                  </Td>
                  <Td className="tabular-nums">
                    {product.priceToman === null ? "—" : toPersianDigits(product.priceToman.toLocaleString("en-US"))}
                  </Td>
                  <Td>
                    <StatusBadge tone={STATE_TONE[product.state]}>{PRODUCT_STATE_COPY[product.state]}</StatusBadge>
                  </Td>
                  <Td>
                    {product.torobStatus ? (
                      <div className="space-y-1">
                        <StatusBadge tone={torobStatusTone(product.torobStatus)}>
                          {TOROB_PRODUCT_STATUS_COPY[product.torobStatus]}
                        </StatusBadge>
                        {product.torobPages > 1 ? (
                          <p className="text-xs text-muted-foreground">
                            {toPersianDigits(product.torobPages)} صفحه در ترب
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {status?.observation ? "بی‌ایراد" : "خوانده نشده"}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {product.reasonCopy ? (
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">{product.reasonCopy}</p>
                        <Link className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" href={fixHref}>
                          رسیدگی در بخش وب‌سایت
                          <ExternalLinkIcon className="h-3 w-3" aria-hidden />
                        </Link>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </Td>
                  <Td>
                    {canConfigure ? (
                      <DecisionButton
                        decision={product.decision}
                        rule={rule}
                        disabled={busy}
                        onDecide={(decision) =>
                          void write(
                            { productId: product.id, decision },
                            "انتخاب این محصول ذخیره نشد.",
                          )
                        }
                      />
                    ) : null}
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}

        {paging.totalPages > 1 ? (
          <div className="mt-3 flex items-center justify-between text-sm">
            <Button variant="outline" disabled={busy || paging.page <= 1} onClick={() => setPage(paging.page - 1)}>
              صفحهٔ قبل
            </Button>
            <span className="text-muted-foreground">
              صفحهٔ {toPersianDigits(paging.page)} از {toPersianDigits(paging.totalPages)}
            </span>
            <Button
              variant="outline"
              disabled={busy || paging.page >= paging.totalPages}
              onClick={() => setPage(paging.page + 1)}
            >
              صفحهٔ بعد
            </Button>
          </div>
        ) : null}
      </SectionCard>

      {feed ? <FeedPreviewPanel feed={feed} /> : null}
    </div>
  );
}

/**
 * The one button a row has.
 *
 * Under «همهٔ محصولات» a click means "leave this one out" (`exclude`) and a second
 * click means "never mind" (`null`) — the third state is what makes the button
 * reversible without a second screen. Under «فقط انتخابی» it means "publish this"
 * (`include`), then "leave it out" (`exclude`).
 */
function DecisionButton({
  decision,
  rule,
  disabled,
  onDecide,
}: {
  decision: TorobDecision | null;
  rule: PublicationRule;
  disabled: boolean;
  onDecide: (decision: TorobDecision | null) => void;
}) {
  const next: TorobDecision | null =
    decision === null ? (rule === "selected" ? "include" : "exclude") : decision === "include" ? "exclude" : null;
  const label = next === "include" ? "انتشار در ترب" : next === "exclude" ? "کنار گذاشتن" : "بازگرداندن به قاعده";

  return (
    <Button variant="outline" disabled={disabled} onClick={() => onDecide(next)}>
      {label}
    </Button>
  );
}

/** The build the crawler would produce right now, in the panel the section uses. */
function FeedPreviewPanel({ feed }: { feed: FeedPreview }) {
  if (feed.status === "blocked") {
    return (
      <SectionCard title="پیش‌نمایش فید">
        <p className="text-sm font-medium text-foreground">فید ساخته نشد</p>
        <p className="mt-1 text-sm text-muted-foreground">{feed.blocked?.message ?? "دلیل نامشخص"}</p>
      </SectionCard>
    );
  }

  const summary = feed.summary;
  return (
    <SectionCard title="پیش‌نمایش فید" description="همان چیزی که ترب با این قاعده دریافت می‌کند.">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="font-medium text-foreground">آمادهٔ ارسال: {toPersianDigits(summary?.total ?? 0)} صفحه</span>
        <span className="text-muted-foreground">
          موجود {toPersianDigits(summary?.inStock ?? 0)} · ناموجود {toPersianDigits(summary?.outOfStock ?? 0)}
        </span>
        <span className="text-muted-foreground">
          {toPersianDigits(summary?.pageCount ?? 1)} صفحهٔ فید (هر صفحه ۱۰۰ محصول)
        </span>
        <span className="text-xs text-muted-foreground">
          ساخته‌شده {toPersianDigits(formatJalali(new Date(feed.builtAt)))}
        </span>
      </div>
      {feed.skipped.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
          {feed.skipped.slice(0, 5).map((entry) => (
            <li key={entry.productId}>
              {entry.name} — {TOROB_FEED_SKIP_COPY[entry.reason]}
            </li>
          ))}
        </ul>
      ) : null}
    </SectionCard>
  );
}

/**
 * Torob's own answer about this shop, and the one place the page is allowed to say
 * a product is *on Torob*.
 *
 * Three things it deliberately does not do: it does not call Torob on render (a
 * refresh is the button), it does not present `product_summary` as live (Torob
 * recomputes it at least every two days and says so — the calculation date is
 * printed beside the numbers), and it does not turn an old observation into a
 * fresh one because the last attempt failed. A failure is shown *with* the last
 * good answer and its date, which is the honest pair.
 */
function TorobStatusPanel({
  view,
  busy,
  onRefresh,
}: {
  view: StatusResponse;
  busy: boolean;
  onRefresh: () => void;
}) {
  const { observation, states, latestRun, problems, failure } = view;

  if (!observation) {
    return (
      <SectionCard
        title="وضعیت در ترب"
        description="آنچه ترب دربارهٔ این فروشگاه می‌گوید — نه آنچه ما برایش فرستاده‌ایم."
        actions={
          <Button variant="outline" disabled={busy} onClick={onRefresh}>
            خواندن از ترب
          </Button>
        }
      >
        {latestRun?.outcome === "failed" ? (
          <ErrorBox>
            {latestRun.error ? TOROB_OBSERVATION_ERROR_COPY[latestRun.error] : "خواندن از ترب ناموفق بود."}
          </ErrorBox>
        ) : (
          <p className="text-sm text-muted-foreground">
            هنوز چیزی از ترب خوانده نشده است؛ با «خواندن از ترب» وضعیت این فروشگاه و محصولاتش را از خود ترب
            می‌پرسیم.
          </p>
        )}
      </SectionCard>
    );
  }

  const copy = TOROB_SHOP_STATUS_COPY[observation.shopStatus];
  const groups = summaryGroups(observation.summary);
  const unaccounted = summaryUnaccounted(observation.summary);
  const errorRows = problems.filter((row) => row.errorTitle).slice(0, 5);

  return (
    <SectionCard
      title="وضعیت در ترب"
      description="آنچه ترب دربارهٔ این فروشگاه می‌گوید — نه آنچه ما برایش فرستاده‌ایم."
      actions={
        <Button variant="outline" disabled={busy} onClick={onRefresh}>
          خواندن دوباره از ترب
        </Button>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusBadge tone={copy.tone}>{copy.label}</StatusBadge>
          <span className="text-muted-foreground">{copy.summary}</span>
        </div>

        {failure ? (
          <ErrorBox>
            {failure.message} — آخرین آمار موفق ترب ({toPersianDigits(formatJalali(new Date(observation.observedAt)))}) همچنان
            نمایش داده می‌شود.
          </ErrorBox>
        ) : null}
        {!failure && latestRun?.outcome === "failed" && latestRun.error ? (
          <InfoBox>
            آخرین تلاش برای خواندن از ترب ناموفق بود ({TOROB_OBSERVATION_ERROR_COPY[latestRun.error]})؛ اعداد زیر از
            آخرین آمار موفق ترب است.
          </InfoBox>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-medium text-foreground">
            {toPersianDigits(observation.summary.total)} محصول در ترب
          </span>
          {groups.map((group) => (
            <span key={group.key} className="text-muted-foreground">
              {group.label} {toPersianDigits(group.value)}
            </span>
          ))}
        </div>

        {unaccounted !== 0 ? (
          <p className="text-xs text-muted-foreground">
            {toPersianDigits(Math.abs(unaccounted))} محصول در این گروه‌ها جا نگرفته است؛ ترب اعدادی فرستاده که با
            جمعشان نمی‌خواند و این صفحه آن‌ها را جای دیگری نمی‌گذارد.
          </p>
        ) : null}

        {observation.summary.notAccessibleErrors.length > 0 ? (
          <div className="space-y-0.5 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">دلیل در دسترس نبودن صفحات</p>
            {observation.summary.notAccessibleErrors.slice(0, 3).map((entry) => (
              <p key={entry.errorTitle}>
                {entry.errorTitle} — {toPersianDigits(entry.count)} محصول
              </p>
            ))}
          </div>
        ) : null}

        {errorRows.length > 0 ? (
          <div className="space-y-0.5 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">آخرین خطای خواندن ترب</p>
            {errorRows.map((row) => (
              <p key={row.pageUnique}>
                {row.errorTitle} — {TOROB_PRODUCT_STATUS_COPY[row.mainStatus]}
              </p>
            ))}
          </div>
        ) : null}

        <div className="space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
          <p>
            {observation.summary.calculatedAt
              ? `این آمار را ترب در ${toPersianDigits(formatJalali(new Date(observation.summary.calculatedAt)))} محاسبه کرده است.`
              : "ترب هنوز این آمار را محاسبه نکرده است؛ عددهای صفر یعنی «محاسبه نشده»، نه «بدون محصول»."}
          </p>
          <p>
            اعداد ترب زنده نیستند: ترب آن‌ها را دست‌کم هر دو روز یک بار و دلیل خطاها را روزی یک بار بازمحاسبه
            می‌کند. برای همین کنار هر محصول وضعیت خود ترب هم آمده است.
          </p>
          <p>
            {toPersianDigits(states.withProblem)} صفحه از {toPersianDigits(states.total)} صفحه‌ای که ترب گزارش
            می‌کند، دست‌کم یک وضعیت دارد.
          </p>
          {latestRun ? (
            <p>
              آخرین خواندن: {latestRun.outcome === "observed" ? "موفق" : "ناموفق"} —{" "}
              {toPersianDigits(formatJalali(new Date(latestRun.finishedAt)))}
              {latestRun.truncated
                ? "؛ این خواندن همهٔ صفحه‌های ترب را نخواند، پس نبودن یک محصول در آن به معنای حذف آن نیست."
                : ""}
            </p>
          ) : null}
        </div>

        <div className="grid gap-2 border-t border-border pt-3 text-xs text-muted-foreground sm:grid-cols-3">
          {(["feed", "sent", "listing"] as const).map((stage) => {
            const known = stage === "feed" ? true : stage === "listing" ? Boolean(observation) : false;
            return (
              <div key={stage} className="space-y-0.5">
                <p className={known ? "font-medium text-foreground" : "font-medium"}>
                  {known ? "✓ " : "— "}
                  {TOROB_LISTING_STAGE_COPY[stage].label}
                </p>
                <p>{TOROB_LISTING_STAGE_COPY[stage].summary}</p>
              </div>
            );
          })}
        </div>
      </div>
    </SectionCard>
  );
}
