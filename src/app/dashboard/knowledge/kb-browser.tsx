"use client";

/**
 * The knowledge centre's home browser. Three main-pane modes, one side menu:
 *
 *  - **home**      — every category as a card (icon, description, article
 *                    count) plus the latest guides, the way in by subject;
 *  - **search**    — typing in the side menu's box (or the hero) swaps the
 *                    pane for ranked full-text hits with highlighted titles
 *                    and a snippet around the first hit;
 *  - **tag**       — a tag chip (#چاپ، #آفلاین…) lists that tag's articles.
 *
 * Loading reserves its shape with *Skeleton blocks (project-wide rule), in
 * the amber/teal/warm-stone language of the dashboard.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeftIcon,
  BookOpenIcon,
  ClockIcon,
  FolderOpenIcon,
  PlayCircleIcon,
  TagIcon,
} from "lucide-react";
import {
  buildKbCategoryTree,
  type KbArticleListItem,
  type KbCataloguePayload,
} from "@/lib/knowledge";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { api, ErrorBox } from "../ui";
import { cardClass, PageHeader, PageShell, SectionCard } from "../page-chrome";
import { articleHref, Highlighted, KbSearchResults, KbSideMenuFrame, useKbSearch } from "./kb-nav";

function KbHomeSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="در حال آماده‌سازی مرکز آموزش">
      <div aria-hidden="true" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-32 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

/** A failed catalogue load is a visible, retryable state — never a skeleton forever. */
function KbLoadFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className={`${cardClass} flex flex-col items-start gap-3 p-5`}>
      <p className="text-sm font-semibold text-foreground">مرکز آموزش بارگذاری نشد</p>
      <ErrorBox>{message}</ErrorBox>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg border border-border/80 px-4 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted"
      >
        تلاش دوباره
      </button>
    </div>
  );
}

