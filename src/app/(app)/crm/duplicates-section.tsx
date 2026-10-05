"use client";

import { LoadingSkeleton, SectionCardSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Duplicate detection and merge (Phase 36).
 *
 * The most destructive screen in the app, so it is built as a **question, then
 * a preview, then a confirmation** — never a one-click "clean up duplicates".
 *
 * - Matching keys off the *canonical* phone (`phone_e164`), which is the only
 *   reason it finds anything: `0912…` and `+98912…` are one customer and two
 *   strings.
 * - A name match alone is offered at low confidence, because «محمد محمدی» is
 *   not one person, and is deliberately presented as a question rather than a
 *   recommendation.
 * - The preview spells out what will move and — the part people get wrong —
 *   that consent is **intersected**: a merge can never grant a permission
 *   neither record held.
 * - The loser is archived, never deleted, so nothing that referenced it dangles.
 *
 * Nothing merges automatically at any confidence, and merge is absent from the
 * assistant's action catalogue entirely.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatPhoneDisplay } from "@/lib/phone";
import { DUPLICATE_REASON_LABELS, type DuplicateReason } from "@/lib/crm-shared";
import { EmptyState, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessage, InfoBox } from "@/app/dashboard/ui";
import { crmCustomerHref } from "./crm-routes";
import { CrmCardHeading } from "./crm-card-heading";
import { CrmTodayQueues } from "./today-queues";

interface Side {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  orderCount: number;
  createdAt: string;
}

interface Candidate {
  reason: DuplicateReason;
  confidence: number;
  left: Side;
  right: Side;
}

interface MergePreview {
  winner: { id: string; name: string };
  loser: { id: string; name: string };
  moves: Record<string, number>;
  /**
   * Labels come from the server, not from a map kept here.
   *
   * This screen used to hold its own list of nine labels while the merge
   * actually touched more than twenty tables, so anything without a label —
   * cheques, instalments, the online-store mapping — was invisible in the
   * confirmation dialog. For an irreversible action, showing a silent subset
   * of the consequences is worse than showing a raw table name, so the labels
   * now travel with the counts from the single registry that defines both.
   */
  moveLabels: Record<string, string>;
  resultingConsent: { smsConsent: boolean; marketingConsent: boolean };
  resultingTags: string[];
}

export function DuplicatesSection() {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [target, setTarget] = useState<{ winner: Side; loser: Side } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { ok, data } = await api<{ duplicates?: Candidate[] }>("/api/crm/customers/duplicates");
      if (ok && Array.isArray(data.duplicates)) setCandidates(data.duplicates);
      else setError("بارگذاری فهرست تکراری‌ها ناموفق بود. دوباره تلاش کنید.");
    } catch {
      setError("ارتباط با سرور برقرار نشد. دوباره تلاش کنید.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (loading && !candidates) return <SectionCardSkeleton rows={4} />;
  if (!candidates) {
    return (
      <div className="space-y-3">
        <ErrorBox>{error}</ErrorBox>
        <Button type="button" variant="outline" onClick={() => void load()}>تلاش دوباره</Button>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4">

      {/* This screen's own queue, above the list: the count is the answer to
          «چقدر کار روی زمین مانده؟» and each row opens the record it names. */}
      <CrmTodayQueues section="duplicates" title="پرونده‌های مشکوک به تکرار" />
      <ErrorBox>{error}</ErrorBox>
      {info ? <InfoBox>{info}</InfoBox> : null}

      <SectionCard
        title={
          <CrmCardHeading kicker="یکپارچه‌سازی داده‌ها" title="مشتریان تکراری" />
        }
        description="پرونده‌هایی که احتمالاً یک نفرند. هیچ‌کدام خودکار ادغام نمی‌شوند."
        actions={
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => void load()} disabled={loading} aria-label={loading ? "در حال بازخوانی" : "بازخوانی"}>
            <RefreshCwIcon aria-hidden="true" className="size-4" />
          </Button>
        }
      >
        {candidates.length === 0 ? (
          <EmptyState>پروندهٔ تکراری‌ای پیدا نشد.</EmptyState>
        ) : (
          <ul className="divide-y divide-border/80">
            {candidates.map((candidate) => (
              <li
                key={`${candidate.left.id}-${candidate.right.id}-${candidate.reason}`}
                className="grid min-w-0 gap-3 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
              >
                <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                  <SideCard side={candidate.left} />
                  <SideCard side={candidate.right} />
                </div>
                <div className="flex min-w-0 flex-col items-stretch gap-2 lg:items-end">
                  <StatusBadge tone={candidate.confidence >= 80 ? "danger" : "neutral"}>
                    {DUPLICATE_REASON_LABELS[candidate.reason]} ·{" "}
                    {toPersianDigits(String(candidate.confidence))}٪
                  </StatusBadge>
                  <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:flex">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="h-auto min-h-8 w-full whitespace-normal text-center"
                      onClick={() => setTarget({ winner: candidate.left, loser: candidate.right })}
                    >
                      نگه‌داشتن «{candidate.left.name}»
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="h-auto min-h-8 w-full whitespace-normal text-center"
                      onClick={() => setTarget({ winner: candidate.right, loser: candidate.left })}
                    >
                      نگه‌داشتن «{candidate.right.name}»
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 text-xs leading-6 text-muted-foreground">
          ادغام برگشت‌ناپذیر است: سابقهٔ پروندهٔ دوم به پروندهٔ اول منتقل می‌شود و خودش بایگانی
          (نه حذف) می‌گردد. هیچ سند حسابداری تغییر نمی‌کند و تراز آزمایشی پیش و پس از ادغام یکی است.
        </p>
      </SectionCard>

      {target ? (
        <MergeDialog
          winner={target.winner}
          loser={target.loser}
          onClose={() => setTarget(null)}
          onMerged={(message) => {
            setTarget(null);
            setInfo(message);
            load();
          }}
        />
      ) : null}
    </div>
  );
}

function SideCard({ side }: { side: Side }) {
  return (
    <div className="min-w-0 rounded-xl border border-border/80 p-2.5">
      <Link href={crmCustomerHref(side.id)} className="font-medium text-foreground hover:underline">
        {side.name}
      </Link>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">
        {side.phone ? toPersianDigits(formatPhoneDisplay(side.phone)) : "بدون شماره"}
        {side.email ? ` · ${side.email}` : ""}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {formatPersianNumber(side.orderCount)} خرید · ثبت{" "}
        {toPersianDigits(formatJalali(side.createdAt))}
      </p>
    </div>
  );
}

function MergeDialog({
  winner,
  loser,
  onClose,
  onMerged,
}: {
  winner: Side;
  loser: Side;
  onClose: () => void;
  onMerged: (message: string) => void;
}) {
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api<{ preview: MergePreview; error?: string }>(
      `/api/crm/customers/merge?winner=${encodeURIComponent(winner.id)}&loser=${encodeURIComponent(loser.id)}`,
    )
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (ok) setPreview(data.preview);
        else setError(errorMessage(data.error));
      })
      .catch(() => {
        if (!cancelled) setError("آماده‌سازی پیش‌نمایش ممکن نشد.");
      });
    return () => {
      cancelled = true;
    };
  }, [winner.id, loser.id]);

  const confirm = async () => {
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>("/api/crm/customers/merge", {
      method: "POST",
      body: JSON.stringify({ winnerId: winner.id, loserId: loser.id }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    onMerged(`«${loser.name}» در «${winner.name}» ادغام شد و بایگانی گردید.`);
  };

  const moved = preview
    ? Object.entries(preview.moves).filter(([, count]) => count > 0)
    : [];

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>ادغام پروندهٔ مشتری</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>

        <p className="text-sm leading-6 text-foreground/80">
          همه‌چیزِ «<span className="font-semibold">{loser.name}</span>» به «
          <span className="font-semibold">{winner.name}</span>» منتقل می‌شود و پروندهٔ «
          <span className="font-semibold">{loser.name}</span>» بایگانی خواهد شد.
        </p>

        {!preview && !error ? (
          <LoadingSkeleton rows={3} compact className="mt-3" label="در حال آماده‌سازی پیش‌نمایش ادغام" />
        ) : preview ? (
          <div className="mt-3 space-y-3 text-sm">
            <div>
              <p className="font-medium text-foreground">چه چیزی منتقل می‌شود</p>
              {moved.length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  رکورد وابسته‌ای برای انتقال وجود ندارد.
                </p>
              ) : (
                <ul className="mt-1 flex flex-wrap gap-1.5">
                  {moved.map(([key, count]) => (
                    <li key={key}>
                      <StatusBadge tone="neutral">
                        {preview.moveLabels?.[key] ?? key}: {formatPersianNumber(count)}
                      </StatusBadge>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <p className="font-medium text-foreground">رضایت ارتباط پس از ادغام</p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                <li>
                  <StatusBadge tone={preview.resultingConsent.smsConsent ? "positive" : "neutral"}>
                    پیامک: {preview.resultingConsent.smsConsent ? "دارد" : "ندارد"}
                  </StatusBadge>
                </li>
                <li>
                  <StatusBadge
                    tone={preview.resultingConsent.marketingConsent ? "positive" : "neutral"}
                  >
                    ایمیل: {preview.resultingConsent.marketingConsent ? "دارد" : "ندارد"}
                  </StatusBadge>
                </li>
              </ul>
              <p className="mt-1 text-xs leading-6 text-muted-foreground">
                رضایت اشتراک گرفته می‌شود، نه اجتماع: اگر یکی از دو پرونده اجازه نداده باشد،
                پروندهٔ ادغام‌شده هم اجازه ندارد.
              </p>
            </div>

            {preview.resultingTags.length > 0 ? (
              <div>
                <p className="font-medium text-foreground">برچسب‌ها پس از ادغام</p>
                <ul className="mt-1 flex flex-wrap gap-1.5">
                  {preview.resultingTags.map((tag) => (
                    <li key={tag}>
                      <StatusBadge tone="neutral">{tag}</StatusBadge>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {preview ? (
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-50/60 p-3 text-sm leading-6 dark:border-amber-800 dark:bg-amber-950/20">
            <input
              type="checkbox"
              className="mt-1 size-4 shrink-0 accent-amber-700"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>بررسی کردم: «{winner.name}» باقی می‌ماند و «{loser.name}» بایگانی می‌شود. این کار برگشت‌پذیر نیست.</span>
          </label>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            انصراف
          </Button>
          <Button type="button" onClick={confirm} disabled={busy || !preview || !acknowledged}>
            {busy ? "در حال ادغام…" : "ادغام نهایی"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
