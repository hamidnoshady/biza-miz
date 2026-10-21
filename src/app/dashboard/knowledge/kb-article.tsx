"use client";

/**
 * The knowledge-base article view: the same side menu as the home browser,
 * the article body rendered by the shared KbMarkdown (anchored headings,
 * images, code blocks with copy), its video inline above the body, a «فهرست
 * این راهنما» of the anchored headings, the tag chips that filter the centre,
 * and the related guides the service picked (same category or shared
 * section).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRightIcon,
  BookOpenIcon,
  ClockIcon,
  PlayCircleIcon,
  TagIcon,
} from "lucide-react";
import { KbMarkdown, KbToc, KbVideo } from "@/components/knowledge/kb-markdown";
import { Skeleton } from "@/components/ui/skeleton";
import {
  kbHeadingTargetForHash,
  kbHeadings,
  scrollToKbHeading,
  type KbArticleDetail,
  type KbCataloguePayload,
} from "@/lib/knowledge";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { knowledgePage, knowledgeSection } from "@/lib/knowledge-base";
import { api, ErrorBox } from "../ui";
import { PageHeader, PageShell, cardClass } from "../page-chrome";
import { articleHref, KbSearchResults, KbSideMenuFrame, useKbSearch } from "./kb-nav";

function KbArticleSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="در حال آماده‌سازی راهنما" className="space-y-4">
      <div aria-hidden="true" className="space-y-3">
        <Skeleton className="h-8 w-2/3 rounded-lg" />
        <Skeleton className="h-4 w-1/3" />
      </div>
      <div aria-hidden="true" className={`${cardClass} space-y-3 p-5`}>
        {[90, 100, 96, 80, 100, 60].map((w, i) => (
          <Skeleton key={i} style={{ width: `${w}%` }} className="h-3.5" />
        ))}
      </div>
    </div>
  );
}

export function KbArticleView({ slug }: { slug: string }) {
  const [catalogue, setCatalogue] = useState<KbCataloguePayload | null>(null);
  const [catalogueError, setCatalogueError] = useState("");
  const [catalogueKey, setCatalogueKey] = useState(0);
  const [article, setArticle] = useState<KbArticleDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const search = useKbSearch();

  useEffect(() => {
    let cancelled = false;
    setCatalogueError("");
    api<KbCataloguePayload>("/api/knowledge/catalogue").then(({ ok, data, aborted }) => {
      if (cancelled || aborted) return;
      if (ok) setCatalogue(data);
      else setCatalogueError("فهرست راهنماها بارگذاری نشد.");
    });
    return () => {
      cancelled = true;
    };
  }, [catalogueKey]);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setArticle(null);
    api<{ article: KbArticleDetail }>(`/api/knowledge/articles/${encodeURIComponent(slug)}`).then(
      ({ ok, status: code, data, aborted }) => {
        if (cancelled || aborted) return;
        if (ok && data.article) {
          setArticle(data.article);
          setStatus("ready");
        } else {
          setStatus(code === 404 ? "missing" : "error");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [slug, reloadKey]);

  const headings = useMemo(() => (article ? kbHeadings(article.bodyMd) : []), [article]);

  /*
   * Deep links (#تیتر) arrive before the body has been fetched, so the
   * browser's own fragment scroll happens against an empty document. Once the
   * article is rendered, resolve the hash against `kbHeadings` and scroll with
   * the sticky-header offset. Listening to `hashchange` covers in-page anchor
   * links and Back/Forward between two headings of the same article.
   */
  useEffect(() => {
    if (status !== "ready" || !article || !headings.length) return;
    let cancelled = false;
    let frame = 0;
    const scroll = () => {
      if (cancelled) return;
      const target = kbHeadingTargetForHash(window.location.hash, headings);
      if (target) scrollToKbHeading(target, { smooth: false, updateHash: false });
    };
    // Two frames: ReactMarkdown has mounted and the browser has laid out the
    // RTL text; one frame can still measure pre-layout positions.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(scroll);
    });
    window.addEventListener("hashchange", scroll);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", scroll);
    };
  }, [status, article, headings]);

  const retryArticle = useCallback(() => setReloadKey((value) => value + 1), []);
  const retryCatalogue = useCallback(() => setCatalogueKey((value) => value + 1), []);
  const categoryTitle = useMemo(
    () => catalogue?.categories.find((c) => c.id === article?.categoryId)?.title ?? null,
    [catalogue, article],
  );
  const sectionLabels = useMemo(
    () =>
      (article?.sectionKeys ?? [])
        .map((key) => knowledgePage(key)?.label ?? knowledgeSection(key)?.label)
        .filter((x): x is string => Boolean(x)),
    [article],
  );

  return (
    <PageShell>
      <div className="mb-4">
        <Link
          href="/knowledge"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowRightIcon className="size-4" aria-hidden="true" />
          بازگشت به مرکز آموزش
        </Link>
      </div>

      <div className="flex items-start gap-6">
        <KbSideMenuFrame
          catalogue={catalogue}
          query={search.query}
          onQueryChange={search.onQueryChange}
          searching={search.searching}
          activeSlug={article?.slug}
          error={catalogueError}
          onRetry={retryCatalogue}
        />

        <div className="min-w-0 flex-1">
          {search.query.trim() ? (
            <KbSearchResults
              query={search.query}
              results={search.results}
              searching={search.searching}
              error={search.error}
              onRetry={search.retry}
            />
          ) : status === "loading" ? (
            <KbArticleSkeleton />
          ) : status === "missing" || status === "error" || !article ? (
            <div className={`${cardClass} flex flex-col items-center gap-3 px-4 py-12 text-center`}>
            <BookOpenIcon className="size-10 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm font-semibold text-foreground">
                {status === "missing" ? "این راهنما پیدا نشد یا هنوز منتشر نشده است." : "بارگذاری راهنما ممکن نشد."}
              </p>
              {status === "error" ? <ErrorBox>لطفاً چند لحظهٔ دیگر دوباره تلاش کنید.</ErrorBox> : null}
              {status === "error" ? (
                <button
                  type="button"
                  onClick={retryArticle}
                  className="mt-1 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
                >
                  تلاش دوباره
                </button>
              ) : null}
              <Link
                href="/knowledge"
                className="mt-1 rounded-lg border border-border/80 px-4 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted"
              >
                رفتن به مرکز آموزش
              </Link>
            </div>
          ) : (
            <article className="space-y-6">
              <PageHeader title={article.title} description={article.summary || undefined} />

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                {categoryTitle ? (
                  <span className="inline-flex items-center gap-1.5">
                    <BookOpenIcon className="size-3.5" aria-hidden="true" />
                    {categoryTitle}
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-1.5">
                  <ClockIcon className="size-3.5" aria-hidden="true" />
                  به‌روزرسانی: {toPersianDigits(formatJalali(article.updatedAt, { withMonthName: true }))}
                </span>
                {sectionLabels.length > 0 ? (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <span>بخش‌های مرتبط:</span>
                    {sectionLabels.map((label) => (
                      <span
                        key={label}
                        className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {label}
                      </span>
                    ))}
                  </span>
                ) : null}
              </div>

              <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_240px]">
                <div className={`${cardClass} p-5 sm:p-7`}>
                  {article.coverImageUrl ? (

                    <img
                      src={article.coverImageUrl}
                      alt={article.title}
                      loading="lazy"
                      className="mb-6 max-h-[360px] w-full rounded-xl border border-border object-contain"
                    />
                  ) : null}

                  {article.videoUrl ? <KbVideo url={article.videoUrl} tone="auto" /> : null}

                  <KbMarkdown content={article.bodyMd} tone="auto" />

                  {article.tags.length > 0 ? (
                    <div className="mt-8 flex flex-wrap items-center gap-1.5 border-t border-border/70 pt-4">
                      <TagIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                      {article.tags.map((t) => (
                        <Link
                          key={t.slug}
                          href={`/knowledge?tag=${encodeURIComponent(t.slug)}`}
                          className="rounded-full border border-border/80 bg-muted/60 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          #{t.label}
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </div>

                {headings.length > 0 ? (
                  <aside className="hidden xl:block" aria-label="فهرست این راهنما">
                    <div className={`sticky top-4 p-3 ${cardClass}`}>
                      <KbToc headings={headings} />
                    </div>
                  </aside>
                ) : null}
              </div>

              {headings.length > 0 ? (
                <div className={`p-4 xl:hidden ${cardClass}`}>
                  <KbToc headings={headings} />
                </div>
              ) : null}

              {article.related.length > 0 ? (
                <section aria-label="راهنماهای مرتبط" className={`${cardClass} p-4 sm:p-5`}>
                  <h2 className="mb-3 text-sm font-semibold text-foreground">راهنماهای مرتبط</h2>
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {article.related.map((rel) => (
                      <li key={rel.id}>
                        <Link
                          href={articleHref(rel.slug)}
                          className="flex items-center gap-2 rounded-xl border border-border/70 px-3 py-2.5 text-sm transition-colors hover:bg-muted/50"
                        >
                          {rel.hasVideo ? (
                            <PlayCircleIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                          ) : (
                            <BookOpenIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                          )}
                          <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">
                            {rel.title}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </article>
          )}
        </div>
      </div>
    </PageShell>
  );
}
