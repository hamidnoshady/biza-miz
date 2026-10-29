"use client";

import { useCallback, useEffect, useState } from "react";
import { FormLoadingSkeleton } from "@/components/form-loading-skeleton";
import {
  AGENCY_MEDIA_FORMAT_LABELS,
  MEDIA_REVIEW_ITEM_STATUS_LABELS,
  MEDIA_REVIEW_ROUND_ACTION_LABELS,
  MEDIA_REVIEW_ROUND_STATUS_LABELS,
  reviewDecisionNoteRequired,
  type MediaReviewItemStatus,
  type MediaReviewRoundAction,
} from "@/lib/media-review";
import {
  ErrorBox,
  Field,
  PrimaryButton,
  SecondaryButton,
  api,
  errorMessage,
  inputClass,
} from "../../dashboard/ui";
import { StatusBadge } from "../../dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";

/**
 * The wire shape of `/api/media/review/[token]`, redeclared here on purpose.
 *
 * `media-review-service` owns the authoritative types, but it imports the
 * Postgres driver; importing it into a client component would drag `pg` into the
 * browser bundle and fail the build. These mirror what the route returns and
 * nothing more — deliberately narrower than `ClientReviewView`, because a client
 * is never shown the round's links or its full event trail.
 */
type ItemStatus = MediaReviewItemStatus;

interface ReviewItem {
  assetId: string;
  fileName: string;
  kind: string;
  mimeType: string | null;
  byteSize: number;
  format: string | null;
  versionLabel: string | null;
  position: number;
  status: ItemStatus;
  note: string | null;
  fileUrl: string;
}

interface View {
  round: {
    id: string;
    title: string;
    note: string | null;
    status: string;
    projectName: string | null;
    clientName: string | null;
    itemCount: number;
    decidedCount: number;
  };
  items: ReviewItem[];
  clientName: string | null;
  actions: MediaReviewRoundAction[];
}

const ITEM_TONE: Record<ItemStatus, "active" | "positive" | "neutral" | "danger"> = {
  pending: "neutral",
  approved: "positive",
  changes_requested: "active",
  rejected: "danger",
};

/**
 * Turn a refusal code into something the person holding the link can act on.
 *
 * The credential outcomes are terminal: no retry helps, and the useful
 * instruction is to go back to whoever sent the link. The decision outcomes are
 * not — they mean "fix the form and try again".
 */
function describeRefusal(code: string): { message: string; terminal: boolean } {
  switch (code) {
    case "invalid_token":
      return {
        message: "این پیوند معتبر نیست. اگر آن را کپی کرده‌اید، ممکن است بخشی از آن جا افتاده باشد.",
        terminal: true,
      };
    case "token_expired":
      return {
        message: "مهلت این پیوند تمام شده است. از آژانس بخواهید پیوند تازه‌ای برایتان بفرستد.",
        terminal: true,
      };
    case "token_revoked":
      return {
        message: "این پیوند لغو شده است. از آژانس بخواهید پیوند تازه‌ای برایتان بفرستد.",
        terminal: true,
      };
    case "round_not_sent":
      return {
        message: "این دور هنوز برای بررسی ارسال نشده است.",
        terminal: true,
      };
    case "note_required":
      return { message: "برای ثبت این تصمیم، نوشتن توضیح لازم است.", terminal: false };
    case "items_pending":
      return {
        message: "ابتدا همهٔ موارد را بررسی کنید؛ سپس می‌توانید تصمیم کلی را ثبت کنید.",
        terminal: false,
      };
    case "items_not_approved":
      return {
        message: "همهٔ موارد تأیید نشده‌اند، پس این دور را نمی‌توان تأیید کرد.",
        terminal: false,
      };
    default:
      return { message: errorMessage(code), terminal: false };
  }
}

