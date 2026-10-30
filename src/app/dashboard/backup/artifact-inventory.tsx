"use client";

/**
 * Issue #903 §2 — the tenant's managed-backup inventory.
 *
 * The card above it answers "did the last backup run?"; this one answers the
 * question the business actually has: *which backups exist, where, are they
 * verified, and can I get them back?* Everything it renders comes from
 * `/api/backup/artifacts`, which is provider-neutral by construction — the
 * browser never receives an endpoint, bucket, prefix, object key or internal
 * error, only opaque references, sizes and human labels.
 *
 * Restore is two steps, in this order, and the second one is deliberately hard
 * to reach by accident:
 *
 *  1. **Preview** (dry run) — `POST /api/backup/restores/preview` reports what
 *     would be replaced, what would be kept, what the backup does not contain,
 *     the data gap and every blocker.
 *  2. **Apply** — `POST /api/backup/restores/apply`, which recomputes the same
 *     preview server-side (the browser's copy is never trusted), re-derives the
 *     actor's facts from the session, and requires the typed confirmation phrase
 *     plus a fresh re-authentication.
 *
 * The button appears only for a preview with no blockers and a restorable
 * artifact. A missing re-authentication is not a dead end either: the preview
 * names it as a blocker, and the «تأیید هویت» button runs the shared step-up
 * ceremony and then re-reads the preview, so the Owner can finish the restore in
 * one sitting without signing out.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { Button } from "@/components/ui/button";
import { EmptyState, KpiCard, KpiRow, SectionCard, StatusBadge } from "../page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { FilterChip, FilterChipRow, SearchField } from "@/app/dashboard/filters";
import { ErrorBox, InfoBox, api, inputClass } from "../ui";
import { LoadingSkeleton } from "../page-chrome";
import { StepUpPrompt } from "@/components/auth/step-up-prompt";

type ArtifactState = "ready" | "uploading" | "verifying" | "failed" | "expired" | "unavailable_offline";
type ArtifactOrigin = "scheduled" | "manual" | "uploaded";

interface DestinationView {
  destination: "local" | "cloud";
  state: ArtifactState;
  storedBytes: number | null;
  available: boolean;
  verified: boolean;
}

interface InventoryItem {
  ref: string;
  capturedAt: string;
  origin: ArtifactOrigin;
  format: "physical_dump" | "logical_snapshot";
  destinations: DestinationView[];
  payloadBytes: number | null;
  storedBytes: number;
  state: ArtifactState;
  integrity: "verified" | "unverified" | "failed";
  completeness: "complete" | "partial";
  encryption: "managed" | "legacy_passphrase";
  retentionUntil: string | null;
  lastRestoreAt: string | null;
  available: boolean;
  downloadable: boolean;
  restorable: boolean;
}

interface InventoryResponse {
  profile: "cloud" | "hybrid" | "local";
  connectivity: "online" | "offline" | "unknown";
  items: InventoryItem[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  includedBytes: number;
  summary: {
    latestCompletedAt: string | null;
    latestVerifiedAt: string | null;
    readyCount: number;
    partialCount: number;
    failedCount: number;
    expiredCount: number;
    pendingCount: number;
    cloudBytes: number;
    includedBytes: number;
    overageBytes: number;
    usagePercent: number;
  };
  labels: {
    state: Record<ArtifactState, string>;
    format: Record<InventoryItem["format"], string>;
    origin: Record<ArtifactOrigin, string>;
    completeness: Record<"complete" | "partial", string>;
  };
}

interface RestorePreview {
  capturedAt: string;
  datasets: { component: string; incomingRows: number | null; currentRows: number | null; effect: string }[];
  retained: { component: string; currentRows: number }[];
  missing: { component: string; state: string }[];
  affectedRows: number;
  rpoHours: number;
  estimatedDowntimeMinutes: number;
  completeness: "complete" | "partial";
  blockers: { code: string; label: string }[];
  canApply: boolean;
  /** The exact text the Owner must type. Server-derived, never a generic "YES". */
  confirmationPhrase: string;
}

const STATE_FILTERS: { key: ArtifactState | "all"; label: string }[] = [
  { key: "all", label: "همه" },
  { key: "ready", label: "آماده" },
  { key: "verifying", label: "در حال بررسی" },
  { key: "uploading", label: "در حال بارگذاری" },
  { key: "failed", label: "ناموفق" },
  { key: "expired", label: "منقضی" },
];

function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === 0) return "—";
  const mb = bytes / (1024 * 1024);
  return toPersianDigits(mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);
}

function stateTone(state: ArtifactState): "positive" | "active" | "danger" | "neutral" {
  if (state === "ready") return "positive";
  if (state === "failed" || state === "expired") return "danger";
  if (state === "uploading" || state === "verifying") return "active";
  return "neutral";
}

