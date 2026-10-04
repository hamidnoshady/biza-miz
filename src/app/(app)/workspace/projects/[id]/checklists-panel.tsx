"use client";

/**
 * Issue #799 §14's checklists — the firm's standards for an inspection and for a
 * handover, and the template a register entry is filled out against.
 *
 * ## Why a checklist is business-scoped
 *
 * A checklist is not project data: it is *the firm's way of inspecting*. The
 * same «چک‌لیست تحویل واحد» is used on every project, so the register stores the
 * standard once (with an optional `projectId` for the client who insists on
 * their own) and every issue copies the items it was filled out against. That
 * copy is deliberate: editing the standard tomorrow must not rewrite what an
 * inspection recorded today (§33's immutable history), so the issue keeps the
 * labels, and the link back to the template is provenance rather than a live
 * reference.
 *
 * ## What the screen offers
 *
 * Create, rename, re-order (add/remove items — the order is the column
 * `position`), deactivate, and delete. Deactivating is the ordinary way to
 * retire a checklist: `isActive = false` keeps it readable on the issues that
 * used it while taking it out of every picker. Deleting is for a mistake.
 */

import { useCallback, useEffect, useState } from "react";
import { ClipboardCheckIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import {
  EmptyState,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
  overlayPanelClass,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { AEC_SPECIALTIES, AEC_SPECIALTY_LABELS, type AecSpecialty } from "@/lib/aec";
import {
  SITE_CHECKLIST_KINDS,
  SITE_CHECKLIST_KIND_LABELS,
  type SiteChecklistKind,
} from "@/lib/aec-site";
import { DateCell, SelectField, workspaceError } from "../../workspace-ui";

interface ChecklistItem {
  id: string;
  title: string;
  guidance: string;
  position: number;
}

interface ChecklistSummary {
  id: string;
  projectId: string | null;
  projectName: string | null;
  name: string;
  kind: SiteChecklistKind;
  kindLabel: string;
  discipline: string | null;
  disciplineLabel: string;
  description: string;
  isActive: boolean;
  itemCount: number;
  createdAt: string;
  createdByName: string;
}

interface ChecklistDetail extends ChecklistSummary {
  items: ChecklistItem[];
}

export function AecChecklistsSection({
  projectId,
  canManage,
}: {
  projectId: string;
  canManage: boolean;
}) {
  const [checklists, setChecklists] = useState<ChecklistSummary[] | null>(null);
  const [editing, setEditing] = useState<ChecklistDetail | "new" | null>(null);
  const [includeInactive, setIncludeInactive] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const fail = (code: string | undefined) => setError(workspaceError(code));

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (includeInactive) params.set("includeInactive", "1");
    const { ok, data } = await api<{ checklists: ChecklistSummary[] }>(
      `/api/aec/checklists?${params.toString()}`,
    );
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      setChecklists([]);
      return;
    }
    setChecklists(data.checklists);
  }, [includeInactive]);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(id: string) {
    const { ok, data } = await api<{ checklist: ChecklistDetail }>(`/api/aec/checklists/${id}`);
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setEditing(data.checklist);
  }

  async function remove(checklist: ChecklistSummary) {
    if (!window.confirm(`چک‌لیست «${checklist.name}» حذف شود؟ مواردی که با آن بازرسی شده‌اند دست‌نخورده می‌مانند.`)) {
      return;
    }
    const { ok, data } = await api(`/api/aec/checklists/${checklist.id}`, { method: "DELETE" });
    if (!ok) {
      fail((data as unknown as { error?: string }).error);
      return;
    }
    setNotice("چک‌لیست حذف شد.");
    await load();
  }

  return (
    <SectionCard
      title="چک‌لیست‌های بازرسی و تحویل"
      description="الگوهای همیشگی دفتر: بندهای بازرسی یا تحویل را یک بار می‌سازید و هر مورد کارگاه با یک کلیک همان بندها را روی خود کپی می‌کند."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
            />
            نمایش غیرفعال‌ها
          </label>
          {canManage ? (
            <SecondaryButton onClick={() => setEditing("new")}>
              <PlusIcon className="size-4" aria-hidden />
              چک‌لیست جدید
            </SecondaryButton>
          ) : null}
        </div>
      }
      actionsClassName="max-sm:w-full"
      flush
    >
      {error ? (
        <div className="p-4">
          <ErrorBox>{error}</ErrorBox>
        </div>
      ) : null}
      {notice ? (
        <p className="border-b border-border/80 bg-muted/40 p-3 text-sm">{notice}</p>
      ) : null}

      {editing ? (
        <ChecklistForm
          projectId={projectId}
          checklist={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onError={fail}
          onSaved={async () => {
            setEditing(null);
            setNotice("چک‌لیست ذخیره شد.");
            await load();
          }}
        />
      ) : null}

      {checklists === null ? (
        <SectionCardSkeleton rows={3} />
      ) : checklists.length === 0 ? (
        <EmptyState icon={ClipboardCheckIcon} title="چک‌لیستی ساخته نشده است">
          بندهای استاندارد خودتان را یک بار اینجا وارد کنید تا در هر بازرسی و تحویل، به‌جای تایپ
          دوباره، روی مورد کپی شوند.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border/80">
          {checklists.map((checklist) => (
            <li
              key={checklist.id}
              className="flex flex-wrap items-center justify-between gap-3 p-4"
            >
              <div className="flex min-w-0 flex-col">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {checklist.name}
                  <StatusBadge tone={checklist.isActive ? "positive" : "neutral"}>
                    {checklist.isActive ? "فعال" : "غیرفعال"}
                  </StatusBadge>
                  <StatusBadge tone="neutral">{checklist.kindLabel}</StatusBadge>
                </span>
                <span className="text-xs text-muted-foreground">
                  {checklist.itemCount > 0
                    ? `${checklist.itemCount} بند`
                    : "بدون بند"}
                  {checklist.projectName ? ` • مخصوص ${checklist.projectName}` : " • استاندارد دفتر"}
                  {checklist.disciplineLabel ? ` • ${checklist.disciplineLabel}` : ""}
                  {" • ساخته‌شده در "}
                  <DateCell date={checklist.createdAt.slice(0, 10)} relative={false} />
                </span>
                {checklist.description ? (
                  <span className="text-xs text-muted-foreground">{checklist.description}</span>
                ) : null}
              </div>
              {canManage ? (
                <div className="flex items-center gap-1">
                  <SecondaryButton onClick={() => void open(checklist.id)}>ویرایش</SecondaryButton>
                  <button
                    type="button"
                    className="rounded-lg p-1.5 text-destructive hover:bg-destructive/10"
                    title="حذف"
                    onClick={() => void remove(checklist)}
                  >
                    <Trash2Icon className="size-4" aria-hidden />
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* --------------------------------------------------------------------------- */

interface ItemDraft {
  title: string;
  guidance: string;
}

function ChecklistForm({
  projectId,
  checklist,
  onClose,
  onSaved,
  onError,
}: {
  projectId: string;
  checklist?: ChecklistDetail;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  onError: (code: string | undefined) => void;
}) {
  const [name, setName] = useState(checklist?.name ?? "");
  const [kind, setKind] = useState<SiteChecklistKind>(checklist?.kind ?? "inspection");
  const [description, setDescription] = useState(checklist?.description ?? "");
  const [discipline, setDiscipline] = useState(checklist?.discipline ?? "");
  const [scope, setScope] = useState(checklist?.projectId ? "project" : "business");
  const [isActive, setIsActive] = useState(checklist?.isActive ?? true);
  const [items, setItems] = useState<ItemDraft[]>(
    checklist?.items.map((item) => ({ title: item.title, guidance: item.guidance })) ?? [
      { title: "", guidance: "" },
    ],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const patchItem = (index: number, patch: Partial<ItemDraft>) =>
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    const payload = {
      name,
      kind,
      description,
      discipline: discipline || null,
      projectId: scope === "project" ? projectId : null,
      isActive,
      items: items
        .filter((item) => item.title.trim())
        .map((item) => ({ title: item.title.trim(), guidance: item.guidance })),
    };
    const { ok, data } = checklist
      ? await api<{ checklist: ChecklistDetail }>(`/api/aec/checklists/${checklist.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      : await api<{ checklist: ChecklistDetail }>(`/api/aec/checklists`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
    setBusy(false);
    if (!ok) {
      const code = (data as unknown as { error?: string }).error;
      setError(workspaceError(code));
      onError(code);
      return;
    }
    await onSaved();
  }

  return (
    <div className={overlayPanelClass}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold">
          {checklist ? `ویرایش «${checklist.name}»` : "چک‌لیست جدید"}
        </h3>
        <button
          type="button"
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
          onClick={onClose}
          aria-label="بستن"
        >
          <XIcon className="size-4" aria-hidden />
        </button>
      </div>
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="نام چک‌لیست">
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="چک‌لیست تحویل واحد"
          />
        </Field>
        <SelectField
          label="کاربرد"
          value={kind}
          onChange={(next) => setKind((next || "inspection") as SiteChecklistKind)}
          options={SITE_CHECKLIST_KINDS}
          labels={SITE_CHECKLIST_KIND_LABELS}
        />
        <SelectField
          label="دامنه"
          value={scope}
          onChange={(next) => setScope(next || "business")}
          options={["business", "project"] as const}
          labels={{ business: "استاندارد دفتر (همهٔ پروژه‌ها)", project: "فقط این پروژه" }}
          hint="استاندارد دفتر در پروژه‌های بعدی هم در دسترس است."
        />
        <SelectField
          label="رشته"
          value={(discipline || "") as AecSpecialty | ""}
          onChange={(next) => setDiscipline(next)}
          options={AEC_SPECIALTIES}
          labels={AEC_SPECIALTY_LABELS}
          includeAll
          allLabel="— عمومی —"
        />
        <div className="sm:col-span-2">
          <Field label="توضیح">
            <input
              className={inputClass}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
          />
          فعال — در فهرست انتخاب دیده شود
        </label>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">بندها</h4>
          <SecondaryButton
            onClick={() => setItems((current) => [...current, { title: "", guidance: "" }])}
          >
            <PlusIcon className="size-4" aria-hidden />
            افزودن بند
          </SecondaryButton>
        </div>
        <ul className="flex flex-col gap-2">
          {items.map((item, index) => (
            <li key={index} className="flex items-end gap-2">
              <div className="w-10 pb-2 text-xs text-muted-foreground">
                {toFa(index + 1)}
              </div>
              <div className="min-w-0 flex-1">
                <Field label="بند">
                  <input
                    className={inputClass}
                    value={item.title}
                    onChange={(event) => patchItem(index, { title: event.target.value })}
                  />
                </Field>
              </div>
              <div className="min-w-0 flex-1">
                <Field label="راهنما">
                  <input
                    className={inputClass}
                    value={item.guidance}
                    onChange={(event) => patchItem(index, { guidance: event.target.value })}
                  />
                </Field>
              </div>
              <button
                type="button"
                className="mb-1 rounded-lg p-1.5 text-destructive hover:bg-destructive/10"
                onClick={() => setItems((current) => current.filter((_, i) => i !== index))}
                aria-label="حذف بند"
              >
                <Trash2Icon className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex items-center justify-end gap-2">
        <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
        <PrimaryButton disabled={busy || !name.trim()} onClick={() => void save()}>
          {checklist ? "ذخیرهٔ تغییرات" : "ساخت چک‌لیست"}
        </PrimaryButton>
      </div>
    </div>
  );
}

function toFa(value: number): string {
  return new Intl.NumberFormat("fa-IR").format(value);
}
