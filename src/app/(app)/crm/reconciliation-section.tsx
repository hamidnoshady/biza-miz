"use client";

/**
 * Online-store reconciliation — «تطبیق فروشگاه آنلاین».
 *
 * ## Why this screen exists
 *
 * The WooCommerce sync used to answer every identity question, whether or not
 * it could. Two customers sharing a billing phone — a family, a couple, one
 * work number — and it attached the order to whichever record was created
 * first. Nothing failed. The purchase simply entered the wrong person's
 * history, their spend total, their RFM score, and every segment and campaign
 * derived from them.
 *
 * The sync no longer guesses. When it cannot identify a shopper it parks the
 * profile and imports the order unattributed, and this screen is where that
 * decision gets made by someone who can actually make it. A visible queue of
 * five unresolved shoppers is a far better state than five silently
 * misattributed ones.
 *
 * ## What the screen is built to prevent
 *
 * - **Deciding without the evidence.** Each row shows what the store sent
 *   (name, phone, email) beside each candidate, because the decision is a
 *   comparison and forcing the reviewer to hold one side in their head is how
 *   they get it wrong.
 * - **Accidental bulk resolution.** There is no "accept all". Every row is an
 *   individual judgement about a person; a button that resolves forty of them
 *   at once is a button that resolves thirty-nine of them carelessly.
 * - **Silent overwrites.** A conflict shows both values side by side and the
 *   local one is kept unless the reviewer explicitly picks the remote one.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { FilterChip, FilterChipRow, SearchField } from "@/app/dashboard/filters";
import { api, ErrorBox, errorMessage, InfoBox } from "@/app/dashboard/ui";
import { formatPersianNumber } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatPhoneDisplay } from "@/lib/phone";
import { crmCustomerHref } from "./crm-routes";
import { CrmTodayQueues } from "./today-queues";

interface Candidate {
  partyId: string;
  name: string;
  matchedOn: "phone" | "email";
  note: string;
}

interface Conflict {
  field: string;
  local: string;
  remote: string;
}

interface Profile {
  id: string;
  provider: string;
  remoteId: string;
  remoteName: string;
  remoteEmail: string | null;
  remotePhone: string | null;
  partyId: string | null;
  partyName: string | null;
  status: string;
  matchConfidence: number;
  matchReason: string;
  matchCandidates: Candidate[];
  conflicts: Conflict[];
  lastSyncedAt: string | null;
}

const STATUS_FILTERS = [
  { key: "pending", label: "در انتظار بررسی" },
  { key: "unmapped", label: "بدون تطبیق" },
  { key: "confirmed", label: "تأییدشده" },
  { key: "auto_matched", label: "تطبیق خودکار" },
  { key: "ignored", label: "نادیده‌گرفته" },
] as const;

const STATUS_LABELS: Record<string, string> = {
  unmapped: "بدون تطبیق",
  auto_matched: "تطبیق خودکار",
  confirmed: "تأییدشده",
  needs_review: "نیازمند بررسی",
  conflict: "اختلاف اطلاعات",
  ignored: "نادیده‌گرفته",
};

const STATUS_TONES: Record<string, "positive" | "neutral" | "active" | "danger"> = {
  unmapped: "neutral",
  auto_matched: "positive",
  confirmed: "positive",
  // "active" rather than a warning tone: a profile awaiting review is work in
  // progress, not a fault.
  needs_review: "active",
  conflict: "danger",
  ignored: "neutral",
};

const FIELD_LABELS: Record<string, string> = {
  name: "نام",
  email: "ایمیل",
  phone: "تلفن",
  address: "نشانی",
};

export function ReconciliationSection() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [pending, setPending] = useState(0);
  const [status, setStatus] = useState<string>("pending");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ status });
      if (search.trim()) params.set("q", search.trim());
      const { ok, data } = await api<{ profiles?: Profile[]; pending?: number }>(
        `/api/crm/external-profiles?${params.toString()}`,
      );
      if (ok && Array.isArray(data.profiles)) {
        setProfiles(data.profiles);
        setPending(data.pending ?? 0);
      } else {
        setError("بارگذاری فهرست تطبیق ناموفق بود. دوباره تلاش کنید.");
      }
    } catch {
      setError("ارتباط با سرور برقرار نشد. دوباره تلاش کنید.");
    } finally {
      setLoading(false);
    }
  }, [status, search]);

  useEffect(() => {
    // Debounced, because this fires on every keystroke in the search box and
    // the query behind it scans the profile table.
    const timer = setTimeout(() => void load(), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  const decide = async (
    profile: Profile,
    action: string,
    partyId?: string,
    message = "تصمیم ثبت شد.",
  ) => {
    setBusyId(profile.id);
    setError("");
    setInfo("");
    const { ok, data } = await api<{ error?: string }>(`/api/crm/external-profiles/${profile.id}`, {
      method: "POST",
      body: JSON.stringify({ action, partyId }),
    });
    setBusyId("");
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setInfo(message);
    await load();
  };

  const conflicted = useMemo(
    () => (profiles ?? []).filter((profile) => profile.conflicts.length > 0).length,
    [profiles],
  );

  if (loading && !profiles) return <SectionCardSkeleton rows={4} />;

  return (
    <div className="min-w-0 space-y-4">

      {/* This screen's own queue, above the list: the count is the answer to
          «چقدر کار روی زمین مانده؟» and each row opens the record it names. */}
      <CrmTodayQueues section="reconciliation" title="هویت‌های تازه برای تطبیق" />
      <ErrorBox>{error}</ErrorBox>
      {info ? <InfoBox>{info}</InfoBox> : null}

      <KpiRow>
        <KpiCard label="در انتظار تصمیم" value={formatPersianNumber(pending)} />
        <KpiCard label="اختلاف اطلاعات در این فهرست" value={formatPersianNumber(conflicted)} />
        <KpiCard label="نمایش‌داده‌شده" value={formatPersianNumber(profiles?.length ?? 0)} />
      </KpiRow>

      <SectionCard
        title="تطبیق مشتریان فروشگاه آنلاین"
        description="خریدارانی که همگام‌سازی نتوانست با اطمینان آن‌ها را به پروندهٔ مشتری وصل کند. تا زمانی که تصمیم نگیرید، خریدشان به هیچ پرونده‌ای نسبت داده نمی‌شود."
        actions={
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCwIcon aria-hidden="true" className="size-4" />
            تازه‌سازی
          </Button>
        }
      >
        <div className="space-y-3">
          <SearchField
            value={search}
            onChange={setSearch}
            label="جست‌وجو در خریداران فروشگاه"
            placeholder="نام، ایمیل یا شمارهٔ تلفن"
          />
          <FilterChipRow label="فیلتر وضعیت تطبیق">
            {STATUS_FILTERS.map((filter) => (
              <FilterChip
                key={filter.key}
                selected={status === filter.key}
                onClick={() => setStatus(filter.key)}
              >
                {filter.label}
              </FilterChip>
            ))}
          </FilterChipRow>

          {(profiles?.length ?? 0) === 0 ? (
            <EmptyState
              title={
                search.trim()
                  ? "خریداری با این مشخصات پیدا نشد"
                  : status === "pending"
                    ? "چیزی برای بررسی نمانده"
                    : "موردی در این وضعیت نیست"
              }
            >
              {search.trim()
                ? "عبارت جست‌وجو را تغییر دهید."
                : status === "pending"
                  ? "همهٔ خریداران فروشگاه آنلاین به پروندهٔ مشتری وصل شده‌اند."
                  : "فیلتر دیگری را امتحان کنید."}
            </EmptyState>
          ) : (
            <ul className="space-y-3">
              {(profiles ?? []).map((profile) => (
                <ProfileCard
                  key={profile.id}
                  profile={profile}
                  busy={busyId === profile.id}
                  onDecide={decide}
                />
              ))}
            </ul>
          )}
        </div>
      </SectionCard>
    </div>
  );
}

