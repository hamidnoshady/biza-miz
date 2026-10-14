"use client";

/**
 * CRM → «کیفیت داده» — the data-quality workspace.
 *
 * ## Why one screen and not three menu items
 *
 * The CRM has three data-quality questions, and they are one question asked at
 * three levels:
 *
 *  1. **مسائل داده** — is this record usable? (a customer nobody can call, a deal
 *     attached to no one)
 *  2. **اشخاص تکراری** — are these two rows one person?
 *  3. **تطبیق فروشگاه آنلاین** — who is this anonymous shopper?
 *
 * All three are decided by the same person with the same key, and all three end
 * in the same act: correcting the record. Three menu items meant somebody who
 * wanted to know "can I trust this?" walked three screens and integrated the
 * answer themselves. So the workspace leads with the issues feed and keeps the
 * other two one click away — as views of the same screen, not as separate pages
 * (their old addresses still resolve for saved links).
 *
 * ## What it will not do
 *
 * - **No overall score.** A quality percentage is a number nobody can act on and
 *   that moves when unrelated things change. Named gaps with real counts do the
 *   same job and can be worked through.
 * - **No automatic merging, ever.** The duplicate view previews what a merge
 *   would do and requires a person to confirm it; the reconciliation view shows
 *   both candidate identities and requires a person to choose. This screen is
 *   the *reader* of both.
 * - **No promise it cannot keep.** A view the member's permissions do not open
 *   is not drawn — the workspace does not show a tab that would answer 403.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  EmptyState,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessage } from "@/app/dashboard/ui";
import { CrmCardHeading } from "./crm-card-heading";
import { DuplicatesSection } from "./duplicates-section";
import { ReconciliationSection } from "./reconciliation-section";

interface QualityIssue {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  at: string | null;
}

interface QualityGroup {
  key: string;
  label: string;
  why: string;
  action: string;
  count: number;
  items: QualityIssue[];
}

interface QualityPayload {
  issues: QualityGroup[];
  counts?: { pendingIdentities?: number };
  error?: string;
}

type View = "issues" | "duplicates" | "identities";

const VIEW_LABELS: Record<View, string> = {
  issues: "مسائل داده",
  duplicates: "اشخاص تکراری",
  identities: "تطبیق فروشگاه آنلاین",
};

function viewFromParam(value: string | null): View {
  return value === "duplicates" || value === "identities" ? value : "issues";
}

export function QualitySection({
  canSeeDuplicates,
  canSeeIdentities,
}: {
  /** Whether `crm.merge` opens the duplicate pairs — the view is dropped, not locked, when it does not. */
  canSeeDuplicates: boolean;
  /** Whether the reconciliation view is open to this member (it needs `crm.manage` too). */
  canSeeIdentities: boolean;
}) {
  const searchParams = useSearchParams();
  const [view, setView] = useState<View>(() => viewFromParam(searchParams.get("view")));
  const [payload, setPayload] = useState<QualityPayload | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    const { ok, data } = await api<QualityPayload>("/api/crm/quality");
    setRefreshing(false);
    if (ok) {
      setPayload(data);
      setError("");
    } else {
      // The list that was on screen stays: a dropped connection is not the same
      // news as "the record is clean", and blanking the page would say that.
      setError(data?.error ? errorMessage(data.error) : "خواندن مسائل داده ناموفق بود.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A view the member cannot use is not offered at all: the workspace must not
  // draw a tab whose request could only be refused.
  const views: View[] = ["issues"];
  if (canSeeDuplicates) views.push("duplicates");
  if (canSeeIdentities) views.push("identities");
  const active: View = views.includes(view) ? view : "issues";

  const groups = payload?.issues ?? [];
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  const pendingIdentities = payload?.counts?.pendingIdentities ?? 0;

  const badgeFor = (key: View): number | null => {
    if (key === "issues") return total;
    if (key === "identities") return pendingIdentities;
    return null;
  };

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <SectionCard
        title={<CrmCardHeading kicker="کیفیت داده" title="کیفیت داده" />}
        description="سه پرسش دربارهٔ یک چیز: آیا می‌توان به این پرونده اعتماد کرد؟ چه چیزی ناقص است، کدام پرونده‌ها تکراری‌اند، و خریدار ناشناس کیست."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {total > 0 ? (
              <StatusBadge tone="active">
                {formatPersianNumber(total)} مورد نیازمند اصلاح
              </StatusBadge>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void load()}
              disabled={refreshing}
              aria-label="بازخوانی مسائل داده"
              aria-busy={refreshing}
            >
              <RefreshCwIcon aria-hidden="true" className="size-4" />
            </Button>
          </div>
        }
      >
        <div
          role="group"
          aria-label="نمای کیفیت داده"
          className="-mx-1 flex min-w-0 gap-1.5 overflow-x-auto px-1 pb-1"
        >
          {views.map((key) => {
            const badge = badgeFor(key);
            return (
              <Button
                key={key}
                type="button"
                size="xs"
                variant={active === key ? "default" : "outline"}
                aria-pressed={active === key}
                className="shrink-0"
                onClick={() => setView(key)}
              >
                {VIEW_LABELS[key]}
                {badge !== null && badge > 0 ? ` (${formatPersianNumber(badge)})` : ""}
              </Button>
            );
          })}
        </div>
      </SectionCard>

      {active === "duplicates" ? <DuplicatesSection /> : null}
      {active === "identities" ? <ReconciliationSection /> : null}

      {active === "issues" ? (
        payload === null ? (
          <SectionCardSkeleton rows={3} label="در حال خواندن مسائل داده" />
        ) : groups.every((group) => group.count === 0) ? (
          <SectionCard title="مسائل داده">
            <EmptyState>
              همین حالا ایرادی در پرونده‌ها پیدا نشد: هر مشتری راه تماس دارد، هر فرصت باز به مشتری
              وصل است، سرنخ‌ها تازه‌اند و هیچ کار بازی بی‌مسئول نمانده است. وقتی چیزی از قاعده بیرون
              بزند، همین‌جا می‌آید.
            </EmptyState>
          </SectionCard>
        ) : (
          groups
            // An empty rule is not shown: a screen of zeroes teaches people to
            // stop reading it. The count stays in the chip when it is real.
            .filter((group) => group.count > 0)
            .map((group) => (
              <SectionCard
                key={group.key}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    <span>{group.label}</span>
                    <StatusBadge tone="active">{formatPersianNumber(group.count)}</StatusBadge>
                  </span>
                }
                description={group.why}
              >
                <ul className="divide-y divide-border/70">
                  {group.items.map((item) => (
                    <li key={`${group.key}-${item.id}`} className="py-2">
                      <Link
                        href={item.href}
                        className="block min-w-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
                      >
                        <span className="block truncate text-sm font-medium text-foreground">
                          {item.title}
                        </span>
                        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                          {item.subtitle}
                          {item.at ? ` · ${toPersianDigits(formatJalali(item.at, { withTime: false }))}` : ""}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                {group.count > group.items.length ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {formatPersianNumber(group.count - group.items.length)} مورد دیگر هست؛ فهرست
                    کامل در همین صفحه بعد از رسیدگی به این‌ها می‌آید.
                  </p>
                ) : null}
                {/* What fixing it means, and where — the rule is the prompt, the
                    screen is the actor. */}
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{group.action}</p>
              </SectionCard>
            ))
        )
      ) : null}
    </div>
  );
}
