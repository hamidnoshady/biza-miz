"use client";

/**
 * The Eshobe CMS manager — one of the two managers inside «مدیریت وب‌سایت».
 *
 * The other is the WordPress/WooCommerce manager (`../wp`). They are peers and
 * they stay apart: this file talks only to the platform's own site builder
 * over `src/lib/cms/`, and never to a WordPress store.
 *
 * Four sections, one per page of the manager, all over the same headless CMS
 * API. The browser never sees a CMS key: the wizard and the connect form POST
 * the credential once, the server stores it encrypted (migration 0122) and
 * every later call uses the stored site key server-side.
 *
 * Each section reads the same one overview call — the site's descriptor
 * (theme, locales, store currency), its pages, its catalogue and its orders —
 * because that is one cached round trip on the CMS side and it keeps the four
 * screens from disagreeing about what the site contains. Order status changes
 * are the one e-commerce write here; back on the CMS their own hooks settle
 * stock and snapshot the change.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CircleCheckIcon,
  CopyIcon,
  EraserIcon,
  ExternalLinkIcon,
  GlobeIcon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatPersianNumber, toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import type { CmsConnectionSummary } from "@/lib/cms/connections";
import type { CmsMedia, CmsOrder, CmsPage, CmsPost, CmsProduct, SiteDescriptor } from "@/lib/cms/types";
import { lexicalToMarkdown } from "@/lib/website/providers/payload-content";
import { Skeleton } from "@/components/ui/skeleton";
import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import {
  api,
  errorMessageOrRaw,
  Field,
  inputClass,
  SecondaryButton,
  ErrorBox,
  InfoBox,
} from "@/app/dashboard/ui";
import { cmsDnsHint, isSiteLive } from "@/lib/cms/dns";
import type { SiteCdnStatus } from "@/lib/cms/client";
import type { CmsDnsStatus, WebsiteOverview } from "@/lib/cms/website-service";
import { cmsSectionHref } from "../website-routes";
import { CmsSyncSettings } from "./cms-sync-settings";

const TYPE_LABELS: Record<string, string> = {
  business: "کسب‌وکار",
  portfolio: "نمونه‌کار",
  store: "فروشگاه",
};

const STATUS_LABELS: Record<string, string> = {
  active: "فعال",
  suspended: "معلق",
  archived: "بایگانی‌شده",
  published: "منتشرشده",
  draft: "پیش‌نویس",
};

const LOCALE_LABELS: Record<string, string> = { fa: "فارسی", en: "انگلیسی" };

const CURRENCY_LABELS: Record<string, string> = {
  IRT: "تومان",
  IRR: "ریال",
  EUR: "€",
  USD: "$",
};

const CDN_PROVIDER_LABELS: Record<string, string> = {
  arvancloud: "ابر آروان",
  cloudflare: "Cloudflare",
};

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "در انتظار پرداخت",
  paid: "پرداخت‌شده",
  cancelled: "لغو شده",
  refunded: "بازگشت خورده",
};

const ORDER_STATUS_TONE: Record<string, "active" | "positive" | "neutral" | "danger"> = {
  pending: "active",
  paid: "positive",
  cancelled: "neutral",
  refunded: "danger",
};

/* ------------------------------------------------------------------ */
/* The shared read every section of this manager starts from           */
/* ------------------------------------------------------------------ */

interface CmsSite {
  loading: boolean;
  connection: CmsConnectionSummary | null;
  /** The `/state` read itself failed — a different screen from "no site yet". */
  stateError: string;
  overview: WebsiteOverview | null;
  /** The overview is still in flight; the cards show their skeletons. */
  overviewLoading: boolean;
  overviewError: string;
  dnsStatus: CmsDnsStatus | null;
  dnsLoading: boolean;
  dnsError: string;
  reload: () => void;
  loadOverview: () => void;
  checkDns: () => void;
  setOverview: React.Dispatch<React.SetStateAction<WebsiteOverview | null>>;
}

function useCmsSite({
  withDns = false,
  withOverview = true,
}: { withDns?: boolean; withOverview?: boolean } = {}): CmsSite {
  const [connection, setConnection] = useState<CmsConnectionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [stateError, setStateError] = useState("");
  const [overview, setOverview] = useState<WebsiteOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState("");
  const [dnsStatus, setDnsStatus] = useState<CmsDnsStatus | null>(null);
  const [dnsLoading, setDnsLoading] = useState(false);
  const [dnsError, setDnsError] = useState("");

  /**
   * Every async setState below is guarded by these.
   *
   * These cards are on a screen a member opens and leaves quickly (the
   * sidebar's «محتوا» is one click away), and the CMS is a remote system with
   * an 8s deadline, so a reply landing after unmount is the normal case, not
   * an edge one. The counters also serialise overlapping «به‌روزرسانی»
   * presses: a second press bumps its stream's token and the first reply is
   * discarded, so a slow first answer can no longer overwrite a fresh one.
   *
   * One counter per stream, not one shared counter: `reload` fires the state
   * read, the overview and the DNS check together, and a single token would
   * have each of them cancel the previous one on every refresh.
   */
  const stateRun = useRef(0);
  const overviewRun = useRef(0);
  const dnsRun = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadOverview = useCallback(() => {
    const token = ++overviewRun.current;
    setOverviewLoading(true);
    api<{ overview: WebsiteOverview }>("/api/cms/website/overview").then(({ ok, data }) => {
      if (!alive.current || token !== overviewRun.current) return;
      setOverviewLoading(false);
      if (ok) {
        setOverview(data.overview);
        setOverviewError("");
      } else {
        // The previous content is deliberately kept on screen: a CMS that
        // timed out once is not a site that lost its pages, and blanking the
        // cards under an error message reads as data loss.
        setOverviewError(errorMessageOrRaw((data as { error?: string }).error));
      }
    });
  }, []);

  const checkDns = useCallback(() => {
    const token = ++dnsRun.current;
    setDnsLoading(true);
    setDnsError("");
    api<{ status: CmsDnsStatus }>("/api/cms/website/dns").then(({ ok, data }) => {
      if (!alive.current || token !== dnsRun.current) return;
      setDnsLoading(false);
      if (ok) {
        setDnsStatus(data.status);
        setDnsError("");
      } else {
        // An inline message on the card, not only a toast: a toast is gone in
        // four seconds and the checklist would sit there looking unchecked
        // with no explanation of why.
        setDnsError(errorMessageOrRaw((data as { error?: string }).error));
      }
    });
  }, []);

  const reload = useCallback(() => {
    const token = ++stateRun.current;
    setLoading(true);
    api<{ connected: boolean; connection: CmsConnectionSummary | null }>("/api/cms/website/state").then(
      ({ ok, data }) => {
        if (!alive.current || token !== stateRun.current) return;
        setLoading(false);
        if (!ok) {
          // Without this the screen silently kept the old «هنوز سایتی ندارید»
          // empty state on a failed read, inviting an owner to build a second
          // site over one they already have.
          setStateError(errorMessageOrRaw((data as { error?: string }).error));
          return;
        }
        setStateError("");
        setConnection(data.connection);
        if (data.connection) {
          if (withOverview) loadOverview();
          if (withDns) checkDns();
        } else {
          setOverview(null);
          setOverviewError("");
          setDnsStatus(null);
          setDnsError("");
        }
      },
    );
  }, [loadOverview, checkDns, withDns, withOverview]);

  useEffect(reload, [reload]);

  return {
    loading,
    connection,
    stateError,
    overview,
    overviewLoading,
    overviewError,
    dnsStatus,
    dnsLoading,
    dnsError,
    reload,
    loadOverview,
    checkDns,
    setOverview,
  };
}