export function ReviewScreen({ token }: { token: string }) {
  const [view, setView] = useState<View | null>(null);
  const [fatal, setFatal] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [itemNotes, setItemNotes] = useState<Record<string, string>>({});
  const [roundNote, setRoundNote] = useState("");
  const [clientName, setClientName] = useState("");

  const load = useCallback(async () => {
    const res = await api<View & { error?: string }>(`/api/media/review/${encodeURIComponent(token)}`);
    if (res.ok && res.data && !res.data.error) {
      setView(res.data);
      setClientName(res.data.clientName ?? "");
      setFatal("");
    } else {
      const refusal = describeRefusal(String(res.data?.error ?? "unknown"));
      if (refusal.terminal) setFatal(refusal.message);
      else setError(refusal.message);
    }
    setLoading(false);
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Re-point the file URLs after a decision: the round's items came back fresh. */
  function apply(next: View) {
    setView(next);
    setItemNotes({});
    setRoundNote("");
    setError("");
  }

  async function decideItem(assetId: string, status: ItemStatus) {
    const note = itemNotes[assetId] ?? "";
    if ((status === "rejected" || status === "changes_requested") && !note.trim()) {
      setError("برای «نیاز به اصلاح» و «رد» نوشتن توضیح لازم است تا آژانس بداند چه چیزی را تغییر دهد.");
      return;
    }
    setBusy(`item:${assetId}`);
    setError("");
    const res = await api<View & { error?: string }>(
      `/api/media/review/${encodeURIComponent(token)}/items/${encodeURIComponent(assetId)}`,
      { method: "POST", body: JSON.stringify({ status, note: note.trim() || undefined }) },
    );
    setBusy(null);
    if (res.ok && res.data && !res.data.error) apply(res.data);
    else setError(describeRefusal(String(res.data?.error ?? "unknown")).message);
  }

  async function decideRound(action: MediaReviewRoundAction) {
    const note = roundNote.trim();
    if (reviewDecisionNoteRequired(action) && !note) {
      setError("برای ثبت این تصمیم، نوشتن توضیح لازم است.");
      return;
    }
    setBusy(`round:${action}`);
    setError("");
    const res = await api<View & { error?: string }>(`/api/media/review/${encodeURIComponent(token)}`, {
      method: "POST",
      body: JSON.stringify({ action, note: note || undefined, clientName: clientName.trim() || undefined }),
    });
    setBusy(null);
    if (res.ok && res.data && !res.data.error) apply(res.data);
    else setError(describeRefusal(String(res.data?.error ?? "unknown")).message);
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <FormLoadingSkeleton rows={4} label="در حال بارگذاری صفحهٔ بررسی" />
      </div>
    );
  }

  if (fatal || !view) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-8">
        <h1 className="text-xl font-bold">بررسی کار</h1>
        <ErrorBox>{fatal || errorMessage("invalid_token")}</ErrorBox>
      </div>
    );
  }

  const { round, items, actions } = view;
  const settled = actions.length === 0;
  const statusKey = round.status as keyof typeof MEDIA_REVIEW_ROUND_STATUS_LABELS;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold">{round.title}</h1>
          <StatusBadge tone={settled ? "positive" : "neutral"}>
            {MEDIA_REVIEW_ROUND_STATUS_LABELS[statusKey] ?? round.status}
          </StatusBadge>
        </div>
        <p className="text-sm text-muted-foreground">
          {toPersianDigits(round.decidedCount)} از {toPersianDigits(round.itemCount)} مورد بررسی شده
          {round.projectName ? ` · پروژه: ${round.projectName}` : ""}
        </p>
        {round.note ? <p className="text-sm">{round.note}</p> : null}
      </header>

      <ErrorBox>{error}</ErrorBox>

      <ul className="space-y-4">
        {items.map((item) => {
          const busyHere = busy === `item:${item.assetId}`;
          const format = item.format
            ? AGENCY_MEDIA_FORMAT_LABELS[item.format as keyof typeof AGENCY_MEDIA_FORMAT_LABELS]
            : null;
          return (
            <li key={item.assetId} className="space-y-3 rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold">{item.fileName}</h2>
                <StatusBadge tone={ITEM_TONE[item.status]}>
                  {MEDIA_REVIEW_ITEM_STATUS_LABELS[item.status]}
                </StatusBadge>
                {format ? <span className="text-xs text-muted-foreground">{format}</span> : null}
                {item.versionLabel ? (
                  <span className="text-xs text-muted-foreground">{item.versionLabel}</span>
                ) : null}
              </div>

              {/* Token-scoped and answered no-store, so nothing here is cacheable.
                  Opened in a new tab rather than fetched with ?download=1: an
                  explicit download ask is refused for a review-purpose link, and
                  this screen does not know which purpose it was given. */}
              {item.kind === "image" && item.mimeType !== "image/svg+xml" ? (
                <a href={item.fileUrl} target="_blank" rel="noreferrer">
                  <img
                    src={item.fileUrl}
                    alt={item.fileName}
                    className="max-h-[26rem] w-full rounded-md object-contain"
                  />
                </a>
              ) : item.kind === "video" ? (
                <video src={item.fileUrl} controls className="max-h-[26rem] w-full rounded-md" />
              ) : (
                <a
                  href={item.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block text-sm text-primary underline underline-offset-4"
                >
                  مشاهدهٔ فایل
                </a>
              )}

              {item.note ? (
                <p className="text-sm text-muted-foreground">توضیح شما: {item.note}</p>
              ) : null}

              {!settled ? (
                <div className="space-y-2">
                  <Field label="توضیح (برای «نیاز به اصلاح» و «رد» لازم است)">
                    <textarea
                      className={inputClass}
                      rows={2}
                      value={itemNotes[item.assetId] ?? ""}
                      onChange={(event) =>
                        setItemNotes((prev) => ({ ...prev, [item.assetId]: event.target.value }))
                      }
                    />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <PrimaryButton
                      onClick={() => void decideItem(item.assetId, "approved")}
                      disabled={busyHere || item.status === "approved"}
                    >
                      تأیید
                    </PrimaryButton>
                    <SecondaryButton
                      onClick={() => void decideItem(item.assetId, "changes_requested")}
                      disabled={busyHere || item.status === "changes_requested"}
                    >
                      نیاز به اصلاح
                    </SecondaryButton>
                    <SecondaryButton
                      onClick={() => void decideItem(item.assetId, "rejected")}
                      disabled={busyHere || item.status === "rejected"}
                    >
                      رد
                    </SecondaryButton>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">موردی برای بررسی در این دور وجود ندارد.</p>
      ) : null}

      {!settled && actions.length > 0 ? (
        <section className="space-y-3 rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold">تصمیم کلی شما</h2>
          <Field label="نام شما (برای ثبت در سابقهٔ بررسی)">
            <input
              className={inputClass}
              value={clientName}
              onChange={(event) => setClientName(event.target.value)}
            />
          </Field>
          <Field label="توضیح (برای «نیاز به اصلاح» و «رد» لازم است)">
            <textarea
              className={inputClass}
              rows={3}
              value={roundNote}
              onChange={(event) => setRoundNote(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            {actions.map((action) => {
              const label = MEDIA_REVIEW_ROUND_ACTION_LABELS[action];
              const isApprove = action === "approve";
              const Button = isApprove ? PrimaryButton : SecondaryButton;
              return (
                <Button
                  key={action}
                  onClick={() => void decideRound(action)}
                  disabled={busy === `round:${action}`}
                >
                  {label}
                </Button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            تأیید کلی تنها زمانی ممکن است که همهٔ موارد بررسی و تأیید شده باشند.
          </p>
        </section>
      ) : null}
    </div>
  );
}
