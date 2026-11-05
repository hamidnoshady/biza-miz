"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckIcon, Link2Icon, XIcon } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { FilterChip } from "@/app/dashboard/filters";
import { MediaPickerDialog, type PickedMedia } from "@/app/dashboard/media/media-picker";
import {
  EmptyState,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import {
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  SecondaryButton,
  api,
  errorMessage,
  inputClass,
} from "@/app/dashboard/ui";
import {
  AGENCY_MEDIA_FORMATS,
  AGENCY_MEDIA_FORMAT_LABELS,
  MEDIA_REVIEW_ITEM_STATUS_LABELS,
  MEDIA_REVIEW_LINK_PURPOSES,
  MEDIA_REVIEW_LINK_PURPOSE_LABELS,
  MEDIA_REVIEW_LINK_TTL_DAYS,
  MEDIA_REVIEW_NOTE_MAX_LENGTH,
  MEDIA_REVIEW_ROUND_ACTION_LABELS,
  MEDIA_REVIEW_ROUND_STATUS_LABELS,
  MEDIA_REVIEW_ROUND_STATUSES,
  clampReviewLinkTtlDays,
  formatReviewProgress,
  isReviewRoundOpenForItems,
  reviewLinkRefusal,
  type AgencyMediaFormat,
  type MediaReviewItemStatus,
  type MediaReviewLinkPurpose,
  type MediaReviewRoundAction,
  type MediaReviewRoundStatus,
} from "@/lib/media-review";
import { toPersianDigits } from "@/lib/digits";

/* ---------------------------------------------------------------------------
 * Wire types, redeclared here on purpose.
 *
 * `media-review-service` owns the authoritative shapes, but it imports the
 * Postgres driver — importing it into a client component would drag `pg` into
 * the browser bundle and fail the build. These mirror what the routes return.
 * ------------------------------------------------------------------------- */

interface RoundBase {
  id: string;
  title: string;
  note: string | null;
  status: MediaReviewRoundStatus;
  projectId: string | null;
  projectName: string | null;
  clientPartyId: string | null;
  clientName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  createdByName: string;
  sentAt: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  decidedCount: number;
  actions: MediaReviewRoundAction[];
  clientActions: MediaReviewRoundAction[];
}

interface RoundSummary extends RoundBase {
  liveLinkCount: number;
}

interface RoundItem {
  assetId: string;
  fileName: string;
  kind: string;
  mimeType: string | null;
  byteSize: number;
  format: string | null;
  versionLabel: string | null;
  position: number;
  status: MediaReviewItemStatus;
  note: string | null;
  decidedAt: string | null;
  fileUrl: string;
}

interface RoundLink {
  id: string;
  purpose: MediaReviewLinkPurpose;
  tokenPrefix: string;
  ttlDays: number;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
}

interface RoundEvent {
  id: string;
  actorKind: "member" | "client" | "system";
  actorLabel: string;
  action: string;
  fromState: string | null;
  toState: string | null;
  note: string | null;
  assetId: string | null;
  createdAt: string;
}

interface RoundDetail extends RoundBase {
  items: RoundItem[];
  links: RoundLink[];
  events: RoundEvent[];
}

type Kind = "image" | "video" | "document";

const KIND_LABELS: Record<Kind, string> = {
  image: "تصویر",
  video: "ویدیو",
  document: "سند",
};

const STATUS_TONE: Record<
  MediaReviewRoundStatus,
  "active" | "positive" | "neutral" | "danger"
> = {
  draft: "neutral",
  sent: "active",
  approved: "positive",
  changes_requested: "active",
  rejected: "danger",
  withdrawn: "neutral",
};

const ITEM_TONE: Record<MediaReviewItemStatus, "active" | "positive" | "neutral" | "danger"> = {
  pending: "neutral",
  approved: "positive",
  changes_requested: "active",
  rejected: "danger",
};

const EVENT_ACTION_LABELS: Record<string, string> = {
  "round.created": "دور ساخته شد",
  "round.updated": "دور ویرایش شد",
  "round.items_added": "موارد افزوده شد",
  "round.item_removed": "مورد حذف شد",
  "round.item_updated": "مورد ویرایش شد",
  "round.sent": "برای کارفرما ارسال شد",
  "round.withdrawn": "پس گرفته شد",
  "round.approved": "کارفرما تأیید کرد",
  "round.changes_requested": "کارفرما درخواست اصلاح داد",
  "round.rejected": "کارفرما رد کرد",
  "round.deleted": "دور حذف شد",
  "item.approved": "مورد تأیید شد",
  "item.changes_requested": "برای مورد درخواست اصلاح شد",
  "item.rejected": "مورد رد شد",
  "link.created": "پیوند ساخته شد",
  "link.revoked": "پیوند لغو شد",
  "asset.viewed": "کارفرما فایل را دید",
  "asset.downloaded": "کارفرما فایل را دریافت کرد",
};

function faDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return toPersianDigits(date.toLocaleDateString("fa-IR"));
}

