"use client";

/**
 * «پروژه‌ها» — the project register.
 *
 * Every project the old `/projects` page listed is here, with the same names,
 * the same ids and the same links; what is added is the business dimension the
 * assistant-era page had no column for: the customer, the team, the dates, the
 * completion bar and the priority.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BriefcaseIcon, PlusIcon, XIcon } from "lucide-react";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  LoadingSkeleton,
  SectionCard,
  overlayPanelClass,
} from "@/app/dashboard/page-chrome";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import { FilterChip, FilterChipRow, SearchField } from "@/app/dashboard/filters";
import {
  api,
  ErrorBox,
  Field,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { workspaceProjectHref } from "@/lib/app-routes";
import {
  PRIORITIES,
  PRIORITY_LABELS,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  completionPercent,
  type WorkspacePriority,
  type WorkspaceProjectStatus,
} from "@/lib/workspace-shared";
import {
  DateCell,
  DateField,
  LoadMoreFooter,
  PickerField,
  PriorityBadge,
  ProgressBar,
  ProjectStatusBadge,
  SelectField,
  TagList,
  workspaceError,
} from "./workspace-ui";
import { usePagedList } from "./use-paged-list";

interface ProjectSummary {
  total: number;
  active: number;
  budgetRial: number;
  tasks: number;
}
import type { WorkspaceLookups } from "./use-workspace-lookups";

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  status: WorkspaceProjectStatus;
  priority: WorkspacePriority;
  projectType: string | null;
  startDate: string | null;
  endDate: string | null;
  tags: string[];
  partyId: string | null;
  partyName: string | null;
  ownerName: string | null;
  budgetRial: number | null;
  archivedAt: string | null;
  taskCount: number;
  doneTaskCount: number;
  memberCount: number;
  contractCount: number;
  documentCount: number;
}

interface TemplateOption {
  key: string;
  name: string;
  description: string;
}

export function ProjectsSection({
  lookups,
  initialCreating = false,
  createProjectId,
  canManage,
}: {
  lookups: WorkspaceLookups;
  /** From `?create=1` — the command bar's «+ ایجاد» opens the create dialog. */
  initialCreating?: boolean;
  /** From `?project=` — the create dialog preselects that project. */
  createProjectId?: string;
  canManage: boolean;
}) {
  const money = useMoney();
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<WorkspaceProjectStatus | "">("");
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(initialCreating);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (mine) params.set("mine", "true");
    if (search.trim()) params.set("q", search.trim());
    const qs = params.toString();
    return `/api/workspace/projects${qs ? `?${qs}` : ""}`;
  }, [status, mine, search]);
  const list = usePagedList<ProjectRow, ProjectSummary>(query, "projects");
  const projects = list.rows;
  const load = list.reload;
  useEffect(() => {
    if (list.error) setError(list.error);
  }, [list.error]);

  useEffect(() => {
    api<{ templates: TemplateOption[] }>("/api/workspace/templates").then(({ ok, data }) => {
      if (ok) setTemplates(data.templates);
    });
  }, []);

  // Server totals over the whole filtered set — not a sum of the loaded page.
  const totals = {
    count: list.summary?.total ?? 0,
    active: list.summary?.active ?? 0,
    budget: list.summary?.budgetRial ?? 0,
    tasks: list.summary?.tasks ?? 0,
  };

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <KpiRow>
        <KpiCard label="پروژه‌ها" value={toPersianDigits(String(totals.count))} icon={BriefcaseIcon} />
        <KpiCard label="فعال" value={toPersianDigits(String(totals.active))} />
        <KpiCard label="مجموع بودجه" value={money.format(totals.budget)} />
        <KpiCard label="وظایف" value={toPersianDigits(String(totals.tasks))} />
      </KpiRow>

      <SectionCard
        title="فهرست پروژه‌ها"
        description="پروژه‌ها با مشتری، تیم، فاز و زمان‌بندی"
        actions={
          canManage ? (
            <PrimaryButton type="button" onClick={() => setCreating(true)}>
              <PlusIcon className="size-4" aria-hidden />
              پروژهٔ جدید
            </PrimaryButton>
          ) : null
        }
        flush
      >
        <div className="flex flex-col gap-3 border-b border-border/80 p-4">
          <SearchField
            label="جست‌وجوی پروژه"
            value={search}
            onChange={setSearch}
            placeholder="نام پروژه…"
            onClear={() => setSearch("")}
          />
          <FilterChipRow label="فیلتر وضعیت پروژه">
            <FilterChip selected={status === ""} onClick={() => setStatus("")}>
              همه
            </FilterChip>
            {PROJECT_STATUSES.map((value) => (
              <FilterChip key={value} selected={status === value} onClick={() => setStatus(value)}>
                {PROJECT_STATUS_LABELS[value]}
              </FilterChip>
            ))}
            <FilterChip selected={mine} onClick={() => setMine((prev) => !prev)}>
              فقط پروژه‌های من
            </FilterChip>
          </FilterChipRow>
        </div>

        {projects === null ? (
          <LoadingSkeleton rows={5} label="در حال بارگذاری پروژه‌ها" />
        ) : projects.length === 0 ? (
          <EmptyState
            icon={BriefcaseIcon}
            title="پروژه‌ای یافت نشد"
            action={
              canManage ? (
                <PrimaryButton type="button" onClick={() => setCreating(true)}>ساخت پروژه</PrimaryButton>
              ) : undefined
            }
          >
            نخستین پروژه را بسازید تا وظایف، قراردادها و اسناد جایی برای زندگی داشته باشند.
          </EmptyState>
        ) : (
          <DataTable caption="فهرست پروژه‌های میز کار" frame={false}>
            <DataTableHead>
              <Th>نام</Th>
              <Th>مشتری</Th>
              <Th>وضعیت</Th>
              <Th>اولویت</Th>
              <Th>پیشرفت</Th>
              <Th>پایان</Th>
              <Th>بودجه</Th>
            </DataTableHead>
            <DataTableBody>
              {projects.map((project) => (
                <DataTableRow key={project.id}>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <Link
                        href={workspaceProjectHref(project.id)}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {project.name}
                      </Link>
                      <TagList tags={project.tags} />
                    </div>
                  </Td>
                  <Td>{project.partyName ?? <span className="text-muted-foreground">—</span>}</Td>
                  <Td>
                    <ProjectStatusBadge status={project.status} />
                  </Td>
                  <Td>
                    <PriorityBadge priority={project.priority} />
                  </Td>
                  <Td>
                    <ProgressBar
                      percent={completionPercent(project.doneTaskCount, project.taskCount)}
                      label={`پیشرفت ${project.name}`}
                    />
                  </Td>
                  <Td>
                    <DateCell date={project.endDate} />
                  </Td>
                  <Td className="tabular-nums">
                    {project.budgetRial === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      money.format(project.budgetRial)
                    )}
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
        <LoadMoreFooter
          loaded={projects?.length ?? 0}
          page={list.page}
          loading={list.loadingMore}
          onLoadMore={list.loadMore}
        />
      </SectionCard>

      {creating ? (
        <NewProjectDialog
          lookups={lookups}
          templates={templates}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function NewProjectDialog({
  lookups,
  templates,
  onClose,
  onCreated,
  onError,
}: {
  lookups: WorkspaceLookups;
  templates: TemplateOption[];
  onClose: () => void;
  onCreated: () => void;
  onError: (message: string) => void;
}) {
  const money = useMoney();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<WorkspaceProjectStatus | "">("planning");
  const [priority, setPriority] = useState<WorkspacePriority | "">("normal");
  const [templateKey, setTemplateKey] = useState("");
  const [partyId, setPartyId] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [budget, setBudget] = useState("");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!name.trim() || saving) return;
    setSaving(true);
    const { ok, data } = await api<{ project: { id: string } }>("/api/workspace/projects", {
      method: "POST",
      body: JSON.stringify({
        name,
        description,
        status: status || "planning",
        priority: priority || "normal",
        templateKey: templateKey || null,
        partyId: partyId || null,
        ownerUserId: ownerUserId || null,
        startDate: startDate || null,
        endDate: endDate || null,
        budgetRial: budget.trim() ? money.parse(budget) : null,
        tags: tags.split("،").map((t) => t.trim()).filter(Boolean),
      }),
    });
    setSaving(false);
    if (ok) onCreated();
    else onError(workspaceError((data as unknown as { error?: string }).error));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-2xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">پروژهٔ جدید</h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="نام پروژه">
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </Field>
          <PickerField
            label="قالب فازبندی"
            value={templateKey}
            onChange={setTemplateKey}
            options={templates.map((t) => ({ id: t.key, label: t.name }))}
            placeholder="— بدون قالب —"
            hint="فازهای قالب پس از ساخت به پروژه افزوده می‌شوند."
          />
          <div className="sm:col-span-2">
            <Field label="توضیح">
              <textarea
                className={`${inputClass} min-h-20`}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
          </div>
          <SelectField
            label="وضعیت"
            value={status}
            onChange={setStatus}
            options={PROJECT_STATUSES}
            labels={PROJECT_STATUS_LABELS}
          />
          <SelectField
            label="اولویت"
            value={priority}
            onChange={setPriority}
            options={PRIORITIES}
            labels={PRIORITY_LABELS}
          />
          <PickerField
            label="مشتری / طرف حساب"
            value={partyId}
            onChange={setPartyId}
            options={lookups.parties.map((p) => ({ id: p.id, label: p.name }))}
          />
          <PickerField
            label="مسئول پروژه"
            value={ownerUserId}
            onChange={setOwnerUserId}
            options={lookups.members.map((m) => ({ id: m.id, label: m.fullName }))}
          />
          <DateField label="تاریخ شروع" value={startDate} onChange={setStartDate} />
          <DateField label="تاریخ پایان" value={endDate} onChange={setEndDate} />
          <Field label={`بودجه (${money.unitLabel})`}>
            <input
              className={inputClass}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              inputMode="numeric"
            />
          </Field>
          <Field label="برچسب‌ها" hint="با «،» جدا کنید">
            <input className={inputClass} value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-border/80 p-4">
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton type="button" onClick={submit} disabled={!name.trim() || saving}>
            {saving ? "در حال ذخیره" : "ساخت پروژه"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
