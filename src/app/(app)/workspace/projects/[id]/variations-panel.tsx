"use client";

/**
 * Issue #799 §15 on screen — «تغییرات»: the change-order register.
 *
 * The tab answers the three questions a change log exists for, in the order a
 * quantity surveyor asks them:
 *
 *   1. what is in flight and what is it worth — the register, with the approved
 *      total, the amount still awaiting a decision and the schedule impact;
 *   2. what happened to each change — its estimate, its cost impact, what was
 *      claimed and what was agreed, side by side, because the difference between
 *      those four numbers *is* the commercial story of a change order;
 *   3. who agreed and when — §33's trail, which the service writes in the same
 *      transaction as the change and never updates afterwards.
 *
 * ## What the screen is careful about
 *
 *   * **§15's chain is the buttons.** Draft → Priced → Submitted → Under Review
 *     → Approved → Implemented, with Rejected and the one deliberate reopening
 *     (`reopen`, back to Priced) beside it. There is no status dropdown that can
 *     pick an illegal move and then fail in the service.
 *   * **A submitted change looks submitted.** Its content stops being editable
 *     the moment it is sent — the lock is migration 0200's trigger and a
 *     disabled form is a nicer way to learn that than an error.
 *   * **The two acts are separate people.** Writing a change order is
 *     `workspace.manage`; approving, rejecting, implementing or cancelling it is
 *     `workspace.approve` (§24). The panel simply does not offer the second set
 *     of buttons to somebody who does not hold the key.
 *   * **The contract value moves, the contract does not.** The screen shows the
 *     amount an approval *will* add to the revised contractual value and says so
 *     in words, so nobody reads an approved variation as an edit of the
 *     contract.
 *   * **Dates are Shamsi on screen and Gregorian in the database**, like the rest
 *     of the product: `DateField` is the shared Jalali picker and the API only
 *     ever sees `YYYY-MM-DD`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2Icon,
  GitBranchIcon,
  HistoryIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  overlayPanelClass,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { mediaFileUrl } from "@/app/dashboard/media/media-picker";
import { toPersianDigits } from "@/lib/digits";
import {
  VARIATION_ACTION_LABELS,
  VARIATION_ACTION_TARGET,
  VARIATION_SOURCE_LABELS,
  VARIATION_SOURCES,
  VARIATION_STATUSES,
  VARIATION_STATUS_LABELS,
  canTransitionVariation,
  type VariationAction,
  type VariationSource,
  type VariationStatus,
} from "@/lib/aec-commercial";
import type { WorkspaceLookups } from "../../use-workspace-lookups";
import { DateCell, DateField, PickerField, SelectField, workspaceError } from "../../workspace-ui";

/* ---------------------------------------------------------------------------
 * Wire shapes — `/api/aec/**`
 * ------------------------------------------------------------------------- */

interface VariationEvent {
  id: string;
  action: string;
  summary: string;
  actorName: string;
  createdAt: string;
}

interface VariationAttachment {
  documentId: string;
  title: string;
  fileName: string | null;
  mimeType: string | null;
  mediaAssetId: string | null;
  createdAt: string;
}

interface Variation {
  id: string;
  projectId: string;
  contractId: string | null;
  contractTitle: string | null;
  variationNumber: string;
  source: VariationSource;
  sourceLabel: string;
  reason: string;
  description: string;
  responsiblePartyId: string | null;
  responsiblePartyName: string | null;
  rfiId: string | null;
  rfiNumber: string | null;
  rfiSubject: string | null;
  estimatedAmountRial: number | null;
  costImpactRial: number | null;
  submittedAmountRial: number | null;
  approvedAmountRial: number | null;
  scheduleImpactDays: number | null;
  status: VariationStatus;
  statusLabel: string;
  submittedDate: string | null;
  approvedDate: string | null;
  implementedDate: string | null;
  createdAt: string;
  createdById: string | null;
  createdByName: string;
  attachmentCount: number;
  approvalId: string | null;
  approvalStatus: string | null;
  isEditable: boolean;
  isOpen: boolean;
  isApproved: boolean;
}

interface VariationDetail extends Variation {
  events: VariationEvent[];
  attachments: VariationAttachment[];
}

const STATUS_TONES: Record<VariationStatus, "neutral" | "active" | "positive" | "danger"> = {
  draft: "neutral",
  priced: "active",
  submitted: "active",
  under_review: "active",
  approved: "positive",
  rejected: "danger",
  implemented: "positive",
  cancelled: "neutral",
};

