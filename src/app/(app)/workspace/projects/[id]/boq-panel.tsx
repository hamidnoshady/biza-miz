"use client";

/**
 * Issue #799 §7 on screen — «متره و برآورد»: the project's BOQ.
 *
 * The screen has one job, stated by the issue: make a priced BOQ editable
 * without turning the project page into an ERP. So it is a *single* tab with
 * three levels of detail, each one a click deeper than the last:
 *
 *   1. the revisions (a row each, with their status and total),
 *   2. the selected revision's chapters and measured rows,
 *   3. one row's rate build-up, in a dialog.
 *
 * ## What the screen is careful about
 *
 *   * **An approved revision is read-only, and says so.** The lock is the
 *     database's (migration 0196), and the screen simply stops offering the
 *     buttons — no disabled-looking control that would fail if pressed.
 *   * **The arithmetic is shown before it is stored.** Every dialog previews
 *     the unit price and the line total using `computeBoqItemTotals` — the same
 *     exact-integer mirror of the database's trigger — so the number on the
 *     screen is the number the row will keep.
 *   * **Actual cost is never shown as a BOQ figure.** The variance card compares
 *     the approved revision with the ledger, and labels the second number as
 *     Accounting's.
 *   * **Money is entered in the business's own unit** (`useMoney`), like every
 *     other amount in the product, and crosses to the API as integer rial.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangleIcon,
  ClipboardListIcon,
  FileSpreadsheetIcon,
  PlusIcon,
  Trash2Icon,
  PencilIcon,
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
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
  overlayPanelClass,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  BOQ_UNITS,
  boqTotalFitsInApp,
  boqUnitLabel,
  computeBoqItemTotals,
  type EstimateVersionStatus,
} from "@/lib/aec-boq";
import type { WorkspaceLookups } from "../../use-workspace-lookups";
import { workspaceError } from "../../workspace-ui";

/* ---------------------------------------------------------------------------
 * Wire shapes — `/api/aec/**`
 * ------------------------------------------------------------------------- */

interface BoqVersionSummary {
  id: string;
  versionNo: number;
  title: string;
  status: EstimateVersionStatus;
  statusLabel: string;
  itemCount: number;
  totalRial: number;
  isEditable: boolean;
  submittedAt: string | null;
  reviewedAt: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  createdByName: string;
  createdAt: string;
}

interface BoqEstimateSummary {
  id: string;
  projectId: string;
  title: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  versions: BoqVersionSummary[];
  defaultVersionId: string | null;
}

interface BoqItem {
  id: string;
  sectionId: string | null;
  displayOrder: number;
  itemCode: string;
  description: string;
  unit: string;
  quantity: string;
  materialRateRial: number;
  laborRateRial: number;
  equipmentRateRial: number;
  subcontractRateRial: number;
  wastePercent: string;
  overheadPercent: string;
  markupPercent: string;
  unitPriceRial: number;
  totalRial: number;
  workPackage: string;
  partyId: string | null;
  partyName: string | null;
  notes: string;
}

interface BoqSection {
  id: string;
  code: string;
  title: string;
  displayOrder: number;
  notes: string;
  subtotalRial: number;
  items: BoqItem[];
}

interface BoqTree {
  estimate: { id: string; projectId: string; title: string; note: string; createdAt: string; updatedAt: string };
  versions: BoqVersionSummary[];
  versionTree: {
    version: BoqVersionSummary;
    sections: BoqSection[];
    unsectionedItems: BoqItem[];
    unitTotals: Array<{ unit: string; quantity: string }>;
    totalRial: number;
  } | null;
  events: Array<{
    id: string;
    versionId: string | null;
    action: string;
    actionLabel: string;
    summary: string;
    actorName: string;
    createdAt: string;
  }>;
}

interface BoqVariance {
  approvedEstimateRial: number | null;
  approvedVersionNo: number | null;
  approvedAt: string | null;
  budgetRial: number | null;
  spentRial: number;
  remainingRial: number | null;
}

/* ---------------------------------------------------------------------------
 * The editor's own shape
 * ------------------------------------------------------------------------- */

interface DraftSection {
  key: string;
  code: string;
  title: string;
}

interface DraftItem {
  key: string;
  sectionIndex: number | null;
  itemCode: string;
  description: string;
  unit: string;
  quantity: string;
  /** Rates are held in the business's display unit, exactly as typed. */
  materialRate: string;
  laborRate: string;
  equipmentRate: string;
  subcontractRate: string;
  wastePercent: string;
  overheadPercent: string;
  markupPercent: string;
  workPackage: string;
  partyId: string;
  notes: string;
}

let draftKeySeed = 0;
function newKey(): string {
  draftKeySeed += 1;
  return `d${draftKeySeed}`;
}

const STATUS_TONES: Record<EstimateVersionStatus, "positive" | "active" | "neutral" | "danger"> = {
  draft: "neutral",
  submitted: "active",
  under_review: "active",
  approved: "positive",
  superseded: "neutral",
};