function ArticleRow({ article, query }: { article: KbArticleListItem; query?: string }) {
  return (
    <li>
      <Link
        href={articleHref(article.slug)}
        className="flex items-start gap-3 rounded-xl border border-border/70 bg-card px-4 py-3 transition-colors hover:bg-muted/40"
      >
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          {article.hasVideo ? (
            <PlayCircleIcon className="size-5" aria-label="دارای ویدیو" />
          ) : (
            <BookOpenIcon className="size-5" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-foreground">
            {query ? <Highlighted text={article.title} query={query} /> : article.title}
          </span>
          {article.summary ? (
            <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-muted-foreground">
              {query ? <Highlighted text={article.summary} query={query} /> : article.summary}
            </span>
          ) : null}
          <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/80">
            {article.tags.slice(0, 3).map((t) => (
              <span key={t.slug} className="inline-flex items-center gap-0.5">
                <TagIcon className="size-3" aria-hidden="true" />
                {t.label}
              </span>
            ))}
            <span className="inline-flex items-center gap-1">
              <ClockIcon className="size-3" aria-hidden="true" />
              {toPersianDigits(formatJalali(article.updatedAt, { withMonthName: true }))}
            </span>
          </span>
        </span>
        <ArrowLeftIcon className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    </li>
  );
}

export function KnowledgeBrowser({ initialTag }: { initialTag: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [catalogue, setCatalogue] = useState<KbCataloguePayload | null>(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  // The URL is the source of truth for the tag filter. `initialTag` seeds the
  // first render; every later navigation (chip, clear, back/forward) arrives
  // through `?tag=` and is applied below.
  const urlTag = searchParams.get("tag") ?? "";
  const [activeTag, setActiveTag] = useState(initialTag);
  const search = useKbSearch();

  useEffect(() => {
    setActiveTag(urlTag);
  }, [urlTag]);

  useEffect(() => {
    let cancelled = false;
    setError("");
    api<KbCataloguePayload>("/api/knowledge/catalogue").then(({ ok, data, aborted }) => {
      if (cancelled || aborted) return;
      if (ok) setCatalogue(data);
      else setError("بارگذاری مرکز آموزش ممکن نشد. دوباره تلاش کنید.");
    });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  /** Write the tag filter to the URL; `push` keeps Back/Forward meaningful. */
  const setTag = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next) params.set("tag", next);
      else params.delete("tag");
      const query = params.toString();
      setActiveTag(next);
      router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const tree = useMemo(
    () => (catalogue ? buildKbCategoryTree(catalogue.categories) : []),
    [catalogue],
  );

  const articleCountByCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of catalogue?.articles ?? []) {
      map.set(a.categoryId ?? "", (map.get(a.categoryId ?? "") ?? 0) + 1);
    }
    return map;
  }, [catalogue]);

  const latest = useMemo(
    () =>
      (catalogue?.articles ?? [])
        .slice()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 6),
    [catalogue],
  );

  const tagArticles = useMemo(() => {
    if (!activeTag || !catalogue) return [];
    return catalogue.articles.filter((a) => a.tags.some((t) => t.slug === activeTag));
  }, [activeTag, catalogue]);

  const knownTag = catalogue?.tags.find((t) => t.slug === activeTag) ?? null;
  const unknownTag = Boolean(activeTag) && catalogue !== null && !knownTag;
  const tagLabel = knownTag?.label ?? activeTag;
  const searching = search.query.trim() !== "";

  // A root card's count includes its children's articles, so «مشتریان و رشد»
  // shows the real total even when its guides hang on the sub-categories.
  const totalCount = useCallback(
    (id: string): number => {
      const find = (nodes: typeof tree): (typeof tree)[number] | null => {
        for (const n of nodes) {
          if (n.id === id) return n;
          const hit = find(n.children);
          if (hit) return hit;
        }
        return null;
      };
      const node = find(tree);
      if (!node) return articleCountByCategory.get(id) ?? 0;
      const ids = [node.id, ...node.children.flatMap(function collect(n): string[] {
        return [n.id, ...n.children.flatMap(collect)];
      })];
      return ids.reduce((sum, cid) => sum + (articleCountByCategory.get(cid) ?? 0), 0);
    },
    [tree, articleCountByCategory],
  );

  return (
    <PageShell>
      <PageHeader
        title="مرکز آموزش"
        description="راهنمای کامل پلتفرم: هر بخش را قدم‌به‌قدم بیاموزید، تیترها پیوند لنگری دارند و راهنماها متن، تصویر، ویدیو و نمونه‌کد را کنار هم نشان می‌دهند."
      />

      <div className="flex items-start gap-6">
        <KbSideMenuFrame
          catalogue={catalogue}
          query={search.query}
          onQueryChange={search.onQueryChange}
          searching={search.searching}
        />

        <div className="min-w-0 flex-1">
          {catalogue === null ? (
            error ? (
              <KbLoadFailure message={error} onRetry={() => setReloadKey((value) => value + 1)} />
            ) : (
              <KbHomeSkeleton />
            )
          ) : searching ? (
            /* --- search mode ------------------------------------------------ */
            <KbSearchResults
              query={search.query}
              results={search.results}
              searching={search.searching}
              error={search.error}
              onRetry={search.retry}
            />
          ) : unknownTag ? (
            /* --- unknown tag (bookmark from an old/removed tag) ------------ */
            <SectionCard
              title="برچسب پیدا نشد"
              description="این برچسب حذف شده یا هنوز منتشر نشده است."
              actions={
                <button
                  type="button"
                  onClick={() => setTag("")}
                  className="rounded-lg border border-border/80 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  نمایش همهٔ راهنماها
                </button>
              }
            >
              <p className="py-6 text-center text-sm text-muted-foreground">
                از فهرست کناری یا برچسب‌های دیگر استفاده کنید.
              </p>
            </SectionCard>
          ) : activeTag ? (
            /* --- tag filter mode -------------------------------------------- */
            <SectionCard
              title={`#${tagLabel}`}
              description={`${formatPersianNumber(tagArticles.length)} راهنما با این برچسب`}
              actions={
                <button
                  type="button"
                  onClick={() => setTag("")}
                  className="rounded-lg border border-border/80 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  حذف فیلتر برچسب
                </button>
              }
            >
              {tagArticles.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  راهنمایی با این برچسب منتشر نشده است.
                </p>
              ) : (
                <ul className="space-y-2">
                  {tagArticles.map((a) => (
                    <ArticleRow key={a.id} article={a} />
                  ))}
                </ul>
              )}
            </SectionCard>
          ) : (
            /* --- home mode --------------------------------------------------- */
            <div className="space-y-6">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {tree.map((node) => (
                  <CategoryCard
                    key={node.id}
                    title={node.title}
                    icon={node.icon}
                    description={node.description}
                    articles={catalogue.articles.filter((a) => a.categoryId === node.id)}
                    count={totalCount(node.id)}
                  />
                ))}
              </div>

              {catalogue.articles.filter((a) => !a.categoryId).length > 0 ? (
                <SectionCard title="راهنماهای عمومی" description="بدون دسته‌بندی">
                  <ul className="space-y-2">
                    {catalogue.articles
                      .filter((a) => !a.categoryId)
                      .map((a) => (
                        <ArticleRow key={a.id} article={a} />
                      ))}
                  </ul>
                </SectionCard>
              ) : null}

              {latest.length > 0 ? (
                <SectionCard title="به‌روزترین راهنماها" description="آخرین تغییرات پایگاه دانش">
                  <ul className="space-y-2">
                    {latest.map((a) => (
                      <ArticleRow key={a.id} article={a} />
                    ))}
                  </ul>
                </SectionCard>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </PageShell>
  );
}

function CategoryCard({
  title,
  icon,
  description,
  articles,
  count,
}: {
  title: string;
  icon: string;
  description: string;
  articles: KbArticleListItem[];
  count: number;
}) {
  return (
    <section aria-label={title} className={`${cardClass} p-4`}>
      <h2 className="flex items-center gap-2 text-sm font-bold text-foreground">
        <span className="flex size-9 items-center justify-center rounded-xl bg-amber-100 text-base dark:bg-amber-500/20" aria-hidden="true">
          {icon || <FolderOpenIcon className="size-4 text-amber-800 dark:text-amber-300" />}
        </span>
        {title}
        <span className="ms-auto rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {formatPersianNumber(count)}
        </span>
      </h2>
      {description ? (
        <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{description}</p>
      ) : null}
      {articles.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {articles.slice(0, 4).map((a) => (
            <li key={a.id}>
              <Link
                href={articleHref(a.slug)}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
              >
                <BookOpenIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{a.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 px-2 text-xs text-muted-foreground/70">به‌زودی در این دسته راهنما می‌آید.</p>
      )}
    </section>
  );
}