function ProfileCard({
  profile,
  busy,
  onDecide,
}: {
  profile: Profile;
  busy: boolean;
  onDecide: (profile: Profile, action: string, partyId?: string, message?: string) => void;
}) {
  const tone = STATUS_TONES[profile.status] ?? "neutral";

  return (
    <li className="rounded-xl border border-border/80 bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold text-foreground">
            {profile.remoteName || "بدون نام"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {profile.remotePhone ? formatPhoneDisplay(profile.remotePhone) : "بدون تلفن"}
            {" · "}
            {profile.remoteEmail || "بدون ایمیل"}
          </p>
          {profile.lastSyncedAt ? (
            <p className="mt-1 text-xs text-muted-foreground">
              آخرین همگام‌سازی: {formatJalali(profile.lastSyncedAt)}
            </p>
          ) : null}
        </div>
        <StatusBadge tone={tone}>{STATUS_LABELS[profile.status] ?? profile.status}</StatusBadge>
      </div>

      {profile.matchReason ? (
        <p className="mt-2 text-xs leading-6 text-muted-foreground">{profile.matchReason}</p>
      ) : null}

      {profile.partyName ? (
        <p className="mt-2 text-sm text-foreground">
          وصل‌شده به{" "}
          <Link
            href={crmCustomerHref(profile.partyId!)}
            className="font-medium text-amber-700 underline-offset-4 hover:underline dark:text-amber-300"
          >
            {profile.partyName}
          </Link>
        </p>
      ) : null}

      {profile.conflicts.length > 0 ? (
        <div className="mt-3 rounded-lg border border-border/80 bg-muted/40 p-3">
          <p className="text-sm font-medium text-foreground">
            اطلاعات فروشگاه با پروندهٔ شما فرق دارد
          </p>
          <p className="mt-1 text-xs leading-6 text-muted-foreground">
            تا تصمیم نگیرید، مقدار ثبت‌شده در پروندهٔ خودتان دست‌نخورده می‌ماند.
          </p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {profile.conflicts.map((conflict) => (
              <li key={conflict.field} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-muted-foreground">
                  {FIELD_LABELS[conflict.field] ?? conflict.field}:
                </span>
                <span className="font-medium text-foreground">{conflict.local}</span>
                <span className="text-muted-foreground">←</span>
                <span className="text-foreground/80">{conflict.remote}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                onDecide(profile, "reject_conflicts", undefined, "مقادیر پروندهٔ شما حفظ شد.")
              }
            >
              مقدار خودم درست است
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                onDecide(profile, "accept_conflicts", undefined, "مقادیر فروشگاه جایگزین شد.")
              }
            >
              مقدار فروشگاه را جایگزین کن
            </Button>
          </div>
        </div>
      ) : null}

      {profile.matchCandidates.length > 0 ? (
        <div className="mt-3">
          <p className="text-sm font-medium text-foreground">
            چند مشتری با این مشخصات پیدا شد — کدام‌یک؟
          </p>
          <p className="mt-1 text-xs leading-6 text-muted-foreground">
            خرید این شخص تا انتخاب شما به هیچ پرونده‌ای نسبت داده نمی‌شود. انتخاب اشتباه، سابقهٔ
            خرید یک نفر را به نام شخص دیگری ثبت می‌کند.
          </p>
          <ul className="mt-2 space-y-2">
            {profile.matchCandidates.map((candidate) => (
              <li
                key={candidate.partyId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/80 bg-muted/30 px-3 py-2"
              >
                <div className="min-w-0">
                  <Link
                    href={crmCustomerHref(candidate.partyId)}
                    className="truncate font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    {candidate.name}
                  </Link>
                  <p className="text-xs text-muted-foreground">{candidate.note}</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    onDecide(profile, "link", candidate.partyId, `به «${candidate.name}» وصل شد.`)
                  }
                >
                  همین است
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {profile.status === "needs_review" || profile.status === "unmapped" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onDecide(profile, "create", undefined, "پروندهٔ مشتری تازه ساخته شد.")}
          >
            هیچ‌کدام — پروندهٔ تازه بساز
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onDecide(profile, "ignore", undefined, "این مورد نادیده گرفته شد.")}
          >
            مشتری ما نیست
          </Button>
        </div>
      ) : null}
    </li>
  );
}
