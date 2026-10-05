"use client";

/**
 * CRM → «امروز» — the attention feed.
 *
 * ## Why this leads the page
 *
 * A CRM home made of totals answers «چقدر فروختیم؟» — a question the reports
 * answer better. The question a staff member actually arrives with is «الان
 * چه کاری باید انجام دهم؟», and a number cannot answer it. So the home begins
 * with the queues: each one a rule, each row a named person, deal or ticket,
 * each with the sentence that explains why it is there.
 *
 * ## Honesty rules this component keeps
 *
 * - **The count is the count.** It comes from `/api/crm/queues` as a real
 *   `count(*)`, and the preview below it is capped at four. When the two
 *   differ the card says so («۳ مورد دیگر») rather than letting four rows stand
 *   in for nine hundred. A queue labelled with its own page size is the bug the
 *   CRM overview already shipped once.
 * - **Every row says why.** The queue's rule is printed under its heading, not
 *   implied by its name, so «خطر از دست رفتن مهلت» states that waiting time is
 *   excluded rather than leaving the reader to guess whether the number is
 *   wrong.
 * - **Every row goes somewhere that acts on it.** A link into the person's
 *   file, the ticket or the deal — never a dead end.
 * - **An empty queue is not a failure.** It says what would have appeared and
 *   disappears from the top: a home page of empty cards teaches people to stop
 *   reading it.
 *
 * ## Two places it is used
 *
 * The home page shows every queue. A section screen passes its own `section`
 * key and sees only the queues it owns (`queueKeysForSection`), so the deals
 * board opens with «معامله‌های راکد» above it and the service desk opens with
 * «خطر از دست رفتن مهلت». Same component, same rules: the two cannot drift
 * into disagreeing about what «راکد» means, because there is one expression of
 * it — `crm-queues.ts`.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox } from "@/app/dashboard/ui";

interface QueueItem {
  id: string;
  title: string;
  subtitle: string;
  at?: string | null;
  href: string;
}

interface Queue {
  key: string;
  label: string;
  why: string;
  count: number;
  action: string;
  items: QueueItem[];
}

export function CrmTodayQueues({
  section,
  title = "امروز",
}: {
  /**
   * The section whose queues to show. Omit on the home page, which shows all of
   * them; the value is matched against `CRM_QUEUE_KEYS` server-side and an
   * unknown one returns nothing rather than everything.
   */
  section?: string;
  title?: string;
}) {
  const [queues, setQueues] = useState<Queue[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const query = section ? `?section=${encodeURIComponent(section)}` : "";
  const load = useCallback((signal?: AbortSignal) => {
    setRefreshing(true);
    return api<{ queues: Queue[] }>(`/api/crm/queues${query}`, { signal }).then(({ ok, data, aborted }) => {
      // A superseded request must not clobber fresher state, and an unmounted
      // component must not flip its own busy flags.
      if (aborted) return;
      if (ok) {
        setQueues(data.queues ?? []);
        setError("");
      } else {
        setError("بارگذاری صف‌های امروز ناموفق بود.");
      }
      setLoading(false);
      setRefreshing(false);
    });
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading && !queues) return <SectionCardSkeleton rows={3} />;

  const waiting = (queues ?? []).filter((queue) => queue.count > 0);
  const total = waiting.reduce((sum, queue) => sum + queue.count, 0);

  return (
    <SectionCard
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span>{title}</span>
          {waiting.length > 0 ? (
            <StatusBadge tone="active">{formatPersianNumber(total)} مورد نیازمند توجه</StatusBadge>
          ) : null}
        </span>
      }
      description={
        section
          ? "کارهای باز این بخش، بر پایهٔ قاعده: هر ردیف می‌گوید چرا اینجاست و از کدام صفحه رسیدگی می‌شود."
          : "صف‌هایی بر پایهٔ قاعده، نه فهرست دستی: هر ردیف می‌گوید چرا اینجاست و از کدام صفحه رسیدگی می‌شود."
      }
      actions={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => load()}
          disabled={refreshing}
          aria-label="بازخوانی صف‌ها"
          aria-busy={refreshing}
        >
          <RefreshCwIcon aria-hidden="true" className="size-4" />
        </Button>
      }
    >
      <ErrorBox>{error}</ErrorBox>
      {queues === null ? (
        <EmptyState>صف‌های امروز دریافت نشد.</EmptyState>
      ) : waiting.length === 0 ? (
        <EmptyState>
          {section
            ? "در این بخش کاری بیرون از قاعده یا عقب‌افتاده نیست؛ وقتی چیزی به توجه نیاز پیدا کند، همین‌جا بالای صفحه می‌آید."
            : "همین حالا کار سرگردانی نیست: نه پیگیری عقب‌افتاده‌ای، نه تیکتی بیرون از مهلت، نه معاملهٔ راکدی. وقتی چیزی به توجه نیاز پیدا کند، همین‌جا بالای صفحه می‌آید."}
        </EmptyState>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {waiting.map((queue) => (
            <div
              // Anchored so a command-field match can open this screen *at*
              // this queue. `scroll-mt` keeps the heading clear of the sticky
              // page header after the jump.
              id={`crm-queue-${queue.key}`}
              key={queue.key}
              className="min-w-0 scroll-mt-24 rounded-2xl border border-border/80 p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">{queue.label}</p>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{queue.why}</p>
                </div>
                <span className="shrink-0 rounded-xl bg-amber-100 px-2 py-0.5 text-sm font-bold tabular-nums text-amber-900 dark:bg-amber-500/20 dark:text-amber-200">
                  {formatPersianNumber(queue.count)}
                </span>
              </div>
              <ul className="mt-2 divide-y divide-border/70">
                {queue.items.map((item) => (
                  <li key={`${queue.key}-${item.id}`} className="py-2">
                    <Link
                      href={item.href}
                      className="block min-w-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
                    >
                      <span className="block truncate text-sm font-medium text-foreground">{item.title}</span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                        {item.subtitle}
                        {item.at ? ` · ${toPersianDigits(formatJalali(item.at, { withTime: false }))}` : ""}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              {queue.count > queue.items.length ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {formatPersianNumber(queue.count - queue.items.length)} مورد دیگر در این صف است.
                </p>
              ) : null}
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{queue.action}</p>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