/**
 * What every section but the overview shows when there is no site yet.
 *
 * A section of a site that does not exist is a dead end, so it points at the
 * one screen that can change that. The nav already hides these sections; this
 * is for a bookmark or a typed URL.
 */
function NoSiteYet({ what }: { what: string }) {
  return (
    <SectionCard title={what} description="برای این بخش، اول باید سایتی روی سایت‌ساز داشته باشید.">
      <EmptyState>هنوز سایتی ساخته یا وصل نشده است.</EmptyState>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button asChild variant="outline" className="px-4">
          <Link href="/settings/connections?tab=website">
            <PlugZapIcon className="size-4" />
            اتصال سایت موجود
          </Link>
        </Button>
        <Button asChild variant="outline" className="px-4">
          <Link href={cmsSectionHref("setup")}>
            <GlobeIcon className="size-4" />
            ساخت سایت جدید
          </Link>
        </Button>
      </div>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* میز کار سایت — connection, domain and the live preview              */
/* ------------------------------------------------------------------ */

export function CmsOverviewSection() {
  const site = useCmsSite({ withDns: false });
  const [previewReady, setPreviewReady] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  if (site.loading) return <SectionCardSkeleton rows={4} />;

  // A failed `/state` read is not «no site yet». Showing the build prompt here
  // invites an owner to provision a second site over the one they already
  // have, so the read is reported and retried instead.
  if (site.stateError) {
    return (
      <SectionCard title="وضعیت سایت خوانده نشد" description="اتصال به سرور برقرار نشد؛ وضعیت سایت نامشخص است.">
        <ErrorBox>{site.stateError}</ErrorBox>
        <SecondaryButton onClick={site.reload}>
          <RefreshCwIcon className="size-4" />
          تلاش دوباره
        </SecondaryButton>
      </SectionCard>
    );
  }

  if (!site.connection) {
    return (
      <SectionCard
        title="هنوز سایتی ندارید"
        description="سایت اینترنتی کسب‌وکار را روی سایت‌ساز پلتفرم بسازید، یا سایتی که قبلاً ساخته‌اید را وصل کنید."
      >
        <EmptyState>ساخت سایت چهار گام دارد: دامنه، CDN، نوع سایت و ساخت.</EmptyState>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button asChild className="px-4">
            <Link href={cmsSectionHref("setup")}>
              <GlobeIcon className="size-4" />
              شروع ساخت سایت
            </Link>
          </Button>
          {/* The other half of the answer. Without it, an owner whose site was
              built last month has no way from this screen to say so. */}
          <Button asChild variant="outline" className="px-4">
            <Link href="/settings/connections?tab=website">
              <PlugZapIcon className="size-4" />
              اتصال سایت موجود
            </Link>
          </Button>
        </div>
      </SectionCard>
    );
  }

  const adminUrl = site.dnsStatus?.adminUrl ?? `${site.connection.baseUrl.replace(/\/+$/, "")}/admin`;

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title="اتصال به سایت"
        description="محتوای سایت و فروشگاه از سایت‌ساز پلتفرم خوانده می‌شود."
        actions={
          <div className="flex flex-wrap gap-2">
            <SecondaryButton onClick={site.reload} disabled={site.overviewLoading || site.dnsLoading}>
              <RefreshCwIcon className="size-4" />
              {site.overviewLoading || site.dnsLoading ? "در حال به‌روزرسانی…" : "به‌روزرسانی"}
            </SecondaryButton>
            {/* An anchor, not window.open: middle-click and "open in new tab"
                work, and a popup blocker cannot swallow it. */}
            <Button asChild variant="outline" className="px-4">
              <a href={adminUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLinkIcon className="size-4" />
                مدیریت محتوا در سایت‌ساز
              </a>
            </Button>
          </div>
        }
      >
        <ErrorBox>{site.overviewError}</ErrorBox>
        {/* The domain belongs in the body, LTR and truncating. In the card's
            description it was interpolated into a Persian sentence, where an
            RTL paragraph reorders the dots of a latin host. */}
        <p className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span>دامنهٔ متصل:</span>
          <span dir="ltr" className="min-w-0 truncate font-medium text-foreground">
            {site.connection.siteDomain}
          </span>
        </p>
        {site.overviewLoading && !site.overview ? (
          <LoadingSkeleton rows={2} compact label="در حال بارگذاری مشخصات سایت" />
        ) : site.overview ? (
          <SiteSummary site={site.overview.site} />
        ) : (
          <EmptyState>مشخصات سایت خوانده نشد؛ «به‌روزرسانی» را بزنید.</EmptyState>
        )}
      </SectionCard>

      <PreviewCard
        status={site.dnsStatus}
        ready={previewReady}
        frameKey={previewKey}
        onLoad={() => setPreviewReady(true)}
        onRefresh={() => {
          setPreviewReady(false);
          setPreviewKey((key) => key + 1);
        }}
      />

    </div>
  );
}

/* ------------------------------------------------------------------ */
/* دامنه — DNS checklist and domain change                             */
/* ------------------------------------------------------------------ */

export function CmsDomainSection() {
  const site = useCmsSite({ withDns: true, withOverview: false });
  const [editingDomain, setEditingDomain] = useState(false);

  if (site.loading) return <SectionCardSkeleton rows={4} />;
  if (!site.connection) return <NoSiteYet what="دامنه و DNS" />;

  const adminUrl = site.dnsStatus?.adminUrl ?? `${site.connection.baseUrl.replace(/\/+$/, "")}/admin`;

  return (
    <div className="space-y-4 sm:space-y-5">
      <DnsChecklistCard
        status={site.dnsStatus}
        loading={site.dnsLoading}
        error={site.dnsError}
        onCheck={site.checkDns}
        adminUrl={adminUrl}
        currentDomain={site.connection.siteDomain}
        onEditDomain={() => setEditingDomain(true)}
      />
      <CdnCard />
      {editingDomain ? (
        <DomainDialog
          currentDomain={site.connection.siteDomain}
          onClose={() => setEditingDomain(false)}
          onSaved={() => {
            setEditingDomain(false);
            site.reload();
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* صفحه‌ها                                                             */
/* ------------------------------------------------------------------ */

export function CmsPagesSection() {
  const site = useCmsSite();
  const [pages, setPages] = useState<CmsPage[] | null>(null);
  const [pagesError, setPagesError] = useState("");
  const [publishingPage, setPublishingPage] = useState("");

  const loadPages = useCallback(async () => {
    const { ok, data } = await api<{ pages?: CmsPage[]; error?: string }>("/api/cms/website/pages");
    if (!ok || !data.pages) {
      setPagesError(errorMessageOrRaw(data.error));
      return;
    }
    setPagesError("");
    setPages(data.pages);
  }, []);

  useEffect(() => {
    if (site.connection) void loadPages();
  }, [site.connection, loadPages]);

  async function publish(page: CmsPage) {
    setPublishingPage(page.id);
    const { ok, data } = await api<{ error?: string }>(`/api/cms/website/pages/${page.id}/publish`, { method: "POST" });
    setPublishingPage("");
    if (!ok) {
      toast.error(errorMessageOrRaw(data.error));
      return;
    }
    toast.success("صفحه منتشر شد.");
    void loadPages();
    site.loadOverview();
  }

  if (site.loading) return <SectionCardSkeleton rows={4} />;
  if (!site.connection) return <NoSiteYet what="صفحه‌های سایت" />;

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{site.overviewError}</ErrorBox>
      <SectionCard title="صفحه‌ها" description="برگه‌های ثابت سایت. ذخیره پیش‌نویس است؛ انتشار با دکمهٔ جداگانه.">
        <ErrorBox>{pagesError}</ErrorBox>
        {pages === null ? (
          <LoadingSkeleton rows={3} compact label="در حال بارگذاری صفحه‌ها" />
        ) : pages.length === 0 ? (
          <EmptyState>هنوز صفحه‌ای ساخته نشده است.</EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {pages.map((page) => (
              <li key={page.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{page.title}</p>
                  <p dir="ltr" className="truncate text-xs text-muted-foreground">
                    /{page.slug}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge tone={page._status === "published" ? "positive" : "active"}>
                    {STATUS_LABELS[page._status ?? "draft"]}
                  </StatusBadge>
                  {page._status !== "published" ? (
                    <Button type="button" variant="outline" size="sm" disabled={publishingPage === page.id} onClick={() => void publish(page)}>
                      {publishingPage === page.id ? "در حال انتشار…" : "انتشار"}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* نوشته‌ها                                                            */
/* ------------------------------------------------------------------ */

export function CmsPostsSection() {
  const site = useCmsSite();
  const [editingPost, setEditingPost] = useState<CmsPost | "new" | null>(null);
  const [publishingPost, setPublishingPost] = useState("");
  const [contentPosts, setContentPosts] = useState<CmsPost[] | null>(null);
  const [contentError, setContentError] = useState("");
  const loadPosts = useCallback(async () => {
    const { ok, data } = await api<{ posts?: CmsPost[]; error?: string }>("/api/cms/website/drafts");
    if (!ok || !data.posts) { setContentError(errorMessageOrRaw(data.error)); return; }
    setContentError(""); setContentPosts(data.posts);
  }, []);
  useEffect(() => { if (site.connection) void loadPosts(); }, [site.connection, loadPosts]);

  async function publish(post: CmsPost) {
    setPublishingPost(post.id);
    const { ok, data } = await api<{ error?: string }>(`/api/cms/website/drafts/${post.id}/publish`, { method: "POST" });
    setPublishingPost("");
    if (!ok) { toast.error(errorMessageOrRaw(data.error)); return; }
    toast.success("نوشته منتشر شد.");
    void loadPosts();
    site.loadOverview();
  }

  if (site.loading) return <SectionCardSkeleton rows={4} />;
  if (!site.connection) return <NoSiteYet what="نوشته‌های سایت" />;

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{site.overviewError}</ErrorBox>

      <SectionCard
        title="نوشته‌ها"
        description="مطالب وبلاگ سایت (۲۰ نوشتهٔ آخر). ذخیره همیشه پیش‌نویس است و انتشار فقط با دکمهٔ جداگانه انجام می‌شود."
        actions={
          <SecondaryButton onClick={() => setEditingPost("new")}>
            <PlusIcon className="size-4" />
            نوشتهٔ جدید
          </SecondaryButton>
        }
      >
        <ErrorBox>{contentError}</ErrorBox>
        {!contentPosts ? (
          <LoadingSkeleton rows={3} compact label="در حال بارگذاری نوشته‌ها" />
        ) : contentPosts.length === 0 ? (
          <EmptyState>هنوز نوشته‌ای ساخته نشده است.</EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {contentPosts.map((post) => (
              <li key={post.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{post.title}</p>
                  <p dir="ltr" className="truncate text-xs text-muted-foreground">
                    /{post.slug}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{toPersianDigits(formatJalali(post.updatedAt))}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge tone={post._status === "published" ? "positive" : "active"}>
                    {STATUS_LABELS[post._status ?? "draft"]}
                  </StatusBadge>
                  {post._status === "published" ? (site.overview?.site.domain ? <Button type="button" variant="outline" size="icon" onClick={() => window.open(`https://${site.overview!.site.domain}/blog/${post.slug}`, "_blank", "noopener")} aria-label={`دیدن ${post.title}`}><ExternalLinkIcon className="size-4" /></Button> : null) : <Button type="button" variant="outline" size="sm" disabled={publishingPost === post.id} onClick={() => void publish(post)}>{publishingPost === post.id ? "در حال انتشار…" : "انتشار"}</Button>}
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setEditingPost(post)}
                    aria-label={`ویرایش ${post.title}`}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {editingPost ? (
        <PostDialog
          post={editingPost === "new" ? null : editingPost}
          onClose={() => setEditingPost(null)}
          onSaved={() => {
            setEditingPost(null);
            void loadPosts();
            site.loadOverview();
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* محصولات فروشگاه                                                     */
/* ------------------------------------------------------------------ */

export function CmsProductsSection() {
  const site = useCmsSite();
  const [editingProduct, setEditingProduct] = useState<CmsProduct | "new" | null>(null);

  if (site.loading) return <SectionCardSkeleton rows={4} />;
  if (!site.connection) return <NoSiteYet what="محصولات فروشگاه" />;

  const currency = site.overview?.site.store.currency ?? "IRT";

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{site.overviewError}</ErrorBox>

      <SectionCard
        title="محصولات"
        description="فروشگاه آنلاین (۵۰ محصول آخر). محصول ساخته‌شده از این‌جا پیش‌نویس است؛ انتشار از پنل سایت‌ساز انجام می‌شود."
        actions={
          <SecondaryButton onClick={() => setEditingProduct("new")}>
            <PlusIcon className="size-4" />
            محصول جدید
          </SecondaryButton>
        }
      >
        {!site.overview ? (
          <LoadingSkeleton rows={3} compact label="در حال بارگذاری محصول‌ها" />
        ) : site.overview.products.length === 0 ? (
          <EmptyState>فروشگاه هنوز محصولی ندارد.</EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {site.overview.products.map((product) => (
              <li key={product.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{product.title}</p>
                  {product.sku ? <p className="truncate text-xs text-muted-foreground">{product.sku}</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <p className="text-sm font-semibold text-foreground">
                    {formatPersianNumber(product.price)}{" "}
                    <span className="text-xs font-normal text-muted-foreground">
                      {CURRENCY_LABELS[currency] ?? currency}
                    </span>
                  </p>
                  <StatusBadge tone={product._status === "published" ? "positive" : "active"}>
                    {STATUS_LABELS[product._status ?? "draft"]}
                  </StatusBadge>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setEditingProduct(product)}
                    aria-label={`ویرایش ${product.title}`}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {editingProduct ? (
        <ProductDialog
          product={editingProduct === "new" ? null : editingProduct}
          currency={CURRENCY_LABELS[currency] ?? currency}
          onClose={() => setEditingProduct(null)}
          onSaved={() => {
            setEditingProduct(null);
            site.loadOverview();
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* سفارش‌های فروشگاه                                                   */
/* ------------------------------------------------------------------ */

export function CmsOrdersSection() {
  const site = useCmsSite();
  const [updatingOrder, setUpdatingOrder] = useState("");

  if (site.loading) return <SectionCardSkeleton rows={4} />;
  if (!site.connection) return <NoSiteYet what="سفارش‌های فروشگاه" />;

  const currency = site.overview?.site.store.currency ?? "IRT";

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{site.overviewError}</ErrorBox>
      {site.overview ? (
        <OrdersCard
          orders={site.overview.orders}
          orderInbox={site.overview.orderInbox ?? {}}
          currency={currency}
          updatingOrder={updatingOrder}
          onStatusChange={(order, status) => {
            setUpdatingOrder(order.id);
            api<{ order: CmsOrder }>(`/api/cms/website/orders/${order.id}`, {
              method: "PATCH",
              body: JSON.stringify({ status }),
            }).then(({ ok, data }) => {
              if (ok) {
                site.setOverview((current) =>
                  current
                    ? {
                        ...current,
                        orders: current.orders.map((row) => (row.id === order.id ? data.order : row)),
                      }
                    : current,
                );
                toast.success(`سفارش ${toPersianDigits(order.reference)} ${ORDER_STATUS_LABELS[status] ?? ""} شد.`);
              } else {
                toast.error(errorMessageOrRaw((data as { error?: string }).error));
              }
              setUpdatingOrder("");
            });
          }}
        />
      ) : (
        <SectionCard title="سفارش‌ها" description="سفارش‌های فروشگاه اینترنتی.">
          <LoadingSkeleton rows={3} compact label="در حال بارگذاری سفارش‌ها" />
        </SectionCard>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* رسانه‌ها                                                            */
/* ------------------------------------------------------------------ */

export function CmsMediaSection() {
  const site = useCmsSite({ withOverview: false });
  const [items, setItems] = useState<CmsMedia[] | null>(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ media?: CmsMedia[]; error?: string }>("/api/cms/website/media");
    if (!ok || !data.media) {
      setError(errorMessageOrRaw(data.error));
      return;
    }
    setError("");
    setItems(data.media);
  }, []);

  useEffect(() => {
    if (site.connection) void load();
  }, [site.connection, load]);

  async function onUpload(file: File) {
    setUploading(true);
    const form = new FormData();
    form.set("file", file);
    const res = await fetch("/api/cms/website/media", { method: "POST", body: form });
    setUploading(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(errorMessageOrRaw(body.error));
      return;
    }
    toast.success("فایل بارگذاری شد.");
    void load();
  }

  if (site.loading) return <SectionCardSkeleton rows={4} />;
  if (!site.connection) return <NoSiteYet what="رسانه‌های سایت" />;

  return (
    <SectionCard
      title="رسانه‌ها"
      description="تصاویر و فایل‌های آپلودشده روی سایت."
      actions={
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted">
          <PlusIcon className="size-4" />
          {uploading ? "در حال بارگذاری…" : "بارگذاری فایل"}
          <input
            type="file"
            className="sr-only"
            accept="image/*"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onUpload(file);
              event.target.value = "";
            }}
          />
        </label>
      }
    >
      <ErrorBox>{error}</ErrorBox>
      {items === null ? (
        <LoadingSkeleton rows={3} compact label="در حال بارگذاری رسانه‌ها" />
      ) : items.length === 0 ? (
        <EmptyState>هنوز فایلی بارگذاری نشده است.</EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{item.filename ?? item.id}</p>
                <p className="truncate text-xs text-muted-foreground">{item.alt ?? "—"}</p>
              </div>
              {item.filesize ? (
                <p className="text-xs text-muted-foreground">{toPersianDigits(formatPersianNumber(item.filesize))} بایت</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* طراحی — theme packages, deployment, theme settings                  */
/* ------------------------------------------------------------------ */

type ThemePackageOption = { id: string; key: string; name: string; description?: string | null };

type ThemeSettingsField = {
  key: string;
  label: string;
  help: string | null;
  required: boolean;
  secret: boolean;
  set?: boolean;
  value?: string;
};

const DEPLOYMENT_STATUS_LABELS: Record<string, string> = {
  queued: "در صف",
  creating: "در حال ایجاد",
  building: "در حال ساخت",
  verifying: "در حال بررسی",
  live: "فعال",
  failed: "ناموفق",
  stopped: "متوقف",
};

export function CmsDesignSection() {
  const site = useCmsSite({ withOverview: false });
  const [packages, setPackages] = useState<ThemePackageOption[]>([]);
  const [selectedPackage, setSelectedPackage] = useState("");
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const [deploymentStatus, setDeploymentStatus] = useState("");
  const [deployBusy, setDeployBusy] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [canEditSettings, setCanEditSettings] = useState(false);
  const [themeFields, setThemeFields] = useState<ThemeSettingsField[]>([]);
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadDeployment = useCallback(async () => {
    const { ok, data } = await api<{ current?: { id?: string; status?: string } | null; error?: string }>(
      "/api/cms/website/design/deployment",
    );
    if (!ok) {
      setError(errorMessageOrRaw(data.error));
      return;
    }
    const current = data.current;
    const status = String(current?.status ?? "");
    setDeploymentStatus(status);
    setDeploymentId(current?.id ? String(current.id) : null);
    return status;
  }, []);

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    const { ok, data } = await api<{
      settings?: { canEdit: boolean; fields: ThemeSettingsField[] };
      error?: string;
    }>("/api/cms/website/design/theme-settings");
    setSettingsLoading(false);
    if (!ok || !data.settings) {
      setError(errorMessageOrRaw(data.error));
      return;
    }
    setError("");
    setCanEditSettings(data.settings.canEdit);
    setThemeFields(data.settings.fields ?? []);
    const next: Record<string, string> = {};
    for (const field of data.settings.fields ?? []) {
      if (!field.secret && field.value) next[field.key] = field.value;
    }
    setDraftValues(next);
  }, []);

  useEffect(() => {
    if (!site.connection) return;
    void api<{ packages?: ThemePackageOption[] }>("/api/cms/website/design/theme-packages").then(({ ok, data }) => {
      if (ok && data.packages) {
        setPackages(data.packages);
        if (data.packages[0] && !selectedPackage) setSelectedPackage(data.packages[0].id);
      }
    });
    void loadDeployment();
    void loadSettings();
  }, [site.connection, loadDeployment, loadSettings, selectedPackage]);

  useEffect(() => {
    if (!deploymentId) return;
    const pending = ["queued", "creating", "building", "verifying"];
    if (!pending.includes(deploymentStatus)) return;
    pollRef.current = setInterval(() => {
      void api<{ deployment?: { status?: string }; error?: string }>("/api/cms/website/design/deployment", {
        method: "POST",
        body: JSON.stringify({ action: "poll", deployment: deploymentId }),
      }).then(async ({ ok, data }) => {
        if (!ok) return;
        const status = String(data.deployment?.status ?? "");
        setDeploymentStatus(status);
        if (!pending.includes(status)) {
          if (pollRef.current) clearInterval(pollRef.current);
          await loadDeployment();
          await loadSettings();
        }
      });
    }, 4000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [deploymentId, deploymentStatus, loadDeployment, loadSettings]);

  async function startDeploy() {
    if (!selectedPackage) return;
    setDeployBusy(true);
    const { ok, data } = await api<{ deployment?: string; status?: string; error?: string }>(
      "/api/cms/website/design/deployment",
      { method: "POST", body: JSON.stringify({ package: selectedPackage }) },
    );
    setDeployBusy(false);
    if (!ok) {
      toast.error(errorMessageOrRaw(data.error));
      return;
    }
    toast.success("استقرار در صف قرار گرفت.");
    if (data.deployment) setDeploymentId(data.deployment);
    if (data.status) setDeploymentStatus(data.status);
    void loadDeployment();
  }

  async function saveSettings() {
    setSettingsSaving(true);
    const { ok, data } = await api<{ settings?: { fields: ThemeSettingsField[] }; error?: string }>(
      "/api/cms/website/design/theme-settings",
      { method: "POST", body: JSON.stringify({ values: draftValues }) },
    );
    setSettingsSaving(false);
    if (!ok) {
      toast.error(errorMessageOrRaw(data.error));
      return;
    }
    toast.success("تنظیمات پوسته ذخیره شد.");
    if (data.settings) setThemeFields(data.settings.fields ?? []);
    void loadSettings();
  }

  if (site.loading) return <SectionCardSkeleton rows={4} />;
  if (!site.connection) return <NoSiteYet what="طراحی سایت" />;

  const statusLabel = DEPLOYMENT_STATUS_LABELS[deploymentStatus] ?? (deploymentStatus || "—");

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title="پوسته و استقرار"
        description="پوستهٔ منتشرشده را انتخاب کنید و با استقرار edge روی دامنهٔ سایت فعال کنید."
      >
        <ErrorBox>{error}</ErrorBox>
        <p className="text-sm text-muted-foreground">
          وضعیت استقرار: <span className="font-medium text-foreground">{statusLabel}</span>
        </p>
        {packages.length === 0 ? (
          <EmptyState className="mt-3">پوستهٔ منتشرشده‌ای برای این نوع سایت یافت نشد.</EmptyState>
        ) : (
          <div className="mt-3 space-y-3">
            <Field label="پوسته">
              <select
                className={inputClass}
                value={selectedPackage}
                onChange={(event) => setSelectedPackage(event.target.value)}
              >
                {packages.map((pkg) => (
                  <option key={pkg.id} value={pkg.id}>
                    {pkg.name}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="button" disabled={deployBusy || !selectedPackage} onClick={() => void startDeploy()}>
              {deployBusy ? "در حال ثبت…" : "استقرار روی لبه (edge)"}
            </Button>
          </div>
        )}
      </SectionCard>
      <SectionCard title="تنظیمات پوسته" description="متغیرهایی که پوسته از شما می‌پرسد (مقادیر محرمانه نمایش داده نمی‌شوند).">
        {settingsLoading ? (
          <LoadingSkeleton rows={2} compact label="در حال بارگذاری تنظیمات" />
        ) : themeFields.length === 0 ? (
          <EmptyState>پوستهٔ مستقرشده‌ای با تنظیمات tenant وجود ندارد.</EmptyState>
        ) : (
          <div className="space-y-3">
            {themeFields.map((field) => (
              <Field key={field.key} label={field.label} hint={field.help ?? undefined}>
                {field.secret ? (
                  <p className="text-sm text-muted-foreground">{field.set ? "مقدار ذخیره شده است" : "هنوز تنظیم نشده"}</p>
                ) : (
                  <input
                    className={inputClass}
                    value={draftValues[field.key] ?? ""}
                    disabled={!canEditSettings}
                    onChange={(event) =>
                      setDraftValues((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                  />
                )}
              </Field>
            ))}
            {canEditSettings ? (
              <Button type="button" disabled={settingsSaving} onClick={() => void saveSettings()}>
                {settingsSaving ? "در حال ذخیره…" : "ذخیره تنظیمات"}
              </Button>
            ) : (
              <InfoBox>فقط مالک سایت می‌تواند تنظیمات پوسته را تغییر دهد.</InfoBox>
            )}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* تنظیمات — the connection itself, and what this app pushes to it     */
/* ------------------------------------------------------------------ */

export function CmsSettingsSection() {
  const site = useCmsSite({ withOverview: false });

  if (site.loading) return <SectionCardSkeleton rows={4} />;
  if (!site.connection) return <NoSiteYet what="تنظیمات همگام‌سازی" />;

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title="اتصال سایت"
        description={`سایت «${site.connection.siteDomain}» به همین حساب وصل است. خودِ اتصال — آزمایش، تغییر دامنه و قطع — در «اتصال‌های فنی» مدیریت می‌شود؛ اینجا فقط اینکه چه چیزی به سایت فرستاده شود.`}
      >
        <Button asChild variant="outline" className="px-4">
          <Link href="/settings/connections?tab=website">
            <PlugZapIcon className="size-4" />
            مدیریت اتصال در اتصال‌های فنی
          </Link>
        </Button>
      </SectionCard>

      <CmsSyncSettings />
    </div>
  );
}

export function SiteSummary({ site }: { site: SiteDescriptor }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <p className="text-xs text-muted-foreground">نام سایت</p>
        <p className="mt-0.5 truncate text-sm font-medium text-foreground">{site.name}</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">دامنه</p>
        <p dir="ltr" className="mt-0.5 truncate text-sm font-medium text-foreground">
          {site.domain}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">نوع و وضعیت</p>
        <p className="mt-0.5 flex items-center gap-2 text-sm font-medium text-foreground">
          {TYPE_LABELS[site.type] ?? site.type}
          <StatusBadge tone={site.status === "active" ? "positive" : site.status === "suspended" ? "active" : "neutral"}>
            {STATUS_LABELS[site.status] ?? site.status}
          </StatusBadge>
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">زبان‌ها و ارز</p>
        <p className="mt-0.5 text-sm font-medium text-foreground">
          {/* A descriptor with no locales rendered a leading « · » with
              nothing before it; an em dash reads as "not set". */}
          {site.availableLocales.length > 0
            ? site.availableLocales.map((locale) => LOCALE_LABELS[locale] ?? locale).join("، ")
            : "—"}
          <span className="text-muted-foreground"> · </span>
          {CURRENCY_LABELS[site.store.currency] ?? site.store.currency}
        </p>
      </div>
    </div>
  );
}

const INBOX_STATUS_LABELS: Record<string, string> = {
  processed: "وارد حسابداری شد",
  failed: "خطای ورود",
  pending: "در صف ورود",
  duplicate: "تکراری",
};

const INBOX_STATUS_TONE: Record<string, "positive" | "danger" | "active" | "neutral"> = {
  processed: "positive",
  failed: "danger",
  pending: "active",
  duplicate: "neutral",
};

function OrdersCard({
  orders,
  orderInbox,
  currency,
  updatingOrder,
  onStatusChange,
}: {
  orders: CmsOrder[];
  orderInbox: Record<string, { status: string; error: string | null }>;
  currency: string;
  updatingOrder: string;
  onStatusChange: (order: CmsOrder, status: CmsOrder["status"]) => void;
}) {
  return (
    <SectionCard title="سفارش‌ها" description="تغییر وضعیت، همان کاری است که درگاه و انبار CMS انجام می‌دهند.">
      {orders.length === 0 ? (
        <EmptyState>سفارشی ثبت نشده است.</EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {orders.map((order) => (
            <li key={order.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {toPersianDigits(order.reference)} — {order.productTitle ?? "محصول"}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {toPersianDigits(order.quantity)} عدد · {toPersianDigits(order.buyer.phone)}
                  {" · "}
                  {formatPersianNumber(order.total)}{" "}
                  {CURRENCY_LABELS[currency] ?? currency}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {order.status === "paid" && orderInbox[order.id] ? (
                  <StatusBadge tone={INBOX_STATUS_TONE[orderInbox[order.id].status] ?? "neutral"}>
                    {INBOX_STATUS_LABELS[orderInbox[order.id].status] ?? orderInbox[order.id].status}
                  </StatusBadge>
                ) : null}
                <StatusBadge tone={ORDER_STATUS_TONE[order.status] ?? "neutral"}>
                  {ORDER_STATUS_LABELS[order.status] ?? order.status}
                </StatusBadge>
                <select
                  className={`${inputClass} h-9 w-auto`}
                  value={order.status}
                  disabled={updatingOrder === order.id}
                  onChange={(event) => onStatusChange(order, event.target.value as CmsOrder["status"])}
                  aria-label={`وضعیت سفارش ${toPersianDigits(order.reference)}`}
                >
                  {Object.entries(ORDER_STATUS_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* DNS checklist + live preview                                        */
/* ------------------------------------------------------------------ */

/**
 * One address an owner has to retype into their registrar's panel, with a
 * button that copies it. Typing an IPv6 literal by hand is how a checklist
 * stays amber all afternoon.
 */
function CopyableValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      // `navigator.clipboard` is absent on insecure origins and can be
      // refused outright; the value stays selectable either way, which is why
      // it is rendered as text rather than hidden behind the button.
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("کپی نشد؛ متن را دستی انتخاب کنید.");
    }
  }

  return (
    <span className="inline-flex max-w-full items-center gap-1 align-middle">
      <code dir="ltr" className="min-w-0 select-all truncate rounded bg-card px-1.5 py-0.5 text-xs">
        {value}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={copy}
        aria-label={`کپی ${label}`}
        title={copied ? "کپی شد" : `کپی ${label}`}
      >
        {copied ? <CircleCheckIcon className="text-emerald-600 dark:text-emerald-400" /> : <CopyIcon />}
      </Button>
    </span>
  );
}

function DnsChecklistCard({
  status,
  loading,
  error,
  onCheck,
  adminUrl,
  currentDomain,
  onEditDomain,
}: {
  status: CmsDnsStatus | null;
  loading: boolean;
  error: string;
  onCheck: () => void;
  adminUrl: string;
  currentDomain: string;
  onEditDomain: () => void;
}) {
  const domainActions = (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" className="px-4" onClick={onEditDomain}>
        <PencilIcon className="size-4" />
        تغییر دامنه
      </Button>
      <SecondaryButton onClick={onCheck} disabled={loading}>
        <RefreshCwIcon className="size-4" />
        {loading ? "در حال بررسی…" : "بررسی DNS"}
      </SecondaryButton>
    </div>
  );

  // The domain is latin text inside a Persian card, so it is its own LTR line
  // rather than a value interpolated into an RTL sentence.
  const domainLine = (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span>دامنهٔ فعلی:</span>
      <span dir="ltr" className="font-medium">
        {currentDomain}
      </span>
    </span>
  );

  if (!status) {
    return (
      <SectionCard title="دامنه و انتشار سایت" description={domainLine} actions={domainActions}>
        <ErrorBox>{error}</ErrorBox>
        {loading ? (
          <LoadingSkeleton rows={3} compact label="در حال بررسی وضعیت DNS" />
        ) : (
          <EmptyState>{error ? "بررسی انجام نشد؛ دوباره تلاش کنید." : "برای بررسی، «بررسی DNS» را بزنید."}</EmptyState>
        )}
      </SectionCard>
    );
  }

  const target = status.dns.cmsAddresses[0] ?? null;
  const steps = [
    {
      key: "resolved",
      // Step one is about the *owner's* domain, not the CMS host. The old copy
      // named cms.eshobe.com here, which reads as "add a record for our host".
      done: status.dns.resolved,
      label: (
        <>
          برای <span dir="ltr" className="font-medium">{currentDomain}</span> رکورد A یا CNAME ساخته شود
        </>
      ),
    },
    {
      key: "pointing",
      done: status.dns.pointingToCms,
      label: (
        <>
          دامنه به سرور سایت‌ساز اشاره کند{" "}
          {target ? <CopyableValue value={target} label="آدرس سرور" /> : <span dir="ltr">{status.dns.cmsHost}</span>}
        </>
      ),
    },
    {
      key: "verified",
      // `null` (descriptor unreadable) is not «done», and it is not the
      // owner's unfinished task either — the pill below says which it is.
      done: status.domainVerified === true,
      unknown: status.domainVerified === null,
      label: <>در پنل سایت‌ساز: مدیریت سایت ← تأیید دامنه روشن شود</>,
    },
  ];

  const doneCount = steps.filter((step) => step.done).length;

  return (
    <SectionCard
      title="دامنه و انتشار سایت"
      description={domainLine}
      actions={domainActions}
    >
      <ErrorBox>{error}</ErrorBox>
      <p className="mb-3 text-xs text-muted-foreground">
        {toPersianDigits(doneCount)} از {toPersianDigits(steps.length)} گام انجام شده است.
      </p>
      {/* aria-busy so a re-check announces itself rather than silently
          swapping the ticks under a screen reader. */}
      <ol className="space-y-2" aria-busy={loading}>
        {steps.map((step) => (
          <li key={step.key} className="flex items-start gap-2.5 text-sm">
            {step.done ? (
              <CircleCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-amber-400 dark:bg-amber-400" />
            )}
            <span className="min-w-0">
              {/* The state is spoken, not inferred from a colour or from a
                  strike-through — both are invisible to a screen reader. */}
              <span className="sr-only">{step.done ? "انجام شده: " : "در انتظار: "}</span>
              <span className={step.done ? "text-muted-foreground" : "text-foreground"}>{step.label}</span>
              {step.unknown ? (
                <span className="ms-2 text-xs text-muted-foreground">(وضعیت خوانده نشد)</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 rounded-xl bg-muted px-3 py-2.5 text-xs leading-5 text-muted-foreground">
        {cmsDnsHint(status)}
      </p>
      <div className="mt-3">
        <Button asChild variant="outline" className="px-4">
          <a href={adminUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLinkIcon className="size-4" />
            باز کردن مدیریت سایت‌ساز
          </a>
        </Button>
      </div>
    </SectionCard>
  );
}

/**
 * The CDN zone, and the one button on it that is safely the business's own:
 * emptying their edge cache.
 *
 * Both endpoints existed with no caller, so an owner who changed a price and
 * saw the old one cached had no way to clear it from here. Creating or syncing
 * a zone stays platform-staff work on the CMS, so this card reads and purges,
 * nothing more.
 */
function CdnCard() {
  const [cdn, setCdn] = useState<SiteCdnStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [purging, setPurging] = useState(false);
  const run = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(() => {
    const token = ++run.current;
    setLoading(true);
    api<{ cdn: SiteCdnStatus; error?: string }>("/api/cms/website/cdn").then(({ ok, data }) => {
      if (!alive.current || token !== run.current) return;
      setLoading(false);
      if (ok) {
        setCdn(data.cdn);
        setError("");
        setErrorCode("");
      } else {
        setError(errorMessageOrRaw(data.error));
        setErrorCode(data.error ?? "");
      }
    });
  }, []);
  useEffect(load, [load]);

  async function purge() {
    setPurging(true);
    const { ok, data } = await api<{ error?: string }>("/api/cms/website/cdn/purge", { method: "POST" });
    if (!alive.current) return;
    setPurging(false);
    if (!ok) {
      toast.error(errorMessageOrRaw(data.error));
      return;
    }
    toast.success("کش لبه خالی شد؛ نسخهٔ تازه تا چند لحظه دیگر سرو می‌شود.");
    load();
  }

  if (loading) return <SectionCardSkeleton rows={3} />;

  // A CMS too old to know about CDN zones is not an error worth a red box on
  // this screen — the rest of the workbench works fine without it, so the card
  // removes itself rather than accusing the owner of a misconfiguration.
  if (errorCode === "cms_old_version") return null;

  const actions = (
    <div className="flex flex-wrap gap-2">
      <SecondaryButton onClick={load} disabled={loading}>
        <RefreshCwIcon className="size-4" />
        بررسی دوباره
      </SecondaryButton>
      {cdn?.configured ? (
        <Button type="button" variant="outline" className="px-4" onClick={purge} disabled={purging}>
          <EraserIcon className="size-4" />
          {purging ? "در حال خالی کردن…" : "خالی کردن کش"}
        </Button>
      ) : null}
    </div>
  );

  return (
    <SectionCard
      title="شبکهٔ توزیع محتوا (CDN)"
      description="سایت از سرورهای لبه سرو می‌شود تا سریع‌تر باز شود."
      actions={actions}
    >
      <ErrorBox>{error}</ErrorBox>
      {!cdn ? (
        <EmptyState>وضعیت CDN خوانده نشد.</EmptyState>
      ) : !cdn.configured ? (
        <EmptyState>برای این سایت CDN تنظیم نشده است؛ سایت مستقیم از سرور سرو می‌شود.</EmptyState>
      ) : (
        <dl className="grid gap-x-4 gap-y-2.5 text-sm sm:grid-cols-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2 sm:block">
            <dt className="text-xs text-muted-foreground">وضعیت</dt>
            <dd className="mt-0.5">
              <StatusBadge tone={cdn.active ? "positive" : "active"}>
                {cdn.active ? "فعال" : "غیرفعال"}
              </StatusBadge>
            </dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-2 sm:block">
            <dt className="text-xs text-muted-foreground">ارائه‌دهنده</dt>
            <dd className="mt-0.5 text-foreground">{cdn.provider ? CDN_PROVIDER_LABELS[cdn.provider] : "—"}</dd>
          </div>
          {cdn.zoneName ? (
            <div className="flex flex-wrap items-baseline justify-between gap-2 sm:block">
              <dt className="text-xs text-muted-foreground">زون</dt>
              <dd dir="ltr" className="mt-0.5 min-w-0 truncate text-start text-foreground">{cdn.zoneName}</dd>
            </div>
          ) : null}
          {cdn.lastPurgeAt ? (
            <div className="flex flex-wrap items-baseline justify-between gap-2 sm:block">
              <dt className="text-xs text-muted-foreground">آخرین خالی‌سازی کش</dt>
              <dd className="mt-0.5 text-foreground">{toPersianDigits(formatJalali(cdn.lastPurgeAt))}</dd>
            </div>
          ) : null}
        </dl>
      )}
      {cdn?.configured && cdn.nameservers.length > 0 ? (
        <div className="mt-3 rounded-xl bg-muted px-3 py-2.5">
          <p className="text-xs text-muted-foreground">
            نِیم‌سرورهای دامنه باید در پنل ثبت‌کنندهٔ دامنه روی این مقادیر تنظیم باشند:
          </p>
          <ul className="mt-1.5 space-y-1">
            {cdn.nameservers.map((ns) => (
              <li key={ns}>
                <CopyableValue value={ns} label="نیم‌سرور" />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {cdn?.configured && cdn.lastSyncOk === false && cdn.lastSyncDetail ? (
        <InfoBox>آخرین همگام‌سازی با ارائه‌دهنده ناموفق بود: {cdn.lastSyncDetail}</InfoBox>
      ) : null}
    </SectionCard>
  );
}

function PreviewCard({
  status,
  ready,
  frameKey,
  onLoad,
  onRefresh,
}: {
  status: CmsDnsStatus | null;
  ready: boolean;
  frameKey: number;
  onLoad: () => void;
  onRefresh: () => void;
}) {
  // One definition of "live", shared with the checklist card through the pure
  // module — two spellings of it is how the two cards end up disagreeing about
  // whether the site is on the internet.
  const live = status ? isSiteLive(status) : false;
  const url = status?.previewUrl ?? "";

  return (
    <SectionCard
      title="پیش‌نمایش سایت"
      description="سایت واقعی، همان‌طور که بازدیدکننده می‌بیند."
      actions={
        <div className="flex flex-wrap gap-2">
          {live ? (
            <SecondaryButton onClick={onRefresh}>
              <RefreshCwIcon className="size-4" />
              بارگذاری مجدد
            </SecondaryButton>
          ) : null}
          {/* Was a window.open onto "#" before DNS resolved, which opened a
              blank tab onto this very page. No address, no button. */}
          {url ? (
            <Button asChild variant="outline" className="px-4">
              <a href={url} target="_blank" rel="noopener noreferrer">
                <ExternalLinkIcon className="size-4" />
                باز کردن سایت
              </a>
            </Button>
          ) : null}
        </div>
      }
    >
      {!live ? (
        <div className="space-y-2">
          <EmptyState>
            {status
              ? "برای فعال‌شدن پیش‌نمایش، مراحل «دامنه و انتشار سایت» را کامل کنید (DNS + تأیید دامنه)."
              : "برای فعال‌شدن پیش‌نمایش، «بررسی DNS» را بزنید."}
          </EmptyState>
          <p className="text-xs leading-5 text-muted-foreground">
            پیش‌نمایش از همان دامنهٔ سایت بارگذاری می‌شود، پس تا وقتی DNS و تأیید کامل نشده‌اند باز نمی‌شود. برای
            اجازهٔ جاسازی، خاستگاه این پنل باید در متغیر <code dir="ltr">SITE_PREVIEW_ORIGINS</code> سرور سایت‌ساز باشد.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <div dir="ltr" className="flex items-center gap-2 border-b border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            <ShieldCheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span className="min-w-0 truncate">{url}</span>
          </div>
          {/* key remounts the frame on refresh so the page reloads cleanly.
              The height is viewport-relative with a floor: a fixed 560px left
              a phone scrolling a letterbox and wasted half a desktop screen. */}
          <div className="relative h-[60vh] min-h-80 sm:h-[560px]">
            {!ready ? (
              <div
                role="status"
                aria-live="polite"
                aria-busy="true"
                aria-label="در حال بارگذاری پیش‌نمایش سایت"
                className="absolute inset-0 z-10 bg-card p-4"
              >
                <Skeleton aria-hidden="true" className="h-full w-full rounded-xl" />
              </div>
            ) : null}
            <iframe
              key={frameKey}
              src={url}
              title="پیش‌نمایش سایت"
              /* The site is the business's own, but it is still a third-party
                 origin rendering inside the dashboard: keep it from steering
                 the parent frame or opening dialogs over it. */
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              referrerPolicy="strict-origin-when-cross-origin"
              loading="lazy"
              className={`h-full w-full bg-card transition-opacity motion-reduce:transition-none ${ready ? "opacity-100" : "opacity-0"}`}
              onLoad={onLoad}
            />
          </div>
        </div>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Posts, products and domain — create/edit/delete dialogs             */
/* ------------------------------------------------------------------ */

export function PostDialog({
  post,
  onClose,
  onSaved,
}: {
  post: CmsPost | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(post?.title ?? "");
  // New editor contract is Markdown. Existing CMS posts come back from the
  // same Lexical shape, so translating them here preserves the supported rich
  // formatting instead of flattening every heading/list on the next save.
  const [content, setContent] = useState(lexicalToMarkdown(post?.content));
  const [slug, setSlug] = useState(post?.slug ?? "");
  const [excerpt, setExcerpt] = useState((post as (CmsPost & { excerpt?: string | null }) | null)?.excerpt ?? "");
  const initialHero = post?.heroImage;
  const [heroImageId, setHeroImageId] = useState(typeof initialHero === "string" ? initialHero : initialHero?.id ?? "");
  const [heroImageUrl, setHeroImageUrl] = useState(typeof initialHero === "object" ? initialHero?.url ?? "" : "");
  const [uploadingImage, setUploadingImage] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const uploadHeroImage = async (file: File | null) => {
    if (!file) return;
    setUploadingImage(true); setError("");
    const form = new FormData();
    form.set("file", file);
    const { ok, data } = await api<{ media?: { id: string; url: string | null }; error?: string }>("/api/cms/website/media", { method: "POST", body: form });
    setUploadingImage(false);
    if (!ok || !data.media) { setError(errorMessageOrRaw(data.error)); return; }
    setHeroImageId(data.media.id);
    setHeroImageUrl(data.media.url ?? "");
  };

  const save = async () => {
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>(
      post ? `/api/cms/website/drafts/${post.id}` : "/api/cms/website/drafts",
      { method: post ? "PATCH" : "POST", body: JSON.stringify({ title: title.trim(), body: content, slug: slug.trim() || undefined, excerpt: excerpt.trim() || undefined, featuredImageId: heroImageId || undefined }) },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessageOrRaw(data.error));
      return;
    }
    toast.success(post ? "نوشته ذخیره شد." : "نوشته ساخته شد.");
    onSaved();
  };

  const remove = async () => {
    if (!post || !window.confirm(`«${post.title}» حذف شود؟`)) return;
    setBusy(true);
    const { ok, data } = await api<{ error?: string }>(`/api/cms/website/posts/${post.id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      setError(errorMessageOrRaw(data.error));
      return;
    }
    toast.success("نوشته حذف شد.");
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{post ? `ویرایش نوشته` : "نوشتهٔ جدید"}</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>

        <Field label="عنوان">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="نشانک (slug)" hint="آدرس نوشته؛ فقط حروف، عدد و خط تیره. خالی = ساخت خودکار از عنوان.">
          <input dir="ltr" className={inputClass} value={slug} onChange={(e) => setSlug(e.target.value)} />
        </Field>
        <Field label="خلاصه" hint="برای کارت‌ها و نتایج جست‌وجوی سایت.">
          <textarea className={inputClass} rows={2} value={excerpt} onChange={(e) => setExcerpt(e.target.value)} />
        </Field>
        <Field label="تصویر شاخص" hint="JPG، PNG، WebP یا GIF تا ۵ مگابایت؛ اعتبارسنجی روی سرور انجام می‌شود.">
          <div className="space-y-2"><input className={inputClass} type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={uploadingImage || busy} onChange={(e) => void uploadHeroImage(e.target.files?.[0] ?? null)} />{uploadingImage ? <LoadingSkeleton aria-label="در حال بارگذاری تصویر" className="h-4 w-36" /> : null}{heroImageUrl ? <img src={heroImageUrl} alt="پیش‌نمایش تصویر شاخص" className="h-28 w-full rounded-lg object-cover" /> : heroImageId ? <p className="text-xs text-muted-foreground">تصویر شاخص وصل شده است.</p> : <p className="text-xs text-muted-foreground">تصویری انتخاب نشده است.</p>}</div>
        </Field>
        <Field label="متن Markdown" hint="پیش‌نویس و انتشار جدا هستند؛ ذخیره هرگز نوشته را عمومی نمی‌کند.">
          <textarea className={`${inputClass} font-mono`} dir="auto" rows={10} value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>

        <DialogFooter>
          {post ? (
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
            {busy ? "در حال ذخیره…" : "ذخیره"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProductDialog({
  product,
  currency,
  onClose,
  onSaved,
}: {
  product: CmsProduct | null;
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(product?.title ?? "");
  const [summary, setSummary] = useState(product?.summary ?? "");
  const [price, setPrice] = useState(product ? String(product.price) : "");
  const [sku, setSku] = useState(product?.sku ?? "");
  const [trackInventory, setTrackInventory] = useState(Boolean(product?.trackInventory));
  const [inventory, setInventory] = useState(product?.inventory !== undefined && product?.inventory !== null ? String(product.inventory) : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>(
      product ? `/api/cms/website/products/${product.id}` : "/api/cms/website/products",
      {
        method: product ? "PATCH" : "POST",
        body: JSON.stringify({
          title: title.trim(),
          summary: summary.trim() || undefined,
          price: Number(toLatinDigits(price).replace(/[^\d]/g, "")) || 0,
          sku: sku.trim() || undefined,
          trackInventory,
          inventory: trackInventory ? Number(toLatinDigits(inventory).replace(/[^\d]/g, "")) || 0 : undefined,
        }),
      },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessageOrRaw(data.error));
      return;
    }
    toast.success(product ? "محصول ذخیره شد." : "محصول ساخته شد.");
    onSaved();
  };

  const remove = async () => {
    if (!product || !window.confirm(`«${product.title}» حذف شود؟`)) return;
    setBusy(true);
    const { ok, data } = await api<{ error?: string }>(`/api/cms/website/products/${product.id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      setError(errorMessageOrRaw(data.error));
      return;
    }
    toast.success("محصول حذف شد.");
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{product ? "ویرایش محصول" : "محصول جدید"}</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>

        <Field label="عنوان">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="توضیح کوتاه (اختیاری)">
          <textarea className={inputClass} rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
        <Field label={`قیمت (${currency})`}>
          <input
            className={inputClass}
            value={toPersianDigits(price)}
            onChange={(e) => setPrice(toLatinDigits(e.target.value).replace(/[^\d]/g, ""))}
          />
        </Field>
        <Field label="کد کالا (اختیاری)">
          <input className={inputClass} dir="ltr" value={sku} onChange={(e) => setSku(e.target.value)} />
        </Field>
        <label className="mb-3 flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={trackInventory}
            onChange={(e) => setTrackInventory(e.target.checked)}
            className="size-4 rounded border-input"
          />
          موجودی را بشمار
        </label>
        {trackInventory ? (
          <Field label="موجودی">
            <input
              className={inputClass}
              value={toPersianDigits(inventory)}
              onChange={(e) => setInventory(toLatinDigits(e.target.value).replace(/[^\d]/g, ""))}
            />
          </Field>
        ) : null}

        <DialogFooter>
          {product ? (
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
            {busy ? "در حال ذخیره…" : "ذخیره"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DomainDialog({
  currentDomain,
  onClose,
  onSaved,
}: {
  currentDomain: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [domain, setDomain] = useState(currentDomain);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>("/api/cms/website/domain", {
      method: "PATCH",
      body: JSON.stringify({ domain: domain.trim() }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessageOrRaw(data.error));
      return;
    }
    toast.success("دامنه تغییر کرد؛ حالا باید دوباره تأیید شود.");
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>تغییر دامنه</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>
        <p className="mb-3 text-xs leading-5 text-muted-foreground">
          پس از تغییر، وضعیت «تأیید دامنه» بازنشانی می‌شود و باید دوباره DNS تنظیم و در پنل CMS تأیید شود.
        </p>
        <Field label="دامنهٔ جدید" hint="فقط میزبان — مثل acme.ir">
          <input className={inputClass} dir="ltr" value={domain} onChange={(e) => setDomain(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            انصراف
          </Button>
          <Button type="button" onClick={save} disabled={busy}>
            {busy ? "در حال ذخیره…" : "ذخیره"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