function destinationLabel(destinations: DestinationView[]): string {
  const local = destinations.some((destination) => destination.destination === "local");
  const cloud = destinations.some((destination) => destination.destination === "cloud");
  if (local && cloud) return "محلی و ابری";
  if (cloud) return "ابری";
  return "محلی";
}

export function ArtifactInventoryCard({ isOwner }: { isOwner: boolean }) {
  const [state, setState] = useState<ArtifactState | "all">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<InventoryResponse | null>(null);
  const [error, setError] = useState(false);
  const [preview, setPreview] = useState<{ ref: string; body: RestorePreview } | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ tables: number; inserted: number; deleted: number; verified: boolean } | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (state !== "all") params.set("state", state);
    if (search.trim()) params.set("search", search.trim());
    params.set("page", String(page));
    params.set("pageSize", "20");
    return params.toString();
  }, [state, search, page]);

  const load = useCallback(async () => {
    const res = await api<InventoryResponse>(`/api/backup/artifacts?${query}`);
    if (res.ok) {
      setData(res.data);
      setError(false);
    } else {
      setError(true);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openPreview(ref: string) {
    setPreviewBusy(ref);
    setPreviewError(null);
    setApplyError(null);
    setApplied(null);
    setConfirmText("");
    const res = await api<{ preview: RestorePreview }>("/api/backup/restores/preview", {
      method: "POST",
      body: JSON.stringify({ ref }),
    });
    setPreviewBusy(null);
    if (!res.ok) {
      setPreviewError("پیش‌نمایش بازگردانی برای این نسخه ممکن نشد.");
      return;
    }
    setPreview({ ref, body: res.data.preview });
  }

  /**
   * The apply step. The server re-derives everything: the phrase must match what
   * *it* computes, the session must be fresh, and the reference must still be
   * this business's own restorable artifact. A stale session is answered with
   * `reauthentication_required`, which is where the step-up prompt takes over —
   * no need to sign out and back in.
   */
  async function applyRestore() {
    if (!preview) return;
    setApplyBusy(true);
    setApplyError(null);
    const res = await api<{
      ok?: boolean;
      tables?: number;
      inserted?: number;
      deleted?: number;
      verified?: boolean;
      error?: string;
    }>("/api/backup/restores/apply", {
      method: "POST",
      body: JSON.stringify({ ref: preview.ref, confirmation: confirmText }),
    });
    setApplyBusy(false);
    if (!res.ok) {
      switch (res.data.error) {
        case "reauthentication_required":
          setStepUpOpen(true);
          break;
        case "mfa_required":
          setApplyError("برای بازگردانی، ورود دومرحله‌ای (2FA) باید فعال باشد.");
          break;
        case "confirmation_required":
          setApplyError("عبارت تأیید با آنچه نمایش داده شد مطابقت ندارد.");
          break;
        case "restore_busy":
          setApplyError("یک بازگردانی دیگر برای این کسب‌وکار در حال اجراست؛ کمی بعد دوباره تلاش کنید.");
          break;
        case "backup_restore_not_permitted":
          setApplyError("بازگردانی برای این کسب‌وکار در این نصب مجاز نیست.");
          break;
        case "artifact_not_found":
          setApplyError("این نسخه دیگر در دسترس نیست یا قابل بازگردانی نیست.");
          break;
        default:
          setApplyError("بازگردانی انجام نشد؛ هیچ تغییری در داده‌ها اعمال نشد.");
      }
      return;
    }
    setApplied({
      tables: res.data.tables ?? 0,
      inserted: res.data.inserted ?? 0,
      deleted: res.data.deleted ?? 0,
      verified: res.data.verified === true,
    });
    setPreview(null);
    setConfirmText("");
    await load();
  }

  const summary = data?.summary;
  const localOnly = data?.profile === "local";

  return (
    <SectionCard
      title="نسخه‌های پشتیبان این کسب‌وکار"
      description="فهرست نسخه‌های پشتیبان خودتان با محل نگهداری، وضعیت بررسی و زمان انقضا. محتوای این فهرست فقط متعلق به همین کسب‌وکار است و نسخه‌های کل سکو در آن نمایش داده نمی‌شود."
    >
      {error ? <ErrorBox>دریافت فهرست نسخه‌ها ممکن نشد. دوباره تلاش کنید.</ErrorBox> : null}
      {!data && !error ? <LoadingSkeleton rows={4} /> : null}

      {data && summary ? (
        <div className="space-y-4">
          <KpiRow>
            <KpiCard
              label="آخرین نسخهٔ آماده"
              value={summary.latestCompletedAt ? formatJalali(summary.latestCompletedAt, { withTime: true }) : "—"}
              hint={summary.latestVerifiedAt ? "دست‌کم یک نسخه تأیید شده است" : "هنوز نسخه‌ای تأیید نشده"}
            />
            <KpiCard label="نسخه‌های آماده" value={toPersianDigits(String(summary.readyCount))} hint={`${toPersianDigits(String(summary.partialCount))} نسخهٔ ناقص`} />
            <KpiCard
              label="فضای ابری مصرف‌شده"
              value={localOnly ? "بدون فضای ابری" : formatSize(summary.cloudBytes)}
              hint={
                localOnly
                  ? "این نصب فقط محلی است"
                  : summary.includedBytes > 0
                    ? `${toPersianDigits(String(summary.usagePercent))}٪ از سهمیهٔ پلن`
                    : "سهمیهٔ ابری در پلن شما تعریف نشده است"
              }
            />
            <KpiCard
              label="نیازمند بررسی"
              value={toPersianDigits(String(summary.failedCount + summary.expiredCount + summary.pendingCount))}
              hint="ناموفق، منقضی یا در صف بارگذاری"
            />
          </KpiRow>

          {data.connectivity === "unknown" && !localOnly ? (
            <InfoBox>وضعیت اتصال این نصب در حال حاضر مشخص نیست؛ نسخه‌های محلی ممکن است تا برقراری اتصال قابل دانلود نباشند.</InfoBox>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <FilterChipRow label="فیلتر وضعیت نسخه‌ها">
              {STATE_FILTERS.map((filter) => (
                <FilterChip
                  key={filter.key}
                  selected={state === filter.key}
                  onClick={() => {
                    setState(filter.key);
                    setPage(1);
                  }}
                >
                  {filter.label}
                </FilterChip>
              ))}
            </FilterChipRow>
            <SearchField
              label="جست‌وجوی نسخه‌های پشتیبان"
              value={search}
              onChange={(next) => {
                setSearch(next);
                setPage(1);
              }}
              placeholder="جست‌وجو در نسخه‌ها"
            />
          </div>

          {previewError ? <ErrorBox>{previewError}</ErrorBox> : null}

          {data.items.length === 0 ? (
            <EmptyState title="نسخه‌ای با این مشخصات پیدا نشد">
              پس از اولین پشتیبان‌گیری موفق، نسخه‌ها به‌همراه محل نگهداری و وضعیت بررسی در همین فهرست ثبت می‌شوند.
            </EmptyState>
          ) : (
            <DataTable caption="فهرست نسخه‌های پشتیبان کسب‌وکار" tableClassName="min-w-[760px]">
              <DataTableHead>
                <Th>زمان تهیه</Th>
                <Th>نوع</Th>
                <Th>محل نگهداری</Th>
                <Th>وضعیت</Th>
                <Th>اعتبار</Th>
                <Th numeric>حجم</Th>
                <Th>انقضا</Th>
                {isOwner ? <Th>بازگردانی</Th> : null}
              </DataTableHead>
              <DataTableBody>
                {data.items.map((item) => (
                  <DataTableRow key={item.ref}>
                    <Td>{formatJalali(item.capturedAt, { withTime: true })}</Td>
                    <Td>
                      <span className="block">{data.labels.format[item.format]}</span>
                      <span className="block text-xs text-muted-foreground">
                        {data.labels.completeness[item.completeness]}
                      </span>
                    </Td>
                    <Td>{destinationLabel(item.destinations)}</Td>
                    <Td>
                      <StatusBadge tone={stateTone(item.state)} dot>
                        {data.labels.state[item.state]}
                      </StatusBadge>
                    </Td>
                    <Td>
                      {item.integrity === "verified"
                        ? "تأییدشده"
                        : item.integrity === "failed"
                          ? "خطا در بررسی"
                          : "تأییدنشده"}
                    </Td>
                    <Td numeric>{formatSize(item.payloadBytes ?? item.storedBytes)}</Td>
                    <Td>{item.retentionUntil ? formatJalali(item.retentionUntil) : "—"}</Td>
                    {isOwner ? (
                      <Td>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={previewBusy === item.ref}
                          onClick={() => void openPreview(item.ref)}
                        >
                          پیش‌نمایش
                        </Button>
                      </Td>
                    ) : null}
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          )}

          {data.pages > 1 ? (
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">
                صفحهٔ {toPersianDigits(String(data.page))} از {toPersianDigits(String(data.pages))}
              </span>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" disabled={data.page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                  قبلی
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={data.page >= data.pages} onClick={() => setPage((current) => current + 1)}>
                  بعدی
                </Button>
              </div>
            </div>
          ) : null}

          {preview ? (
            <div className="space-y-3 rounded-2xl border border-border/80 bg-muted/40 p-4">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-sm font-medium">پیش‌نمایش بازگردانی (بدون تغییر داده)</h3>
                <Button type="button" variant="ghost" size="sm" onClick={() => setPreview(null)}>
                  بستن
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                زمان نسخه: {formatJalali(preview.body.capturedAt, { withTime: true })} · فاصلهٔ داده‌ای:{" "}
                {toPersianDigits(String(preview.body.rpoHours))} ساعت · ردیف‌های مؤثر:{" "}
                {toPersianDigits(String(preview.body.affectedRows))} · زمان تقریبی توقف:{" "}
                {toPersianDigits(String(preview.body.estimatedDowntimeMinutes))} دقیقه
              </p>
              {preview.body.blockers.length > 0 ? (
                <div className="space-y-1">
                  {preview.body.blockers.map((blocker) => (
                    <ErrorBox key={blocker.code}>{blocker.label}</ErrorBox>
                  ))}
                </div>
              ) : (
                <InfoBox>
                  این نسخه از نظر مجوز، امضا، سازگاری نسخه و دسترسی، مانعی برای بازگردانی ندارد. اجرای واقعی بازگردانی فقط با
                  تأیید صریح و ورود دوبارهٔ شما انجام می‌شود و پیش از هر تغییری از داده‌های فعلی نقطهٔ بازیابی گرفته می‌شود.
                </InfoBox>
              )}
              {preview.body.retained.length > 0 ? (
                <p className="text-sm">
                  بخش‌هایی که در این نسخه نیستند و دست‌نخورده می‌مانند:{" "}
                  {preview.body.retained.map((entry) => entry.component).join(" · ")}
                </p>
              ) : null}
              {preview.body.missing.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  بخش‌های پشتیبان‌گیری‌نشده: {preview.body.missing.map((entry) => entry.component).join(" · ")}
                </p>
              ) : null}

              {preview.body.blockers.some((blocker) => blocker.code === "reauthentication_required") ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    پیش از بازگردانی باید هویت خود را دوباره تأیید کنید. پس از تأیید، همین پیش‌نمایش دوباره خوانده می‌شود.
                  </p>
                  <Button type="button" variant="outline" size="sm" onClick={() => setStepUpOpen(true)}>
                    تأیید هویت
                  </Button>
                </div>
              ) : null}

              {preview.body.canApply && preview.body.blockers.length === 0 ? (
                <div className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3">
                  <p className="text-sm font-semibold text-destructive">
                    این کار داده‌های فعلی این کسب‌وکار را با نسخهٔ انتخاب‌شده جایگزین می‌کند.
                  </p>
                  <p className="text-sm">
                    برای تأیید، نام کسب‌وکار خود را دقیقاً بنویسید:{" "}
                    <span className="font-semibold">{preview.body.confirmationPhrase}</span>
                  </p>
                  <input
                    className={inputClass}
                    value={confirmText}
                    onChange={(event) => setConfirmText(event.target.value)}
                    aria-label="عبارت تأیید بازگردانی"
                    autoComplete="off"
                  />
                  {applyError ? <ErrorBox>{applyError}</ErrorBox> : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={
                        applyBusy ||
                        confirmText.trim() !== preview.body.confirmationPhrase.trim() ||
                        !preview.body.confirmationPhrase.trim()
                      }
                      onClick={() => void applyRestore()}
                    >
                      {applyBusy ? "در حال بازگردانی…" : "بازگردانی قطعی"}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setPreview(null)}>
                      انصراف
                    </Button>
                  </div>
                </div>
              ) : applyError ? (
                <ErrorBox>{applyError}</ErrorBox>
              ) : null}
            </div>
          ) : null}

          {applied ? (
            <InfoBox>
              بازگردانی انجام و تأیید شد: {toPersianDigits(String(applied.tables))} مجموعهٔ داده،{" "}
              {toPersianDigits(String(applied.inserted))} ردیف نوشته‌شده و{" "}
              {toPersianDigits(String(applied.deleted))} ردیف جایگزین‌شده
              {applied.verified ? "؛ شمارش ردیف‌ها با نسخهٔ پشتیبان مطابقت دارد." : "."}
            </InfoBox>
          ) : null}

          <StepUpPrompt
            open={stepUpOpen}
            title="تأیید مجدد هویت برای بازگردانی"
            description="بازگردانی داده‌های کسب‌وکار یک عمل حساس است و نیازمند تأیید دوبارهٔ هویت شماست."
            onCancel={() => setStepUpOpen(false)}
            onVerified={() => {
              setStepUpOpen(false);
              const ref = preview?.ref;
              if (ref) void openPreview(ref);
            }}
          />
        </div>
      ) : null}
    </SectionCard>
  );
}
