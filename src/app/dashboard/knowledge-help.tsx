"use client";

/**
 * «آموزش» — the knowledge-base icon that sits in a dashboard page's header.
 *
 * The super-admin can teach a section two ways (both from the console's
 * «پایگاه دانش»): an external learning-page URL per section (migration 0117),
 * opened here in a modal, and an in-product guide — a published
 * knowledge-base article claiming this section (migration 0131), which this
 * modal deep-links to «مرکز آموزش». Both can exist for one section; the
 * modal then offers the in-app guide first and the external page under it.
 *
 * Issue #972 — when the page also has a guided tour the member may use, the
 * same modal offers it first («تور تعاملی صفحه»): Start / Continue / Review,
 * with the member's progress. Choosing it closes the modal and hands over to
 * the workspace shell's single tour runtime. The two halves are independent —
 * the tour lookup is a separate request, so a failure there leaves the
 * article exactly as it was, and a page with no tour looks as it always did.
 * There is no second help button.
 *
 * Pages pass their own `section` key; a shared shell that spans several
 * sections (the Growth app's header) omits it and the current route resolves
 * the section instead. When nothing is stored yet — or the network fails —
 * the modal says so plainly; the icon never breaks the page it is mounted in.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeftIcon,
  BookOpenIcon,
  ExternalLinkIcon,
  CircleCheckIcon,
  GraduationCapIcon,
  PlayIcon,
  RotateCcwIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useTourRuntime } from "@/components/tours/tour-provider";
import { toPersianDigits } from "@/lib/digits";
import type { TourSummary } from "@/lib/tours";
import { knowledgePageForPathname, knowledgeSection, sectionForPathname } from "@/lib/knowledge-base";
import { api } from "./ui";

interface KnowledgeEntry {
  section: string;
  label: string;
  url: string;
}

interface KnowledgeGuide {
  slug: string;
  title: string;
}

type EntryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; entry: KnowledgeEntry | null; guide: KnowledgeGuide | null }
  | { status: "error" };

/** One tour offered by this page, with the member's progress and the Start/Continue/Review choices. */
function TourOption({
  tour,
  starting,
  failed,
  onStart,
}: {
  tour: TourSummary;
  starting: boolean;
  failed: boolean;
  onStart: (tour: TourSummary, fromStart: boolean) => void;
}) {
  const { progress } = tour;
  const inProgress = progress.status === "in_progress";
  const completed = progress.status === "completed";
  const primaryLabel = starting
    ? "در حال آماده‌سازی…"
    : completed
      ? "مرور دوباره"
      : inProgress
        ? "ادامهٔ تور"
        : "شروع تور";
  const statusLabel = completed
    ? "کامل شد"
    : inProgress
      ? `${toPersianDigits(progress.seenCount)} از ${toPersianDigits(progress.totalSteps)} مرحله دیده شد`
      : `${toPersianDigits(tour.stepCount)} مرحله`;
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          {completed ? (
            <CircleCheckIcon className="size-5" aria-hidden="true" />
          ) : (
            <PlayIcon className="size-5" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-foreground">{tour.title}</p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{tour.description}</p>
          <p className="mt-1 text-xs font-medium text-foreground/70">
            {statusLabel}
            {progress.outdated && !completed ? " — بخش‌هایی به‌روز شده‌اند" : ""}
          </p>
          {inProgress ? (
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="پیشرفت تور"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.percent}
            >
              <div className="h-full bg-primary" style={{ width: `${progress.percent}%` }} />
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={starting}
          onClick={() => onStart(tour, false)}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          <PlayIcon className="size-4" aria-hidden="true" />
          {primaryLabel}
        </button>
        {inProgress ? (
          <button
            type="button"
            disabled={starting}
            onClick={() => onStart(tour, true)}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border/80 px-3 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted disabled:opacity-60"
          >
            <RotateCcwIcon className="size-4" aria-hidden="true" />
            از ابتدا
          </button>
        ) : null}
      </div>
      {failed ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          شروع تور ممکن نشد؛ دوباره تلاش کنید.
        </p>
      ) : null}
    </div>
  );
}

export function KnowledgeHelpButton({ section }: { section?: string }) {
  const pathname = usePathname();
  const resolved = section
    ? knowledgeSection(section)
    : sectionForPathname(pathname ?? "");
  const resolvedKey = resolved?.key;
  const page = knowledgePageForPathname(pathname ?? "");
  const pageKey = page?.key;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<EntryState>({ status: "idle" });
  const [frameLoaded, setFrameLoaded] = useState(false);
  const tourRuntime = useTourRuntime();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [tours, setTours] = useState<TourSummary[]>([]);
  const [startingTourId, setStartingTourId] = useState<string | null>(null);
  const [failedTourId, setFailedTourId] = useState<string | null>(null);

  const fetchEntry = useCallback(async () => {
    if (!resolvedKey && !pageKey) return;
    setState({ status: "loading" });
    // The tour lookup never gates the article: its failure is an empty list.
    const toursRequest = pageKey
      ? api<{ tours?: TourSummary[] }>(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`)
          .then(({ ok, data }) => (ok && Array.isArray(data.tours) ? data.tours : []))
          .catch(() => [] as TourSummary[])
      : Promise.resolve([] as TourSummary[]);
    try {
      const params = new URLSearchParams();
      if (resolvedKey) params.set("section", resolvedKey);
      if (pageKey) params.set("page", pageKey);
      const [{ ok, data }, offeredTours] = await Promise.all([
        api<{
          entry: KnowledgeEntry | null;
          guide?: KnowledgeGuide | null;
        }>(`/api/knowledge?${params.toString()}`),
        toursRequest,
      ]);
      setTours(tourRuntime ? offeredTours : []);
      if (!ok) {
        setState({ status: "error" });
        return;
      }
      setState({ status: "ready", entry: data.entry ?? null, guide: data.guide ?? null });
    } catch {
      setState({ status: "error" });
    }
  }, [resolvedKey, pageKey, tourRuntime]);

  useEffect(() => {
    setState({ status: "idle" });
    setFrameLoaded(false);
    setTours([]);
    setFailedTourId(null);
  }, [resolvedKey, pageKey]);

  if (!resolved && !page) return null;

  const label = page?.label ?? resolved?.label ?? "";

  function openModal() {
    setFrameLoaded(false);
    setOpen(true);
    if (state.status === "idle" || state.status === "error") void fetchEntry();
  }

  const ready = state.status === "ready" ? state : null;

  async function startTour(tour: TourSummary, fromStart: boolean) {
    if (!tourRuntime || startingTourId) return;
    setStartingTourId(tour.id);
    setFailedTourId(null);
    const started = await tourRuntime.startTour(tour.id, {
      fromStart,
      returnFocus: triggerRef.current,
    });
    setStartingTourId(null);
    if (started) {
      // The tour runs on the live page, so the modal gets out of its way.
      setOpen(false);
      // Their progress changed; refetch on the next open.
      setState({ status: "idle" });
    } else {
      setFailedTourId(tour.id);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`آموزش ${label}`}
        title={`آموزش ${label}`}
        onClick={openModal}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <GraduationCapIcon className="size-5 shrink-0" aria-hidden="true" />
      </button>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>آموزش: {label}</DialogTitle>
          <DialogDescription>
            راهنمای این بخش — نسخهٔ کامل در مرکز آموزش، با قابلیت جست‌وجو و پیوند به هر تیتر.
          </DialogDescription>
        </DialogHeader>

        {tours.length > 0 && state.status !== "loading" ? (
          <section aria-labelledby="knowledge-tour-heading" className="space-y-2">
            <h3 id="knowledge-tour-heading" className="text-xs font-bold text-muted-foreground">
              تور تعاملی صفحه
            </h3>
            {tours.map((tour) => (
              <TourOption
                key={tour.id}
                tour={tour}
                starting={startingTourId === tour.id}
                failed={failedTourId === tour.id}
                onStart={(picked, fromStart) => void startTour(picked, fromStart)}
              />
            ))}
          </section>
        ) : null}

        {tours.length > 0 && state.status === "ready" && (state.entry || state.guide) ? (
          <h3 className="-mb-2 text-xs font-bold text-muted-foreground">راهنمای پایگاه دانش</h3>
        ) : null}

        {state.status === "loading" ? (
          <Skeleton className="h-[65svh] min-h-[320px] rounded-xl" />
        ) : state.status === "error" ? (
          <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-4 text-center">
            <p className="text-sm text-muted-foreground">
              صفحهٔ آموزشی بارگذاری نشد؛ دوباره تلاش کنید.
            </p>
            <button
              type="button"
              onClick={() => void fetchEntry()}
              className="rounded-lg border border-border/80 px-4 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted"
            >
              تلاش دوباره
            </button>
          </div>
        ) : ready && (ready.entry || ready.guide) ? (
          <div className="space-y-4">
            {ready.guide ? (
              <Link
                href={`/knowledge/a/${encodeURIComponent(ready.guide.slug)}`}
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-100/70 px-4 py-3 transition-colors hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/15 dark:hover:bg-amber-500/25"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-800 dark:bg-amber-500/25 dark:text-amber-200">
                  <BookOpenIcon className="size-5" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold text-amber-950 dark:text-amber-100">
                    راهنمای داخلی: {ready.guide.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-amber-900/70 dark:text-amber-200/70">
                    در مرکز آموزش باز کنید — جست‌وجو، فهرست محتوا و پیوند به هر تیتر فعال است.
                  </span>
                </span>
                <ArrowLeftIcon className="size-4 shrink-0 text-amber-800 dark:text-amber-200" aria-hidden="true" />
              </Link>
            ) : null}

            {ready.entry ? (
              <>
                <div className="relative h-[55svh] min-h-[300px]">
                  {!frameLoaded ? (
                    <div
                      role="status"
                      aria-live="polite"
                      aria-busy="true"
                      aria-label="در حال بارگذاری صفحه آموزشی"
                      className="absolute inset-0 z-10"
                    >
                      <Skeleton aria-hidden="true" className="h-full w-full rounded-xl" />
                    </div>
                  ) : null}
                  <iframe
                    src={ready.entry.url}
                    title={`آموزش ${label}`}
                    onLoad={() => setFrameLoaded(true)}
                    // Legacy learning pages are external by definition. The
                    // frame is sandboxed and sends no referrer; a host that
                    // refuses framing (X-Frame-Options/CSP) leaves the link
                    // below as the supported way through.
                    sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                    referrerPolicy="strict-origin-when-cross-origin"
                    loading="lazy"
                    className={`h-full w-full rounded-xl border border-border/80 bg-card transition-opacity motion-reduce:transition-none ${frameLoaded ? "opacity-100" : "opacity-0"}`}
                  />
                </div>
                <a
                  href={ready.entry.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                  dir="ltr"
                >
                  <span className="truncate">{ready.entry.url}</span>
                  <ExternalLinkIcon className="size-4 shrink-0" aria-hidden="true" />
                  <span dir="rtl">باز کردن در تب جدید</span>
                </a>
                <p className="text-[11px] leading-5 text-muted-foreground">
                  اگر صفحه در این کادر نمایش داده نشد، آن را با پیوند بالا در تب جدید باز کنید.
                </p>
              </>
            ) : null}
          </div>
        ) : tours.length > 0 ? (
          // A tour exists but no article does: say so briefly and keep the
          // way into the Knowledge Center, rather than a full empty panel.
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-border px-4 py-3">
            <p className="text-xs text-muted-foreground">
              هنوز راهنمای مکتوبی برای این بخش ثبت نشده است.
            </p>
            <Link
              href="/knowledge"
              onClick={() => setOpen(false)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/80 px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted"
            >
              <BookOpenIcon className="size-4" aria-hidden="true" />
              مرکز آموزش
            </Link>
          </div>
        ) : (
          <div className="flex min-h-[320px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 text-center">
            <GraduationCapIcon className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground/80">
              هنوز صفحهٔ آموزشی برای این بخش ثبت نشده است.
            </p>
            <p className="text-xs text-muted-foreground">
              از تیم پشتیبانی بخواهید راهنمای این بخش را در پایگاه دانش ثبت کند — یا به مرکز
              آموزش سر بزنید.
            </p>
            <Link
              href="/knowledge"
              onClick={() => setOpen(false)}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-border/80 px-4 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted"
            >
              <BookOpenIcon className="size-4" aria-hidden="true" />
              مرکز آموزش
            </Link>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