/** Everything the create form and the item picker need, in one lookup call. */
interface Lookups {
  projects: { id: string; name: string }[];
  parties: { id: string; name: string }[];
}

export function ReviewPanel({ canManage }: { canManage: boolean }) {
  const [rounds, setRounds] = useState<RoundSummary[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | MediaReviewRoundStatus>("all");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const [detail, setDetail] = useState<RoundDetail | null>(null);
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const [creating, setCreating] = useState(false);
  const [pickerKind, setPickerKind] = useState<Kind | null>(null);
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<{ token: string; link: RoundLink } | null>(null);
  const [copied, setCopied] = useState(false);

  const loadList = useCallback(async () => {
    const res = await api<{ rounds?: RoundSummary[]; error?: string }>("/api/media/review-rounds");
    if (res.ok && res.data?.rounds) {
      setRounds(res.data.rounds);
      setError("");
    } else {
      setError(errorMessage(res.data?.error));
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const loadDetail = useCallback(async (id: string) => {
    const res = await api<{ round?: RoundDetail; error?: string }>(
      `/api/media/review-rounds/${encodeURIComponent(id)}`,
    );
    if (res.ok && res.data?.round) {
      setDetail(res.data.round);
      setError("");
      return res.data.round;
    }
    setError(errorMessage(res.data?.error));
    return null;
  }, []);

  /** Every mutation answers with the fresh round, so one helper serves all. */
  const mutate = useCallback(
    async (
      key: string,
      url: string,
      init: RequestInit | undefined,
      after?: () => void,
    ): Promise<RoundDetail | null> => {
      setBusy(key);
      setError("");
      const res = await api<{ round?: RoundDetail; ok?: boolean; error?: string }>(url, init);
      setBusy(null);
      if (!res.ok) {
        setError(errorMessage(res.data?.error));
        return null;
      }
      after?.();
      // A DELETE answers `{ok:true}` and the round is gone: back to the list.
      if (res.data?.round) {
        setDetail(res.data.round);
        await loadList();
        return res.data.round;
      }
      setDetail(null);
      await loadList();
      return null;
    },
    [loadList],
  );

  const visible = (rounds ?? []).filter(
    (round) => statusFilter === "all" || round.status === statusFilter,
  );

  /* ---------------- create ---------------- */

  const [draftTitle, setDraftTitle] = useState("");
  const [draftNote, setDraftNote] = useState("");
  const [draftProject, setDraftProject] = useState("");
  const [draftClient, setDraftClient] = useState("");
  const [draftAssets, setDraftAssets] = useState<PickedMedia[]>([]);
  const [draftFormats, setDraftFormats] = useState<Record<string, AgencyMediaFormat>>({});

  async function openCreate() {
    setCreating(true);
    setDraftTitle("");
    setDraftNote("");
    setDraftProject("");
    setDraftClient("");
    setDraftAssets([]);
    setDraftFormats({});
    if (lookups) return;
    const res = await api<Record<string, unknown>>("/api/workspace/lookups");
    if (!res.ok) {
      setError(errorMessage((res.data as { error?: string })?.error));
      return;
    }
    const projects = Array.isArray(res.data.projects) ? (res.data.projects as { id: string; name: string }[]) : [];
    const parties = Array.isArray(res.data.parties) ? (res.data.parties as Record<string, unknown>[]) : [];
    setLookups({
      projects,
      parties: parties.map((p) => ({ id: String(p.id), name: String(p.name ?? "") })),
    });
  }

  async function submitCreate() {
    const formats: Record<string, string> = {};
    for (const asset of draftAssets) {
      const format = draftFormats[asset.id];
      if (format) formats[asset.id] = format;
    }
    const created = await mutate(
      "create",
      "/api/media/review-rounds",
      {
        method: "POST",
        body: JSON.stringify({
          title: draftTitle.trim(),
          note: draftNote.trim() || undefined,
          projectId: draftProject || undefined,
          clientPartyId: draftClient || undefined,
          assetIds: draftAssets.map((asset) => asset.id),
          formats,
        }),
      },
      () => setCreating(false),
    );
    if (created) await loadDetail(created.id);
  }

  /* ---------------- links ---------------- */

  const [linkPurpose, setLinkPurpose] = useState<MediaReviewLinkPurpose>("review");
  const [linkTtl, setLinkTtl] = useState(String(MEDIA_REVIEW_LINK_TTL_DAYS.default));

  async function mintLink() {
    if (!detail) return;
    setBusy("mint");
    setError("");
    const res = await api<{ link?: RoundLink; token?: string; error?: string }>(
      `/api/media/review-rounds/${encodeURIComponent(detail.id)}/links`,
      {
        method: "POST",
        body: JSON.stringify({
          purpose: linkPurpose,
          ttlDays: clampReviewLinkTtlDays(Number(linkTtl)),
        }),
      },
    );
    setBusy(null);
    if (!res.ok || !res.data?.link || !res.data.token) {
      setError(errorMessage(res.data?.error));
      return;
    }
    setMinting(false);
    setMinted({ token: res.data.token, link: res.data.link });
    setCopied(false);
    await loadDetail(detail.id);
    await loadList();
  }

  function reviewUrl(token: string): string {
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    return `${origin}/review/${token}`;
  }

  async function copyMinted() {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(reviewUrl(minted.token));
      setCopied(true);
    } catch {
      // Clipboard permission is not guaranteed (and never is over plain http);
      // the URL is on screen in a selectable field either way.
      setCopied(false);
    }
  }

  /* ---------------- render ---------------- */

  if (!rounds) {
    return (
      <div className="space-y-4">
        <ErrorBox>{error}</ErrorBox>
        <SectionCardSkeleton rows={5} label="در حال بارگذاری دورهای بررسی" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      {!canManage ? (
        <InfoBox>
          شما اجازهٔ «media.view» دارید و می‌توانید دورهای بررسی را ببینید، اما ساختن دور، ارسال
          آن و ساختن یا لغو پیوند به اجازهٔ «media.manage» نیاز دارد.
        </InfoBox>
      ) : null}

      {detail ? (
        <RoundDetailCard
          round={detail}
          canManage={canManage}
          busy={busy}
          onBack={() => {
            setDetail(null);
            void loadList();
          }}
          onAddItems={() => setPickerKind("image")}
          onRemoveItem={(assetId) =>
            void mutate(
              `item:${assetId}`,
              `/api/media/review-rounds/${encodeURIComponent(detail.id)}/items/${encodeURIComponent(assetId)}`,
              { method: "DELETE" },
            )
          }
          onTransition={(action) =>
            void mutate(`act:${action}`, `/api/media/review-rounds/${encodeURIComponent(detail.id)}/transition`, {
              method: "POST",
              body: JSON.stringify({ action }),
            })
          }
          onDelete={() =>
            void mutate(
              "delete",
              `/api/media/review-rounds/${encodeURIComponent(detail.id)}`,
              { method: "DELETE" },
            )
          }
          onMint={() => {
            setLinkPurpose("review");
            setLinkTtl(String(MEDIA_REVIEW_LINK_TTL_DAYS.default));
            setMinting(true);
          }}
          onRevoke={(linkId) =>
            void mutate(
              `revoke:${linkId}`,
              `/api/media/review-rounds/${encodeURIComponent(detail.id)}/links/${encodeURIComponent(linkId)}/revoke`,
              { method: "POST" },
            )
          }
        />
      ) : (
        <SectionCard
          title="دورهای بررسی"
          description="هر دور، مجموعه‌ای از فایل‌هاست که یک‌بار برای کارفرما فرستاده می‌شود. دور بعدی، نسخهٔ بعدی است."
        >
          <div className="flex flex-wrap items-center gap-2">
            <FilterChip selected={statusFilter === "all"} onClick={() => setStatusFilter("all")}>
              همه
            </FilterChip>
            {MEDIA_REVIEW_ROUND_STATUSES.map((status) => (
              <FilterChip
                key={status}
                selected={statusFilter === status}
                onClick={() => setStatusFilter(status)}
              >
                {MEDIA_REVIEW_ROUND_STATUS_LABELS[status]}
              </FilterChip>
            ))}
            <span className="ms-auto">
              <PrimaryButton onClick={() => void openCreate()} disabled={!canManage}>
                دور بررسی جدید
              </PrimaryButton>
            </span>
          </div>

          {visible.length === 0 ? (
            <EmptyState
              icon={Link2Icon}
              title={rounds.length === 0 ? "هنوز دور بررسی‌ای نساخته‌اید" : "موردی با این وضعیت نیست"}
            >
              {rounds.length === 0
                ? "یک دور بسازید، فایل‌ها را اضافه کنید و با یک پیوند کوتاه‌مدت برای کارفرما بفرستید."
                : "فیلتر وضعیت را عوض کنید تا بقیهٔ دورها را ببینید."}
            </EmptyState>
          ) : (
            <ul className="mt-4 divide-y">
              {visible.map((round) => (
                <li key={round.id} className="flex flex-wrap items-center gap-3 py-3">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-start"
                    onClick={() => void loadDetail(round.id)}
                  >
                    <span className="block truncate text-sm font-semibold">{round.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {formatReviewProgress(round.decidedCount, round.itemCount)}
                      {round.projectName ? ` · پروژه: ${round.projectName}` : ""}
                      {round.clientName ? ` · کارفرما: ${round.clientName}` : ""}
                      {round.liveLinkCount > 0
                        ? ` · ${toPersianDigits(round.liveLinkCount)} پیوند فعال`
                        : ""}
                    </span>
                  </button>
                  <StatusBadge tone={STATUS_TONE[round.status]}>
                    {MEDIA_REVIEW_ROUND_STATUS_LABELS[round.status]}
                  </StatusBadge>
                  <SecondaryButton onClick={() => void loadDetail(round.id)}>باز کردن</SecondaryButton>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {/* Create */}
      <Sheet open={creating} onOpenChange={setCreating}>
        <SheetContent className="space-y-4 overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>دور بررسی جدید</SheetTitle>
          </SheetHeader>

          <Field label="عنوان">
            <input
              className={inputClass}
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              placeholder="مثلاً: طرح نهایی بیلبورد — نسخهٔ ۲"
            />
          </Field>

          <Field label="توضیح برای کارفرما (اختیاری)">
            <textarea
              className={inputClass}
              rows={3}
              maxLength={MEDIA_REVIEW_NOTE_MAX_LENGTH}
              value={draftNote}
              onChange={(event) => setDraftNote(event.target.value)}
            />
          </Field>

          <Field label="پروژه (اختیاری)">
            <select
              className={inputClass}
              value={draftProject}
              onChange={(event) => setDraftProject(event.target.value)}
            >
              <option value="">بدون پروژه</option>
              {(lookups?.projects ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="کارفرما (اختیاری)">
            <select
              className={inputClass}
              value={draftClient}
              onChange={(event) => setDraftClient(event.target.value)}
            >
              <option value="">بدون کارفرما</option>
              {(lookups?.parties ?? []).map((party) => (
                <option key={party.id} value={party.id}>
                  {party.name}
                </option>
              ))}
            </select>
          </Field>

          {/* The picker takes one kind at a time, so the member chooses which
              kind they are adding rather than the dialog pretending to span
              all three. */}
          <div className="space-y-2">
            <span className="text-sm font-medium">
              فایل‌ها ({toPersianDigits(draftAssets.length)})
            </span>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(KIND_LABELS) as Kind[]).map((kind) => (
                <SecondaryButton key={kind} type="button" onClick={() => setPickerKind(kind)}>
                  افزودن {KIND_LABELS[kind]}
                </SecondaryButton>
              ))}
            </div>
            {draftAssets.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                هنوز فایلی انتخاب نشده. یک دور بدون فایل ساخته می‌شود و بعداً هم می‌توانید فایل اضافه
                کنید.
              </p>
            ) : (
              <ul className="space-y-2">
                {draftAssets.map((asset) => (
                  <li key={asset.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                    <span className="min-w-0 flex-1 truncate text-sm">{asset.fileName}</span>
                    <select
                      className={inputClass}
                      value={draftFormats[asset.id] ?? ""}
                      onChange={(event) =>
                        setDraftFormats((prev) => ({
                          ...prev,
                          [asset.id]: event.target.value as AgencyMediaFormat,
                        }))
                      }
                    >
                      <option value="">بدون قالب</option>
                      {AGENCY_MEDIA_FORMATS.map((format) => (
                        <option key={format} value={format}>
                          {AGENCY_MEDIA_FORMAT_LABELS[format]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      aria-label={`حذف ${asset.fileName}`}
                      className="rounded p-1 text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        setDraftAssets((prev) => prev.filter((item) => item.id !== asset.id))
                      }
                    >
                      <XIcon className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex gap-2">
            <PrimaryButton
              onClick={() => void submitCreate()}
              disabled={busy === "create" || !draftTitle.trim()}
            >
              ساختن دور
            </PrimaryButton>
            <SecondaryButton onClick={() => setCreating(false)}>انصراف</SecondaryButton>
          </div>
        </SheetContent>
      </Sheet>

      {/* Mint */}
      <Sheet open={minting} onOpenChange={setMinting}>
        <SheetContent className="space-y-4 overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>ساختن پیوند بررسی</SheetTitle>
          </SheetHeader>
          <InfoBox>
            پیوند کوتاه‌مدت است و فقط به فایل‌های همین دور دسترسی می‌دهد. هر زمان می‌توانید لغویش
            کنید و تلاش برای استفاده از پیوند لغوشده هم ثبت می‌شود.
          </InfoBox>
          <Field label="نوع دسترسی">
            <select
              className={inputClass}
              value={linkPurpose}
              onChange={(event) => setLinkPurpose(event.target.value as MediaReviewLinkPurpose)}
            >
              {MEDIA_REVIEW_LINK_PURPOSES.map((purpose) => (
                <option key={purpose} value={purpose}>
                  {MEDIA_REVIEW_LINK_PURPOSE_LABELS[purpose]}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={`اعتبار پیوند (روز، از ${toPersianDigits(MEDIA_REVIEW_LINK_TTL_DAYS.min)} تا ${toPersianDigits(MEDIA_REVIEW_LINK_TTL_DAYS.max)})`}
          >
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={linkTtl}
              onChange={(event) => setLinkTtl(event.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>
          <div className="flex gap-2">
            <PrimaryButton onClick={() => void mintLink()} disabled={busy === "mint"}>
              ساختن پیوند
            </PrimaryButton>
            <SecondaryButton onClick={() => setMinting(false)}>انصراف</SecondaryButton>
          </div>
        </SheetContent>
      </Sheet>

      {/* The plaintext, shown exactly once */}
      <Sheet open={minted !== null} onOpenChange={(open) => !open && setMinted(null)}>
        <SheetContent className="space-y-4 overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>پیوند ساخته شد</SheetTitle>
          </SheetHeader>
          {minted ? (
            <>
              <InfoBox>
                این پیوند فقط همین یک‌بار نمایش داده می‌شود؛ ما تنها اثر انگشت آن را نگه می‌داریم.
                آن را برای کارفرما بفرستید.
              </InfoBox>
              <Field label="پیوند بررسی">
                <input className={inputClass} dir="ltr" readOnly value={reviewUrl(minted.token)} />
              </Field>
              <div className="flex flex-wrap gap-2">
                <PrimaryButton type="button" onClick={() => void copyMinted()}>
                  <CheckIcon className="h-4 w-4" aria-hidden="true" />
                  {copied ? "کپی شد" : "کپی پیوند"}
                </PrimaryButton>
                <SecondaryButton onClick={() => setMinted(null)}>بستن</SecondaryButton>
              </div>
              <p className="text-xs text-muted-foreground">
                نوع دسترسی: {MEDIA_REVIEW_LINK_PURPOSE_LABELS[minted.link.purpose]} · اعتبار تا{" "}
                {faDate(minted.link.expiresAt)}
              </p>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      {pickerKind && detail ? (
        <MediaPickerDialog
          title={`افزودن ${KIND_LABELS[pickerKind]} به دور`}
          kind={pickerKind}
          multiple
          maxSelect={50}
          initialSelectedIds={detail.items.map((item) => item.assetId)}
          onClose={() => setPickerKind(null)}
          onPickMultiple={async (assets) => {
            setPickerKind(null);
            const existing = new Set(detail.items.map((item) => item.assetId));
            const fresh = assets.filter((asset) => !existing.has(asset.id));
            if (fresh.length === 0) return;
            await mutate(`add:${fresh.length}`, `/api/media/review-rounds/${encodeURIComponent(detail.id)}/items`, {
              method: "POST",
              body: JSON.stringify({ assetIds: fresh.map((asset) => asset.id) }),
            });
          }}
        />
      ) : null}

      {pickerKind && !detail ? (
        <MediaPickerDialog
          title={`انتخاب ${KIND_LABELS[pickerKind]}`}
          kind={pickerKind}
          multiple
          maxSelect={50}
          initialSelectedIds={draftAssets.map((asset) => asset.id)}
          onClose={() => setPickerKind(null)}
          onPickMultiple={(assets) => {
            setPickerKind(null);
            setDraftAssets((prev) => {
              const byId = new Map(prev.map((asset) => [asset.id, asset]));
              for (const asset of assets) byId.set(asset.id, asset);
              return [...byId.values()].slice(0, 50);
            });
          }}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function RoundDetailCard({
  round,
  canManage,
  busy,
  onBack,
  onAddItems,
  onRemoveItem,
  onTransition,
  onDelete,
  onMint,
  onRevoke,
}: {
  round: RoundDetail;
  canManage: boolean;
  busy: string | null;
  onBack: () => void;
  onAddItems: () => void;
  onRemoveItem: (assetId: string) => void;
  onTransition: (action: MediaReviewRoundAction) => void;
  onDelete: () => void;
  onMint: () => void;
  onRevoke: (linkId: string) => void;
}) {
  const openForItems = isReviewRoundOpenForItems(round.status);
  // A link may only be minted on a sent round; offering it earlier produces a
  // refusal the member cannot act on, so the button waits for `sent`.
  const canMint = round.status === "sent";

  return (
    <div className="space-y-4">
      <SectionCard
        title={
          <span className="flex flex-wrap items-center gap-2">
            <SecondaryButton type="button" onClick={onBack}>
              بازگشت
            </SecondaryButton>
            {round.title}
            <StatusBadge tone={STATUS_TONE[round.status]}>
              {MEDIA_REVIEW_ROUND_STATUS_LABELS[round.status]}
            </StatusBadge>
          </span>
        }
        description={
          <span>
            {formatReviewProgress(round.decidedCount, round.itemCount)} مورد بررسی شده
            {round.projectName ? ` · پروژه: ${round.projectName}` : ""}
            {round.clientName ? ` · کارفرما: ${round.clientName}` : ""}
            {round.campaignName ? ` · کمپین: ${round.campaignName}` : ""}
            {` · ساختهٔ ${round.createdByName || "—"} در ${faDate(round.createdAt)}`}
          </span>
        }
      >
        {round.note ? <p className="text-sm">{round.note}</p> : null}

        {round.decidedByName || round.decisionNote ? (
          <InfoBox>
            تصمیم کارفرما: {MEDIA_REVIEW_ROUND_STATUS_LABELS[round.status]}
            {round.decidedByName ? ` · توسط ${round.decidedByName}` : ""}
            {round.decidedAt ? ` · ${faDate(round.decidedAt)}` : ""}
            {round.decisionNote ? ` — ${round.decisionNote}` : ""}
          </InfoBox>
        ) : null}

        {canManage ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {round.actions.map((action) => {
              const isSend = action === "send";
              const Button = isSend ? PrimaryButton : SecondaryButton;
              return (
                <Button
                  key={action}
                  type="button"
                  disabled={busy === `act:${action}`}
                  onClick={() => onTransition(action)}
                >
                  {MEDIA_REVIEW_ROUND_ACTION_LABELS[action]}
                </Button>
              );
            })}
            <SecondaryButton type="button" disabled={!canMint} onClick={onMint}>
              ساختن پیوند
            </SecondaryButton>
            <SecondaryButton type="button" disabled={!openForItems} onClick={onAddItems}>
              افزودن فایل
            </SecondaryButton>
            {round.status === "draft" ? (
              <SecondaryButton type="button" disabled={busy === "delete"} onClick={onDelete}>
                حذف پیش‌نویس
              </SecondaryButton>
            ) : null}
          </div>
        ) : null}

        {!canMint && canManage ? (
          <p className="mt-2 text-xs text-muted-foreground">
            پیوند تنها به یک دورِ ارسال‌شده داده می‌شود؛ یک پیش‌نویس را نمی‌توان به دست کارفرما داد.
          </p>
        ) : null}
      </SectionCard>

      <SectionCard title="فایل‌ها" description={`${toPersianDigits(round.items.length)} مورد`}>
        {round.items.length === 0 ? (
          <EmptyState title="فایلی در این دور نیست">
            {openForItems
              ? "با «افزودن فایل» از کتابخانهٔ رسانه انتخاب کنید."
              : "در این وضعیت نمی‌توان فایل اضافه یا حذف کرد."}
          </EmptyState>
        ) : (
          <ul className="divide-y">
            {round.items.map((item) => (
              <li key={item.assetId} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1">
                  <a
                    href={item.fileUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate text-sm font-medium hover:underline"
                  >
                    {item.fileName}
                  </a>
                  <span className="block text-xs text-muted-foreground">
                    {KIND_LABELS[item.kind as Kind] ?? item.kind}
                    {item.format
                      ? ` · ${AGENCY_MEDIA_FORMAT_LABELS[item.format as AgencyMediaFormat] ?? item.format}`
                      : ""}
                    {item.versionLabel ? ` · ${item.versionLabel}` : ""}
                    {item.note ? ` · توضیح کارفرما: ${item.note}` : ""}
                  </span>
                </span>
                <StatusBadge tone={ITEM_TONE[item.status]}>
                  {MEDIA_REVIEW_ITEM_STATUS_LABELS[item.status]}
                </StatusBadge>
                {canManage && openForItems ? (
                  <SecondaryButton type="button" onClick={() => onRemoveItem(item.assetId)}>
                    حذف
                  </SecondaryButton>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="پیوندها"
        description="پیوند لغوشده همچنان تلاش برای استفاده را ثبت می‌کند؛ دسترسی هرگز پس گرفته نمی‌شود، فقط متوقف می‌شود."
      >
        {round.links.length === 0 ? (
          <EmptyState title="پیوندی ساخته نشده">
            {canMint ? "با «ساختن پیوند» یک پیوند کوتاه‌مدت برای کارفرما بسازید." : "ابتدا دور را ارسال کنید."}
          </EmptyState>
        ) : (
          <ul className="divide-y">
            {round.links.map((link) => {
              const refusal = reviewLinkRefusal(link);
              return (
                <li key={link.id} className="flex flex-wrap items-center gap-3 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium" dir="ltr">
                      {link.tokenPrefix}…
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {MEDIA_REVIEW_LINK_PURPOSE_LABELS[link.purpose]} · ساخته‌شده در{" "}
                      {faDate(link.createdAt)} · اعتبار تا {faDate(link.expiresAt)} ·{" "}
                      {toPersianDigits(link.useCount)} استفاده
                      {link.lastUsedAt ? ` (آخرین: ${faDate(link.lastUsedAt)})` : ""}
                    </span>
                  </span>
                  <StatusBadge tone={refusal === "revoked" ? "danger" : refusal === "expired" ? "neutral" : "positive"}>
                    {refusal === "revoked" ? "لغوشده" : refusal === "expired" ? "منقضی" : "فعال"}
                  </StatusBadge>
                  {canManage && !link.revokedAt ? (
                    <SecondaryButton
                      type="button"
                      disabled={busy === `revoke:${link.id}`}
                      onClick={() => onRevoke(link.id)}
                    >
                      لغو پیوند
                    </SecondaryButton>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="سابقهٔ بررسی" description="این سابقه فقط افزودنی است؛ هیچ رویدادی بازنویسی یا حذف نمی‌شود.">
        {round.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">رویدادی ثبت نشده است.</p>
        ) : (
          <ul className="divide-y">
            {round.events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline gap-2 py-2 text-sm">
                <span className="text-xs text-muted-foreground">{faDate(event.createdAt)}</span>
                <span className="font-medium">{event.actorLabel}</span>
                <span>{EVENT_ACTION_LABELS[event.action] ?? event.action}</span>
                {event.fromState && event.toState ? (
                  <span className="text-xs text-muted-foreground">
                    {MEDIA_REVIEW_ROUND_STATUS_LABELS[event.fromState as MediaReviewRoundStatus] ?? event.fromState}
                    {" ← "}
                    {MEDIA_REVIEW_ROUND_STATUS_LABELS[event.toState as MediaReviewRoundStatus] ?? event.toState}
                  </span>
                ) : null}
                {event.note ? <span className="text-xs text-muted-foreground">— {event.note}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