function emptyItem(sectionIndex: number | null): DraftItem {
  return {
    key: newKey(),
    sectionIndex,
    itemCode: "",
    description: "",
    unit: "",
    quantity: "",
    materialRate: "",
    laborRate: "",
    equipmentRate: "",
    subcontractRate: "",
    wastePercent: "",
    overheadPercent: "",
    markupPercent: "",
    workPackage: "",
    partyId: "",
    notes: "",
  };
}

/* ---------------------------------------------------------------------------
 * The tab
 * ------------------------------------------------------------------------- */

export function BoqTab({
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
  const money = useMoney();
  const [estimates, setEstimates] = useState<BoqEstimateSummary[] | null>(null);
  const [variance, setVariance] = useState<BoqVariance | null>(null);
  const [estimateId, setEstimateId] = useState<string | null>(null);
  const [tree, setTree] = useState<BoqTree | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [draft, setDraft] = useState<{ sections: DraftSection[]; items: DraftItem[] } | null>(null);
  const [editing, setEditing] = useState<{ index: number; item: DraftItem } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [versionTitle, setVersionTitle] = useState("");
  const [addingVersion, setAddingVersion] = useState(false);
  const [reason, setReason] = useState("");
  const [returning, setReturning] = useState(false);

  const fail = (code: string | undefined) => setError(workspaceError(code));

  const loadList = useCallback(
    async (preferEstimateId?: string) => {
      const { ok, data } = await api<{ estimates: BoqEstimateSummary[]; variance: BoqVariance | null }>(
        `/api/aec/projects/${projectId}/estimates`,
      );
      if (!ok) {
        fail((data as unknown as { error?: string }).error);
        setEstimates([]);
        return null;
      }
      setEstimates(data.estimates);
      setVariance(data.variance);
      const next =
        data.estimates.find((estimate) => estimate.id === preferEstimateId) ?? data.estimates[0] ?? null;
      setEstimateId(next ? next.id : null);
      return next;
    },
    [projectId],
  );

  const loadTree = useCallback(async (id: string, versionId?: string | null) => {
    const query = versionId ? `?version=${versionId}` : "";
    const { ok, data } = await api<{ tree: BoqTree }>(`/api/aec/estimates/${id}${query}`);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setTree(data.tree);
    setDraft(null);
    setEditing(null);
  }, []);

  const refresh = useCallback(
    async (preferEstimateId?: string) => {
      const next = await loadList(preferEstimateId);
      if (next) await loadTree(next.id);
      else setTree(null);
    },
    [loadList, loadTree],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const version = tree?.versionTree?.version ?? null;
  const editable = Boolean(version?.isEditable);
  const versionTree = tree?.versionTree ?? null;
  const allItems = useMemo(
    () => [
      ...(versionTree?.sections.flatMap((section) => section.items) ?? []),
      ...(versionTree?.unsectionedItems ?? []),
    ],
    [versionTree],
  );

  // The trigger refuses a line whose total leaves the exact range this app can
  // hold (`Number.MAX_SAFE_INTEGER`, migration 0196). The form asks the same
  // question first — `boqTotalFitsInApp` is that bound — so an over-range line
  // is a sentence beside the table rather than a 400 after a click.
  const outOfRange = useMemo(
    () =>
      draft
        ? draft.items.filter((item) => !boqTotalFitsInApp(draftTotals(item, money).totalRial))
        : [],
    [draft, money],
  );

  function startEditing() {
    if (!tree?.versionTree) return;
    setDraft({
      sections: tree.versionTree.sections.map((section) => ({
        key: section.id,
        code: section.code,
        title: section.title,
      })),
      items: [
        ...tree.versionTree.sections.flatMap((section, index) =>
          section.items.map((item) => toDraftItem(item, index, money)),
        ),
        ...tree.versionTree.unsectionedItems.map((item) => toDraftItem(item, null, money)),
      ],
    });
  }

  async function saveDraft() {
    if (!draft || !version || busy) return;
    setBusy(true);
    setError("");
    const body = {
      sections: draft.sections.map((section) => ({ code: section.code, title: section.title, notes: "" })),
      items: draft.items.map((item) => ({
        sectionIndex: item.sectionIndex,
        itemCode: item.itemCode,
        description: item.description,
        unit: item.unit,
        quantity: item.quantity === "" ? 0 : Number(item.quantity),
        materialRateRial: money.parse(item.materialRate || "0"),
        laborRateRial: money.parse(item.laborRate || "0"),
        equipmentRateRial: money.parse(item.equipmentRate || "0"),
        subcontractRateRial: money.parse(item.subcontractRate || "0"),
        wastePercent: item.wastePercent === "" ? 0 : Number(item.wastePercent),
        overheadPercent: item.overheadPercent === "" ? 0 : Number(item.overheadPercent),
        markupPercent: item.markupPercent === "" ? 0 : Number(item.markupPercent),
        workPackage: item.workPackage,
        partyId: item.partyId || null,
        notes: item.notes,
      })),
    };
    const { ok, data } = await api<{ tree: BoqTree }>(`/api/aec/boq/versions/${version.id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setTree(data.tree);
    setDraft(null);
    setEditing(null);
    setNotice("ردیف‌ها ذخیره شد.");
    await loadList(estimateId ?? undefined);
  }

  async function act(action: "submit" | "start_review" | "approve" | "return", note = "") {
    if (!version || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ budgetSync?: string; projectBudgetRial?: number | null }>(
      `/api/aec/boq/versions/${version.id}/status`,
      { method: "POST", body: JSON.stringify({ action, note }) },
    );
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setReturning(false);
    setReason("");
    if (action === "approve" && data.budgetSync === "kept_manual") {
      setNotice(
        "برآورد تأیید شد. بودجهٔ پروژه دستی ثبت شده بود، پس بازنویسی نشد؛ برای هماهنگی آن را در پروندهٔ پروژه ویرایش کنید.",
      );
    } else {
      setNotice("وضعیت نسخه به‌روزرسانی شد.");
    }
    await refresh(estimateId ?? undefined);
  }

  async function createEstimate() {
    if (!newTitle.trim() || busy) return;
    setBusy(true);
    const { ok, data } = await api<{ estimate: BoqEstimateSummary }>(
      `/api/aec/projects/${projectId}/estimates`,
      { method: "POST", body: JSON.stringify({ title: newTitle }) },
    );
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setCreating(false);
    setNewTitle("");
    await refresh(data.estimate.id);
  }

  async function createVersion() {
    if (!estimateId || busy) return;
    setBusy(true);
    const { ok, data } = await api<{ version: BoqVersionSummary }>(
      `/api/aec/estimates/${estimateId}/versions`,
      {
        method: "POST",
        body: JSON.stringify({
          title: versionTitle,
          cloneFromVersionId: version?.id ?? null,
        }),
      },
    );
    setBusy(false);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setAddingVersion(false);
    setVersionTitle("");
    await loadTree(estimateId, data.version.id);
    await loadList(estimateId);
    setNotice("نسخهٔ پیش‌نویس تازه ساخته شد.");
  }

  if (!estimates) {
    return (
      <div className="flex flex-col gap-4">
        <KpiRow>
          <KpiCard label="جمع برآورد" value="—" />
          <KpiCard label="ردیف‌ها" value="—" />
          <KpiCard label="نسخهٔ تأییدشده" value="—" />
          <KpiCard label="هزینهٔ ثبت‌شده" value="—" />
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
        <KpiCard
          label="جمع نسخهٔ جاری"
          value={tree?.versionTree ? money.format(tree.versionTree.totalRial) : "—"}
          hint={version ? `نسخهٔ ${n(version.versionNo)}` : undefined}
        />
        <KpiCard label="تعداد ردیف" value={tree?.versionTree ? n(allItems.length) : "—"} />
        <KpiCard
          label="برآورد تأییدشده"
          value={variance?.approvedEstimateRial == null ? "—" : money.format(variance.approvedEstimateRial)}
          hint={variance?.approvedVersionNo ? `نسخهٔ ${n(variance.approvedVersionNo)}` : "تأیید نشده"}
        />
        <KpiCard
          label="هزینهٔ ثبت‌شده"
          value={variance ? money.format(variance.spentRial) : "—"}
          hint="از اسناد حسابداری"
        />
      </KpiRow>

      {variance?.approvedEstimateRial != null ? (
        <SectionCard
          title="مغایرت برآورد و هزینهٔ واقعی"
          description="مبلغ برآورد از نسخهٔ تأییدشده، هزینهٔ واقعی از اسناد حسابداری همان پروژه"
        >
          <dl className="grid grid-cols-2 gap-4 p-4 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">برآورد تأییدشده</dt>
              <dd className="mt-1 font-semibold tabular-nums">{money.format(variance.approvedEstimateRial)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">هزینهٔ ثبت‌شده</dt>
              <dd className="mt-1 font-semibold tabular-nums">{money.format(variance.spentRial)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">باقی‌مانده</dt>
              <dd
                className={
                  (variance.remainingRial ?? 0) < 0
                    ? "mt-1 font-semibold tabular-nums text-rose-700 dark:text-rose-300"
                    : "mt-1 font-semibold tabular-nums"
                }
              >
                {variance.remainingRial == null ? "—" : money.format(variance.remainingRial)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">بودجهٔ پروژه</dt>
              <dd className="mt-1 font-semibold tabular-nums">
                {variance.budgetRial == null ? "—" : money.format(variance.budgetRial)}
              </dd>
            </div>
          </dl>
        </SectionCard>
      ) : null}

      <SectionCard
        title="برآوردها"
        description="هر پروژه می‌تواند چند برآورد داشته باشد؛ هر برآورد نسخه‌های خودش را دارد."
        actions={
          canManage ? (
            <div className="flex flex-wrap items-center gap-2">
              <SecondaryButton onClick={() => setCreating((open) => !open)}>
                <PlusIcon className="size-4" aria-hidden />
                برآورد جدید
              </SecondaryButton>
              {estimateId ? (
                <SecondaryButton onClick={() => setAddingVersion((open) => !open)}>
                  نسخهٔ جدید
                </SecondaryButton>
              ) : null}
            </div>
          ) : null
        }
      >
        {creating ? (
          <div className="flex flex-wrap items-end gap-2 border-b border-border/80 p-4">
            <Field label="عنوان برآورد">
              <input
                className={inputClass}
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
                placeholder="مثلاً برآورد اولیه"
              />
            </Field>
            <PrimaryButton onClick={createEstimate} disabled={busy || !newTitle.trim()}>
              ایجاد
            </PrimaryButton>
            <SecondaryButton onClick={() => setCreating(false)}>انصراف</SecondaryButton>
          </div>
        ) : null}

        {estimates.length === 0 ? (
          <EmptyState icon={ClipboardListIcon} title="هنوز برآوردی ثبت نشده است">
            <span className="flex flex-col gap-2">
              <span>
                یک برآورد بسازید و ردیف‌های متره را وارد کنید، یا فایل اکسل/CSV را از «ورود و خروج داده»
                وارد کنید.
              </span>
              <Link
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:underline"
                href="/settings/transfer"
              >
                <FileSpreadsheetIcon className="size-4" aria-hidden />
                ورود فایل اکسل/CSV از «ورود و خروج داده»
              </Link>
            </span>
          </EmptyState>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 border-b border-border/80 p-4">
              {estimates.map((estimate) => (
                <button
                  key={estimate.id}
                  type="button"
                  onClick={() => {
                    setEstimateId(estimate.id);
                    setNotice("");
                    void loadTree(estimate.id);
                  }}
                  className={
                    estimate.id === estimateId
                      ? "rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-950 dark:bg-amber-500/20 dark:text-amber-100"
                      : "rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground hover:bg-muted/70"
                  }
                >
                  {estimate.title}
                  <span className="px-1 text-xs opacity-70">
                    {n(estimate.versions.length)} نسخه
                  </span>
                </button>
              ))}
            </div>

            <div className="divide-y divide-border/80">
              {(tree?.versions ?? []).map((row) => (
                <div key={row.id} className="flex flex-wrap items-center gap-2 p-4 text-sm">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-right font-medium underline-offset-4 hover:underline"
                    onClick={() => estimateId && void loadTree(estimateId, row.id)}
                  >
                    نسخهٔ {n(row.versionNo)}
                    {row.title ? <span className="px-2 text-xs text-muted-foreground">{row.title}</span> : null}
                  </button>
                  <StatusBadge tone={STATUS_TONES[row.status]}>{row.statusLabel}</StatusBadge>
                  <span className="w-32 text-left tabular-nums">{money.format(row.totalRial)}</span>
                  <span className="w-16 text-left text-xs text-muted-foreground">
                    {n(row.itemCount)} ردیف
                  </span>
                  {row.status === "approved" && row.approvedByName ? (
                    <span className="text-xs text-muted-foreground">
                      تأیید: {row.approvedByName}
                      {row.approvedAt ? ` — ${formatJalali(row.approvedAt)}` : ""}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
                    aria-label="نمایش این نسخه"
                    onClick={() => estimateId && void loadTree(estimateId, row.id)}
                  >
                    <PencilIcon className="size-4" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </SectionCard>

      {addingVersion ? (
        <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border/80 p-4">
          <Field label="عنوان نسخه" hint="مثلاً بازنگری پس از تغییر نقشه‌ها">
            <input
              className={inputClass}
              value={versionTitle}
              onChange={(event) => setVersionTitle(event.target.value)}
            />
          </Field>
          <PrimaryButton onClick={createVersion} disabled={busy}>
            {version ? "رونوشت از نسخهٔ جاری و ساخت پیش‌نویس" : "ساخت پیش‌نویس"}
          </PrimaryButton>
          <SecondaryButton onClick={() => setAddingVersion(false)}>انصراف</SecondaryButton>
        </div>
      ) : null}

      {tree?.versionTree ? (
        <SectionCard
          title={`فصل‌ها و ردیف‌های نسخهٔ ${n(tree.versionTree.version.versionNo)}`}
          description={
            tree.versionTree.version.isEditable
              ? "این نسخه پیش‌نویس است و قابل ویرایش."
              : "این نسخه قفل است؛ برای تغییر اعداد، نسخهٔ پیش‌نویس تازه بسازید."
          }
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {editable && canManage && !draft ? (
                <SecondaryButton onClick={startEditing}>
                  <PencilIcon className="size-4" aria-hidden />
                  ویرایش ردیف‌ها
                </SecondaryButton>
              ) : null}
              {editable && canManage && draft ? (
                <>
                  <PrimaryButton onClick={saveDraft} disabled={busy || outOfRange.length > 0}>
                    {busy ? "در حال ذخیره" : "ذخیره"}
                  </PrimaryButton>
                  <SecondaryButton onClick={() => setDraft(null)}>انصراف</SecondaryButton>
                  <SecondaryButton
                    onClick={() =>
                      setDraft((current) =>
                        current
                          ? {
                              sections: current.sections,
                              items: [...current.items, emptyItem(current.sections.length - 1)],
                            }
                          : current,
                      )
                    }
                  >
                    <PlusIcon className="size-4" aria-hidden />
                    ردیف
                  </SecondaryButton>
                  <SecondaryButton
                    onClick={() =>
                      setDraft((current) =>
                        current
                          ? {
                              sections: [
                                ...current.sections,
                                { key: newKey(), code: "", title: "" },
                              ],
                              items: current.items,
                            }
                          : current,
                      )
                    }
                  >
                    <PlusIcon className="size-4" aria-hidden />
                    فصل
                  </SecondaryButton>
                </>
              ) : null}
              {editable && canManage ? (
                <PrimaryButton onClick={() => act("submit")} disabled={busy}>
                  ثبت برای بررسی
                </PrimaryButton>
              ) : null}
              {canApprove && tree.versionTree.version.status === "submitted" ? (
                <SecondaryButton onClick={() => act("start_review")} disabled={busy}>
                  شروع بررسی
                </SecondaryButton>
              ) : null}
              {canApprove &&
              (tree.versionTree.version.status === "submitted" ||
                tree.versionTree.version.status === "under_review") ? (
                <>
                  <PrimaryButton onClick={() => act("approve")} disabled={busy}>
                    تأیید
                  </PrimaryButton>
                  <SecondaryButton onClick={() => setReturning((open) => !open)} disabled={busy}>
                    بازگشت به پیش‌نویس
                  </SecondaryButton>
                </>
              ) : null}
            </div>
          }
        >
          {returning ? (
            <div className="flex flex-wrap items-end gap-2 border-b border-border/80 p-4">
              <Field label="دلیل بازگشت" hint="در تاریخچه و در اطلاع تأیید ثبت می‌شود.">
                <input
                  className={inputClass}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
              <PrimaryButton onClick={() => act("return", reason)} disabled={busy}>
                بازگشت به پیش‌نویس
              </PrimaryButton>
              <SecondaryButton onClick={() => setReturning(false)}>انصراف</SecondaryButton>
            </div>
          ) : null}

          {outOfRange.length > 0 ? (
            <p className="flex items-start gap-2 rounded-xl border border-amber-300/70 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
              جمع {toPersianDigits(String(outOfRange.length))} ردیف از بازهٔ قابل پشتیبانی بزرگ‌تر است.
              مقدار یا نرخ‌های آن را کم کنید تا ذخیره ممکن شود.
            </p>
          ) : null}

          {allItems.length === 0 && !draft ? (
            <EmptyState icon={ClipboardListIcon} title="این نسخه ردیفی ندارد">
              فصل‌ها و ردیف‌های متره را اضافه کنید، یا فایل اکسل/CSV را از «ورود و خروج داده» وارد کنید.
            </EmptyState>
          ) : (
            <DataTable
              caption={`فصل‌ها و ردیف‌های متره — ${version?.title ?? tree.estimate.title}`}
              tableClassName="min-w-[46rem]"
            >
              <DataTableHead>
                <Th>کد</Th>
                <Th>شرح</Th>
                <Th>واحد</Th>
                <Th numeric>مقدار</Th>
                <Th numeric>قیمت واحد</Th>
                <Th numeric>جمع</Th>
                {draft ? <Th /> : null}
              </DataTableHead>
              <DataTableBody>
                  {draft
                    ? draft.sections.map((section, index) => (
                        <DraftSectionRows
                          key={section.key}
                          section={section}
                          index={index}
                          items={draft.items}
                          money={money}
                          onEditSection={(patch) =>
                            setDraft((current) =>
                              current
                                ? {
                                    sections: current.sections.map((row, i) =>
                                      i === index ? { ...row, ...patch } : row,
                                    ),
                                    items: current.items,
                                  }
                                : current,
                            )
                          }
                          onRemoveSection={() =>
                            setDraft((current) =>
                              current
                                ? {
                                    sections: current.sections.filter((_, i) => i !== index),
                                    items: current.items
                                      .filter((item) => item.sectionIndex !== index)
                                      .map((item) => ({
                                        ...item,
                                        sectionIndex:
                                          item.sectionIndex !== null && item.sectionIndex > index
                                            ? item.sectionIndex - 1
                                            : item.sectionIndex,
                                      })),
                                  }
                                : current,
                            )
                          }
                          onEdit={(itemIndex) =>
                            setEditing({
                              index: itemIndex,
                              item: { ...draft.items[itemIndex] },
                            })
                          }
                          onAdd={() =>
                            setEditing({ index: -1, item: emptyItem(index) })
                          }
                        />
                      ))
                    : null}

                  {draft
                    ? draft.items
                        .filter((item) => item.sectionIndex === null)
                        .map((item) => (
                          <DraftRow
                            key={item.key}
                            item={item}
                            money={money}
                            onEdit={() =>
                              setEditing({
                                index: draft.items.findIndex((row) => row.key === item.key),
                                item: { ...item },
                              })
                            }
                          />
                        ))
                    : null}

                  {!draft
                    ? (versionTree?.sections ?? []).map((section) => (
                        <ItemGroup key={section.id} title={section.title} code={section.code}>
                          {section.items.map((item) => (
                            <ReadRow key={item.id} item={item} money={money} />
                          ))}
                          <SubtotalRow label={`جمع ${section.title}`} totalRial={section.subtotalRial} money={money} />
                        </ItemGroup>
                      ))
                    : null}

                  {!draft && (versionTree?.unsectionedItems.length ?? 0) > 0 ? (
                    <ItemGroup title="بدون فصل" code="">
                      {(versionTree?.unsectionedItems ?? []).map((item) => (
                        <ReadRow key={item.id} item={item} money={money} />
                      ))}
                    </ItemGroup>
                  ) : null}
              </DataTableBody>
            </DataTable>
          )}

          {tree.versionTree.unitTotals.length > 0 ? (
            <div className="flex flex-wrap items-center gap-3 border-t border-border/80 p-4 text-xs text-muted-foreground">
              <span>مجموع مقدار به تفکیک واحد:</span>
              {tree.versionTree.unitTotals.map((row) => (
                <span key={row.unit} className="tabular-nums">
                  {toPersianDigits(Number(row.quantity).toLocaleString("en-US"))}{" "}
                  {boqUnitLabel(row.unit) || row.unit}
                </span>
              ))}
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {tree && tree.events.length > 0 ? (
        <SectionCard title="تاریخچهٔ برآورد" description="ثبت، بررسی، تأیید و منسوخ‌شدن نسخه‌ها">
          <ul className="divide-y divide-border/80 text-sm">
            {tree.events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-center gap-2 p-3">
                <span className="flex-1">{event.actionLabel}</span>
                {event.summary ? (
                  <span className="min-w-0 truncate text-xs text-muted-foreground">{event.summary}</span>
                ) : null}
                {event.actorName ? (
                  <span className="text-xs text-muted-foreground">{event.actorName}</span>
                ) : null}
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatJalali(event.createdAt, { withTime: true })}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {editing ? (
        <ItemDialog
          item={editing.item}
          sections={draft?.sections ?? []}
          parties={lookups.parties}
          money={money}
          onClose={() => setEditing(null)}
          onSubmit={(item) => {
            if (!draft) return;
            const items =
              editing.index === -1
                ? [...draft.items, item]
                : draft.items.map((row, index) => (index === editing.index ? item : row));
            setDraft({ sections: draft.sections, items });
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Rows
 * ------------------------------------------------------------------------- */

function ItemGroup({
  title,
  code,
  children,
}: {
  title: string;
  code: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <DataTableRow className="bg-muted/30">
        <Td colSpan={6} className="text-xs font-medium sm:text-sm">
          {code ? <span className="px-2 text-xs text-muted-foreground">{code}</span> : null}
          {title}
        </Td>
      </DataTableRow>
      {children}
    </>
  );
}

function SubtotalRow({
  label,
  totalRial,
  money,
}: {
  label: string;
  totalRial: number;
  money: { format: (rial: number) => string };
}) {
  return (
    <DataTableRow>
      <Td colSpan={5} muted className="text-xs">
        {label}
      </Td>
      <Td numeric className="text-xs">
        {money.format(totalRial)}
      </Td>
    </DataTableRow>
  );
}

function ReadRow({ item, money }: { item: BoqItem; money: { format: (rial: number) => string } }) {
  return (
    <DataTableRow>
      <Td muted className="text-xs">
        {item.itemCode || "—"}
      </Td>
      <Td>{item.description}</Td>
      <Td>{boqUnitLabel(item.unit) || "—"}</Td>
      <Td numeric>{toPersianDigits(Number(item.quantity).toLocaleString("en-US"))}</Td>
      <Td numeric>{money.format(item.unitPriceRial)}</Td>
      <Td numeric>{money.format(item.totalRial)}</Td>
    </DataTableRow>
  );
}

interface Moneyish {
  format: (rial: number) => string;
  parse: (input: string) => number;
  toInput: (rial: number) => number;
}

function draftTotals(item: DraftItem, money: Moneyish) {
  return computeBoqItemTotals({
    quantity: item.quantity === "" ? "0" : item.quantity,
    materialRateRial: money.parse(item.materialRate || "0"),
    laborRateRial: money.parse(item.laborRate || "0"),
    equipmentRateRial: money.parse(item.equipmentRate || "0"),
    subcontractRateRial: money.parse(item.subcontractRate || "0"),
    wastePercent: item.wastePercent === "" ? "0" : item.wastePercent,
    overheadPercent: item.overheadPercent === "" ? "0" : item.overheadPercent,
    markupPercent: item.markupPercent === "" ? "0" : item.markupPercent,
  });
}

function DraftRow({
  item,
  money,
  onEdit,
}: {
  item: DraftItem;
  money: Moneyish;
  onEdit: () => void;
}) {
  const totals = draftTotals(item, money);
  return (
    <DataTableRow>
      <Td muted className="text-xs">
        {item.itemCode || "—"}
      </Td>
      <Td>{item.description || <span className="text-muted-foreground">—</span>}</Td>
      <Td>{boqUnitLabel(item.unit) || "—"}</Td>
      <Td numeric>
        {item.quantity ? toPersianDigits(Number(item.quantity).toLocaleString("en-US")) : "—"}
      </Td>
      <Td numeric>{money.format(totals.unitPriceRial)}</Td>
      <Td numeric>{money.format(totals.totalRial)}</Td>
      <Td className="text-end">
        <button
          type="button"
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
          aria-label="ویرایش ردیف"
          onClick={onEdit}
        >
          <PencilIcon className="size-4" aria-hidden />
        </button>
      </Td>
    </DataTableRow>
  );
}

function DraftSectionRows({
  section,
  index,
  items,
  money,
  onEditSection,
  onRemoveSection,
  onEdit,
  onAdd,
}: {
  section: DraftSection;
  index: number;
  items: DraftItem[];
  money: Moneyish;
  onEditSection: (patch: Partial<DraftSection>) => void;
  onRemoveSection: () => void;
  onEdit: (itemIndex: number) => void;
  onAdd: () => void;
}) {
  const own = items
    .map((item, itemIndex) => ({ item, itemIndex }))
    .filter((row) => row.item.sectionIndex === index);
  return (
    <>
      <DataTableRow className="bg-muted/30">
        <Td colSpan={7} className="py-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={`${inputClass} w-20`}
              value={section.code}
              placeholder="کد"
              aria-label="کد فصل"
              onChange={(event) => onEditSection({ code: event.target.value })}
            />
            <input
              className={`${inputClass} flex-1`}
              value={section.title}
              placeholder="عنوان فصل"
              aria-label="عنوان فصل"
              onChange={(event) => onEditSection({ title: event.target.value })}
            />
            <SecondaryButton onClick={onAdd}>
              <PlusIcon className="size-4" aria-hidden />
              ردیف
            </SecondaryButton>
            <button
              type="button"
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
              aria-label="حذف فصل"
              onClick={onRemoveSection}
            >
              <Trash2Icon className="size-4" aria-hidden />
            </button>
          </div>
        </Td>
      </DataTableRow>
      {own.map(({ item, itemIndex }) => (
        <DraftRow key={item.key} item={item} money={money} onEdit={() => onEdit(itemIndex)} />
      ))}
    </>
  );
}

/* ---------------------------------------------------------------------------
 * The row dialog — where the rate build-up lives
 * ------------------------------------------------------------------------- */

function ItemDialog({
  item,
  sections,
  parties,
  money,
  onClose,
  onSubmit,
}: {
  item: DraftItem;
  sections: DraftSection[];
  parties: WorkspaceLookups["parties"];
  money: Moneyish;
  onClose: () => void;
  onSubmit: (item: DraftItem) => void;
}) {
  const [row, setRow] = useState<DraftItem>(item);
  const totals = draftTotals(row, money);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} my-8 w-full max-w-2xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">ردیف متره</h2>
          <button
            type="button"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
            aria-label="بستن"
            onClick={onClose}
          >
            <XIcon className="size-4" aria-hidden />
          </button>
        </div>

        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="فصل">
            <select
              className={inputClass}
              value={row.sectionIndex === null ? "" : String(row.sectionIndex)}
              onChange={(event) =>
                setRow({
                  ...row,
                  sectionIndex: event.target.value === "" ? null : Number(event.target.value),
                })
              }
            >
              <option value="">بدون فصل</option>
              {sections.map((section, index) => (
                <option key={section.key} value={index}>
                  {section.title || `فصل ${index + 1}`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="کد ردیف">
            <input
              className={inputClass}
              value={row.itemCode}
              onChange={(event) => setRow({ ...row, itemCode: event.target.value })}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="شرح">
              <input
                className={inputClass}
                value={row.description}
                onChange={(event) => setRow({ ...row, description: event.target.value })}
              />
            </Field>
          </div>
          <Field label="واحد">
            <input
              className={inputClass}
              list="boq-units"
              value={row.unit}
              onChange={(event) => setRow({ ...row, unit: event.target.value })}
            />
            <datalist id="boq-units">
              {BOQ_UNITS.map((unit) => (
                <option key={unit.key} value={unit.key}>
                  {unit.label}
                </option>
              ))}
            </datalist>
          </Field>
          <Field label="مقدار" hint="تا چهار رقم اعشار">
            <PersianNumberInput
              className={inputClass}
              allowDecimal
              grouping={false}
              value={row.quantity}
              onChange={(event) => setRow({ ...row, quantity: event.target.value })}
            />
          </Field>

          <Field label="نرخ مصالح">
            <PersianNumberInput
              className={inputClass}
              value={row.materialRate}
              onChange={(event) => setRow({ ...row, materialRate: event.target.value })}
            />
          </Field>
          <Field label="نرخ دستمزد">
            <PersianNumberInput
              className={inputClass}
              value={row.laborRate}
              onChange={(event) => setRow({ ...row, laborRate: event.target.value })}
            />
          </Field>
          <Field label="نرخ ماشین‌آلات">
            <PersianNumberInput
              className={inputClass}
              value={row.equipmentRate}
              onChange={(event) => setRow({ ...row, equipmentRate: event.target.value })}
            />
          </Field>
          <Field label="نرخ پیمانکار جزء">
            <PersianNumberInput
              className={inputClass}
              value={row.subcontractRate}
              onChange={(event) => setRow({ ...row, subcontractRate: event.target.value })}
            />
          </Field>

          <Field label="ضریب پرت (٪)">
            <PersianNumberInput
              className={inputClass}
              allowDecimal
              grouping={false}
              value={row.wastePercent}
              onChange={(event) => setRow({ ...row, wastePercent: event.target.value })}
            />
          </Field>
          <Field label="سربار (٪)">
            <PersianNumberInput
              className={inputClass}
              allowDecimal
              grouping={false}
              value={row.overheadPercent}
              onChange={(event) => setRow({ ...row, overheadPercent: event.target.value })}
            />
          </Field>
          <Field label="سود (٪)">
            <PersianNumberInput
              className={inputClass}
              allowDecimal
              grouping={false}
              value={row.markupPercent}
              onChange={(event) => setRow({ ...row, markupPercent: event.target.value })}
            />
          </Field>
          <Field label="بستهٔ کاری">
            <input
              className={inputClass}
              value={row.workPackage}
              onChange={(event) => setRow({ ...row, workPackage: event.target.value })}
            />
          </Field>

          <Field label="تأمین‌کننده/پیمانکار">
            <select
              className={inputClass}
              value={row.partyId}
              onChange={(event) => setRow({ ...row, partyId: event.target.value })}
            >
              <option value="">— انتخاب کنید —</option>
              {parties.map((party) => (
                <option key={party.id} value={party.id}>
                  {party.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="توضیحات">
            <input
              className={inputClass}
              value={row.notes}
              onChange={(event) => setRow({ ...row, notes: event.target.value })}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-4 border-t border-border/80 bg-muted/30 p-4 text-sm">
          <span className="text-muted-foreground">قیمت واحد:</span>
          <span className="font-semibold tabular-nums">{money.format(totals.unitPriceRial)}</span>
          <span className="text-muted-foreground">جمع ردیف:</span>
          <span className="font-semibold tabular-nums">{money.format(totals.totalRial)}</span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <AlertTriangleIcon className="size-3.5" aria-hidden />
            همین دو عدد در سرور بازمحاسبه و ذخیره می‌شوند.
          </span>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/80 p-4">
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton onClick={() => onSubmit(row)} disabled={!row.description.trim()}>
            ثبت ردیف
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

function toDraftItem(item: BoqItem, sectionIndex: number | null, money: Moneyish): DraftItem {
  return {
    key: item.id,
    sectionIndex,
    itemCode: item.itemCode,
    description: item.description,
    unit: item.unit,
    quantity: item.quantity,
    // The form works in the business's display unit (the same unit every other
    // money field in the product uses) and `money.parse` turns the value back
    // into integer rial on save — so a Toman business never re-saves a rate ten
    // times too large.
    materialRate: rateToInput(item.materialRateRial, money),
    laborRate: rateToInput(item.laborRateRial, money),
    equipmentRate: rateToInput(item.equipmentRateRial, money),
    subcontractRate: rateToInput(item.subcontractRateRial, money),
    wastePercent: trimZeros(item.wastePercent),
    overheadPercent: trimZeros(item.overheadPercent),
    markupPercent: trimZeros(item.markupPercent),
    workPackage: item.workPackage,
    partyId: item.partyId ?? "",
    notes: item.notes,
  };
}

/** Rial as typed by the person who will re-save the row: plain, unformatted. */
function rateToInput(rial: number, money: Moneyish): string {
  return rial === 0 ? "" : String(money.toInput(rial));
}

function trimZeros(value: string): string {
  if (!value) return "";
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed === 0) return "";
  return String(parsed);
}