/**
 * The moves this status offers, in the order the chain reads.
 *
 * Derived from `canTransitionVariation` rather than hand-listed, so a change to
 * the chain in `aec-commercial.ts` shows up here without a second edit — and an
 * illegal move is never rendered as a button.
 */
const ACTION_ORDER: readonly VariationAction[] = [
  "price",
  "submit",
  "review",
  "approve",
  "reject",
  "implement",
  "cancel",
  "reopen",
];

function actionsFor(status: VariationStatus): VariationAction[] {
  return ACTION_ORDER.filter((action) => canTransitionVariation(status, VARIATION_ACTION_TARGET[action]));
}

/** The determinations of §24 — the ones that need `workspace.approve`. */
const APPROVAL_ACTIONS = new Set<VariationAction>([
  "review",
  "approve",
  "reject",
  "implement",
  "cancel",
]);

/* ---------------------------------------------------------------------------
 * The tab
 * ------------------------------------------------------------------------- */

export function AecVariationsTab({
  projectId,
  canManage,
  canApprove,
  lookups,
}: {
  projectId: string;
  canManage: boolean;
  canApprove: boolean;
  lookups: WorkspaceLookups;
}) {
  const [variations, setVariations] = useState<Variation[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<VariationDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Variation | null>(null);
  const [statusFilter, setStatusFilter] = useState<VariationStatus | "">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const money = useMoney();

  const fail = useCallback((code: string | undefined) => setError(workspaceError(code)), []);

  const load = useCallback(async (preferId?: string | null) => {
    const { ok, data } = await api<{ variations: Variation[] }>(
      `/api/aec/projects/${projectId}/variations`,
    );
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      setVariations([]);
      return null;
    }
    setVariations(data.variations);
    const next = data.variations.find((row) => row.id === preferId) ?? data.variations[0] ?? null;
    setSelectedId(next ? next.id : null);
    return next;
  }, [projectId, fail]);

  const loadDetail = useCallback(
    async (variationId: string) => {
      const { ok, data } = await api<{ variation: VariationDetail }>(
        `/api/aec/variations/${variationId}`,
      );
      if (!ok) {
        fail((data as unknown as { error?: string }).error);
        setDetail(null);
        return;
      }
      setDetail(data.variation);
    },
    [fail],
  );

  const refresh = useCallback(
    async (preferId?: string | null) => {
      const next = await load(preferId);
      if (next) await loadDetail(next.id);
      else setDetail(null);
    },
    [load, loadDetail],
  );

  useEffect(() => {
    void refresh();
    // `refresh` depends on the project alone; the filter below is applied on
    // screen so switching it never re-fetches.
  }, [refresh]);

  const rows = useMemo(
    () => (variations ?? []).filter((row) => !statusFilter || row.status === statusFilter),
    [variations, statusFilter],
  );

  const approvedTotal = useMemo(
    () => (variations ?? []).filter((row) => row.isApproved).reduce((sum, row) => sum + (row.approvedAmountRial ?? 0), 0),
    [variations],
  );
  const inFlight = useMemo(
    () => (variations ?? []).filter((row) => row.isOpen && row.status !== "draft").length,
    [variations],
  );
  const scheduleImpact = useMemo(
    () => (variations ?? []).reduce((sum, row) => sum + (row.scheduleImpactDays ?? 0), 0),
    [variations],
  );

  async function act(variation: Variation, action: VariationAction) {
    if (busy) return;
    // §15's preconditions, stated before the round trip: a change cannot be
    // approved without an agreed amount, and the service would refuse it
    // anyway — but the screen should ask rather than fail.
    let approvedAmountRial: string | undefined;
    if (action === "approve") {
      const figure = window.prompt(
        "مبلغ توافق‌شدهٔ این تغییر (ریال) را ثبت کنید:",
        String(variation.approvedAmountRial ?? variation.submittedAmountRial ?? ""),
      );
      if (figure === null) return;
      if (!figure.trim()) {
        fail("variation_approved_amount_required");
        return;
      }
      approvedAmountRial = figure.trim();
    }
    // A priced change order must carry its own estimate (0200's CHECK), so ask
    // for it here rather than letting the button fail.
    if (action === "price" && variation.estimatedAmountRial === null) {
      const estimate = window.prompt("برآورد داخلی این تغییر (ریال) را ثبت کنید:");
      if (estimate === null) return;
      if (!estimate.trim()) {
        fail("variation_estimate_required");
        return;
      }
      const saved = await api<{ variation: Variation }>(`/api/aec/variations/${variation.id}`, {
        method: "PATCH",
        body: JSON.stringify({ estimatedAmountRial: estimate.trim() }),
      });
      if (!saved.ok) {
        fail((saved.data as unknown as { error?: string }).error);
        return;
      }
    }
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ variation: Variation }>(
      `/api/aec/variations/${variation.id}/status`,
      { method: "POST", body: JSON.stringify({ action, approvedAmountRial }) },
    );
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice(
      action === "approve"
        ? `تغییر ${data.variation.variationNumber} تأیید شد؛ ارزش اصلاح‌شدهٔ قرارداد با این مبلغ به‌روز می‌شود. مبلغ اصلی قرارداد تغییر نمی‌کند.`
        : `تغییر ${data.variation.variationNumber} — ${VARIATION_ACTION_LABELS[action]}.`,
    );
    await refresh(data.variation.id);
  }

  async function remove(variation: Variation) {
    if (busy) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api(`/api/aec/variations/${variation.id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice("تغییر پیش‌نویس حذف شد.");
    await refresh(null);
  }

  if (!variations) {
    return (
      <div className="flex flex-col gap-4">
        <KpiRow>
          <KpiCard label="تغییرات" value="—" />
          <KpiCard label="در جریان" value="—" />
          <KpiCard label="تأییدشده" value="—" />
          <KpiCard label="اثر زمانی" value="—" />
        </KpiRow>
        <SectionCardSkeleton rows={4} />
      </div>
    );
  }

  const n = (value: number | string) => toPersianDigits(String(value));

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? (
        <p className="rounded-xl border border-border/80 bg-muted/40 p-3 text-sm">{notice}</p>
      ) : null}

      <KpiRow>
        <KpiCard label="تغییرات" value={n(variations.length)} hint="در این پروژه" />
        <KpiCard
          label="در جریان"
          value={n(inFlight)}
          hint={inFlight > 0 ? "ارسال‌شده یا در حال بررسی" : "چیزی در انتظار تصمیم نیست"}
        />
        <KpiCard
          label="تأییدشده"
          value={approvedTotal ? money.format(approvedTotal) : "—"}
          hint="مجموع مبالغ توافق‌شده"
        />
        <KpiCard
          label="اثر زمانی"
          value={scheduleImpact ? `${n(scheduleImpact)} روز` : "—"}
          hint="مجموع اثر تغییرات بر برنامه"
        />
      </KpiRow>

      <SectionCard
        title="دفتر تغییرات و دستور کارها"
        description="هر تغییر یک شماره دارد. تا وقتی پیش‌نویس یا قیمت‌گذاری‌شده است قابل ویرایش است؛ از «ارسال» به بعد آنچه کارفرما دیده ثابت می‌ماند و تنها با «بازگشایی» می‌توان دوباره قیمت‌گذاری کرد."
        actions={
          canManage ? (
            <SecondaryButton onClick={() => setCreating((open) => !open)}>
              <PlusIcon className="size-4" aria-hidden />
              تغییر جدید
            </SecondaryButton>
          ) : null
        }
        flush
      >
        {creating ? (
          <VariationForm
            projectId={projectId}
            lookups={lookups}
            onClose={() => setCreating(false)}
            onError={fail}
            onSaved={async (variationId) => {
              setCreating(false);
              setNotice("تغییر ثبت شد؛ با «قیمت‌گذاری» و سپس «ارسال برای تأیید» آن را پیش ببرید.");
              await refresh(variationId);
            }}
          />
        ) : null}

        <div className="flex flex-wrap items-end gap-3 border-b border-border/80 p-4">
          <div className="w-full sm:w-48">
            <SelectField
              label="وضعیت"
              value={statusFilter}
              onChange={(next) => setStatusFilter(next as VariationStatus | "")}
              options={VARIATION_STATUSES}
              labels={VARIATION_STATUS_LABELS}
              includeAll
              allLabel="همه"
            />
          </div>
        </div>

        {rows.length === 0 ? (
          <EmptyState icon={GitBranchIcon} title="تغییری ثبت نشده است">
            {variations.length === 0
              ? "تغییرات و دستور کارهای کارفرما، تغییرات طراحی و شرایط کارگاه اینجا ثبت و پیگیری می‌شوند."
              : "با این فیلتر تغییری پیدا نشد."}
          </EmptyState>
        ) : (
          <DataTable caption={`دفتر تغییرات — ${n(rows.length)} مورد`} tableClassName="min-w-[64rem]">
            <DataTableHead>
              <DataTableRow>
                <Th>شماره</Th>
                <Th>شرح</Th>
                <Th>منشأ</Th>
                <Th>وضعیت</Th>
                <Th>برآورد</Th>
                <Th>پیشنهادی</Th>
                <Th>توافق‌شده</Th>
                <Th>اثر زمانی</Th>
                <Th> </Th>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {rows.map((row) => (
                <DataTableRow
                  key={row.id}
                  className={row.id === selectedId ? "bg-muted/50" : undefined}
                >
                  <Td className="whitespace-nowrap font-medium">{row.variationNumber}</Td>
                  <Td className="max-w-[22rem]">
                    <button
                      type="button"
                      className="text-right underline-offset-2 hover:underline"
                      onClick={() => {
                        setSelectedId(row.id);
                        void loadDetail(row.id);
                      }}
                    >
                      {row.description}
                    </button>
                    {row.contractTitle ? (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        قرارداد: {row.contractTitle}
                      </span>
                    ) : null}
                    {row.rfiNumber ? (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        استعلام مرتبط: {row.rfiNumber}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap text-xs">{row.sourceLabel}</Td>
                  <Td>
                    <StatusBadge tone={STATUS_TONES[row.status]}>{row.statusLabel}</StatusBadge>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {row.estimatedAmountRial === null ? "—" : money.format(row.estimatedAmountRial)}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {row.submittedAmountRial === null ? "—" : money.format(row.submittedAmountRial)}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {row.approvedAmountRial === null ? "—" : money.format(row.approvedAmountRial)}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {row.scheduleImpactDays === null ? "—" : `${n(row.scheduleImpactDays)} روز`}
                  </Td>
                  <Td>
                    {canManage && row.status === "draft" ? (
                      <div className="flex items-center gap-1">
                        <SecondaryButton onClick={() => setEditing(row)}>
                          <PencilIcon className="size-3.5" aria-hidden />
                          <span className="sr-only">ویرایش</span>
                        </SecondaryButton>
                        <SecondaryButton onClick={() => void remove(row)}>
                          <Trash2Icon className="size-3.5" aria-hidden />
                          <span className="sr-only">حذف</span>
                        </SecondaryButton>
                      </div>
                    ) : null}
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>

      {editing ? (
        <VariationForm
          projectId={projectId}
          variation={editing}
          lookups={lookups}
          onClose={() => setEditing(null)}
          onError={fail}
          onSaved={async (variationId) => {
            setEditing(null);
            setNotice("تغییر به‌روزرسانی شد.");
            await refresh(variationId);
          }}
        />
      ) : null}

      {detail ? (
        <SectionCard
          title={`تغییر ${detail.variationNumber}`}
          description={detail.description}
          actions={
            <div className="flex flex-wrap items-center gap-1">
              {actionsFor(detail.status).map((action) => {
                const needsApproval = APPROVAL_ACTIONS.has(action);
                if (needsApproval ? !canApprove : !canManage) return null;
                return (
                  <SecondaryButton
                    key={action}
                    disabled={busy}
                    onClick={() => void act(detail, action)}
                  >
                    {VARIATION_ACTION_LABELS[action]}
                  </SecondaryButton>
                );
              })}
            </div>
          }
        >
          <div className="flex flex-col gap-4">
            <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">وضعیت</dt>
                <dd className="mt-0.5">
                  <StatusBadge tone={STATUS_TONES[detail.status]}>{detail.statusLabel}</StatusBadge>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">منشأ</dt>
                <dd className="mt-0.5">{detail.sourceLabel}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">طرف مسئول</dt>
                <dd className="mt-0.5">{detail.responsiblePartyName || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">قرارداد</dt>
                <dd className="mt-0.5">{detail.contractTitle || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">برآورد داخلی</dt>
                <dd className="mt-0.5">
                  {detail.estimatedAmountRial === null ? "—" : money.format(detail.estimatedAmountRial)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">اثر هزینه‌ای</dt>
                <dd className="mt-0.5">
                  {detail.costImpactRial === null ? "—" : money.format(detail.costImpactRial)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">مبلغ پیشنهادی</dt>
                <dd className="mt-0.5">
                  {detail.submittedAmountRial === null ? "—" : money.format(detail.submittedAmountRial)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">مبلغ توافق‌شده</dt>
                <dd className="mt-0.5">
                  {detail.approvedAmountRial === null ? "—" : money.format(detail.approvedAmountRial)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">اثر برنامه‌ای</dt>
                <dd className="mt-0.5">
                  {detail.scheduleImpactDays === null ? "—" : `${n(detail.scheduleImpactDays)} روز`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">تاریخ ارسال</dt>
                <dd className="mt-0.5">
                  <DateCell date={detail.submittedDate} relative={false} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">تاریخ تأیید</dt>
                <dd className="mt-0.5">
                  <DateCell date={detail.approvedDate} relative={false} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">تاریخ اجرا</dt>
                <dd className="mt-0.5">
                  <DateCell date={detail.implementedDate} relative={false} />
                </dd>
              </div>
            </dl>

            {detail.rfiId ? (
              <p className="text-sm">
                استعلام مرتبط: {detail.rfiNumber} — {detail.rfiSubject}
              </p>
            ) : null}
            {detail.reason ? (
              <p className="text-sm">
                <span className="text-xs text-muted-foreground">دلیل: </span>
                {detail.reason}
              </p>
            ) : null}
            {detail.isApproved ? (
              <p className="rounded-xl border border-emerald-200/70 bg-emerald-50/60 p-3 text-sm dark:border-emerald-900/60 dark:bg-emerald-950/30">
                این تغییر در ارزش اصلاح‌شدهٔ قرارداد لحاظ شده است؛ مبلغ اصلی قرارداد و نسخه‌های
                پیشین برآورد دست‌نخورده می‌مانند.
              </p>
            ) : null}

            <div>
              <p className="text-xs text-muted-foreground">پیوست‌ها</p>
              {detail.attachments.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  پیوستی ندارد؛ فایل‌ها از «کتابخانهٔ رسانه» به تغییر وصل می‌شوند.
                </p>
              ) : (
                <ul className="mt-1 flex flex-wrap gap-2">
                  {detail.attachments.map((attachment) => (
                    <li key={attachment.documentId}>
                      <a
                        className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs underline-offset-2 hover:underline"
                        href={mediaFileUrl(attachment.documentId)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <PaperclipIcon className="size-3" aria-hidden />
                        {attachment.title}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <HistoryIcon className="size-3.5" aria-hidden />
                گردش کار (تغییرناپذیر)
              </p>
              {detail.events.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">رویدادی ثبت نشده است.</p>
              ) : (
                <ol className="mt-2 flex flex-col gap-2">
                  {detail.events.map((event) => (
                    <li key={event.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                      <span className="min-w-0 flex-1">{event.summary}</span>
                      <span className="text-xs text-muted-foreground">{event.actorName}</span>
                      <DateCell date={event.createdAt.slice(0, 10)} className="text-xs" />
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Raise / edit
 * ------------------------------------------------------------------------- */

function VariationForm({
  projectId,
  variation,
  lookups,
  onClose,
  onSaved,
  onError,
}: {
  projectId: string;
  variation?: Variation;
  lookups: WorkspaceLookups;
  onClose: () => void;
  onSaved: (variationId: string) => void | Promise<void>;
  onError: (code: string | undefined) => void;
}) {
  const [source, setSource] = useState<VariationSource>(variation?.source ?? "other");
  const [description, setDescription] = useState(variation?.description ?? "");
  const [reason, setReason] = useState(variation?.reason ?? "");
  const [contractId, setContractId] = useState(variation?.contractId ?? "");
  const [responsiblePartyId, setResponsiblePartyId] = useState(variation?.responsiblePartyId ?? "");
  const [rfiId, setRfiId] = useState(variation?.rfiId ?? "");
  const [estimatedAmountRial, setEstimatedAmountRial] = useState(
    variation?.estimatedAmountRial ? String(variation.estimatedAmountRial) : "",
  );
  const [costImpactRial, setCostImpactRial] = useState(
    variation?.costImpactRial ? String(variation.costImpactRial) : "",
  );
  const [submittedAmountRial, setSubmittedAmountRial] = useState(
    variation?.submittedAmountRial ? String(variation.submittedAmountRial) : "",
  );
  const [scheduleImpactDays, setScheduleImpactDays] = useState(
    variation?.scheduleImpactDays !== null && variation?.scheduleImpactDays !== undefined
      ? String(variation.scheduleImpactDays)
      : "",
  );
  const money = useMoney();
  const [contracts, setContracts] = useState<Array<{ id: string; title: string; valueRial: number | null }>>([]);
  const [rfis, setRfis] = useState<Array<{ id: string; rfiNumber: string; subject: string }>>([]);
  const [saving, setSaving] = useState(false);

  // §15's "linked RFI" and the contract the change amends, from the registers
  // this project already has — two reads that make two pickers possible.
  useEffect(() => {
    api<{ contracts: Array<{ id: string; title: string; valueRial: number | null }> }>(
      `/api/workspace/contracts?projectId=${projectId}`,
    ).then(({ ok, data }) => {
      if (ok) setContracts(data.contracts);
    });
    api<{ rfis: Array<{ id: string; rfiNumber: string; subject: string }> }>(
      `/api/aec/projects/${projectId}/rfis`,
    ).then(({ ok, data }) => {
      if (ok) setRfis(data.rfis);
    });
  }, [projectId]);

  async function submit() {
    if (!description.trim() || saving) return;
    setSaving(true);
    const body = {
      source,
      description,
      reason,
      contractId: contractId || null,
      responsiblePartyId: responsiblePartyId || null,
      rfiId: rfiId || null,
      estimatedAmountRial: estimatedAmountRial || null,
      costImpactRial: costImpactRial || null,
      submittedAmountRial: submittedAmountRial || null,
      scheduleImpactDays: scheduleImpactDays === "" ? null : scheduleImpactDays,
    };
    const { ok, data } = variation
      ? await api<{ variation: Variation }>(`/api/aec/variations/${variation.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      : await api<{ variation: Variation }>(`/api/aec/projects/${projectId}/variations`, {
          method: "POST",
          body: JSON.stringify(body),
        });
    setSaving(false);
    if (!ok) {
      onError((data as unknown as { error?: string }).error);
      return;
    }
    await onSaved(data.variation.id);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-2xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">
            {variation ? `ویرایش تغییر ${variation.variationNumber}` : "ثبت تغییر / دستور کار"}
          </h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="شرح تغییر" hint="آنچه تغییر می‌کند و چرا — این متن به کارفرما می‌رود">
              <textarea
                className={inputClass}
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
          </div>
          <SelectField
            label="منشأ"
            value={source}
            onChange={(next) => setSource((next || "other") as VariationSource)}
            options={VARIATION_SOURCES}
            labels={VARIATION_SOURCE_LABELS}
          />
          <PickerField
            label="قرارداد"
            value={contractId}
            onChange={setContractId}
            options={contracts.map((contract) => ({
              id: contract.id,
              label: `${contract.title}${
                contract.valueRial === null ? "" : ` — ${money.format(contract.valueRial)}`
              }`,
            }))}
            hint="تغییر تأییدشده ارزش اصلاح‌شدهٔ همین قرارداد را جابه‌جا می‌کند"
          />
          <PickerField
            label="طرف مسئول"
            value={responsiblePartyId}
            onChange={setResponsiblePartyId}
            options={lookups.parties.map((party) => ({ id: party.id, label: party.name }))}
          />
          <PickerField
            label="استعلام مرتبط (RFI)"
            value={rfiId}
            onChange={setRfiId}
            options={rfis.map((rfi) => ({ id: rfi.id, label: `${rfi.rfiNumber} — ${rfi.subject}` }))}
          />
          <Field label="برآورد داخلی (ریال)" hint="هزینهٔ پیش‌بینی‌شدهٔ اجرای تغییر">
            <input
              className={inputClass}
              inputMode="numeric"
              value={estimatedAmountRial}
              onChange={(event) => setEstimatedAmountRial(event.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>
          <Field label="اثر هزینه‌ای (ریال)" hint="اثر بر هزینهٔ پروژه">
            <input
              className={inputClass}
              inputMode="numeric"
              value={costImpactRial}
              onChange={(event) => setCostImpactRial(event.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>
          <Field label="مبلغ پیشنهادی (ریال)" hint="آنچه از کارفرما خواسته می‌شود">
            <input
              className={inputClass}
              inputMode="numeric"
              value={submittedAmountRial}
              onChange={(event) => setSubmittedAmountRial(event.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>
          <Field label="اثر برنامه‌ای (روز)" hint="منفی یعنی تسریع یا حذف فعالیت">
            <input
              className={inputClass}
              inputMode="numeric"
              value={scheduleImpactDays}
              onChange={(event) =>
                setScheduleImpactDays(event.target.value.replace(/[^\d-]/g, ""))
              }
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="دلیل و توضیحات" hint="اختیاری">
              <textarea
                className={inputClass}
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/80 p-4">
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton disabled={saving || !description.trim()} onClick={() => void submit()}>
            <CheckCircle2Icon className="size-4" aria-hidden />
            {variation ? "ذخیره" : "ثبت تغییر"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
