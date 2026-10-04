"use client";

/**
 * «وظایف» — one task set, three views.
 *
 * List, Kanban and Calendar are the same `/api/workspace/tasks` response
 * grouped three ways on the client, not three endpoints: the counts in the
 * board columns and the rows in the list can therefore never disagree, and
 * switching view costs no round trip.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckSquareIcon,
  KanbanIcon,
  ListIcon,
  CalendarDaysIcon,
  GanttChartIcon,
  PlusIcon,
  UserCheckIcon,
  XIcon,
} from "lucide-react";
import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
  TabBar,
  TabPanel,
  cardClass,
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
import { cn } from "@/lib/utils";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali, todayIsoDate } from "@/lib/jalali";
import {
  PRIORITIES,
  PRIORITY_LABELS,
  TASK_BOARD_COLUMNS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  addDays,
  compareTasksForList,
  deadlineTone,
  weekStartSaturday,
  type DeadlineTone,
  type WorkspacePriority,
  type WorkspaceTaskStatus,
} from "@/lib/workspace-shared";
import {
  DateCell,
  DateField,
  PickerField,
  PriorityBadge,
  SelectField,
  TaskStatusBadge,
  workspaceError,
  LoadMoreFooter,
} from "./workspace-ui";
import { usePagedList } from "./use-paged-list";
import type { WorkspaceIntent } from "./workspace-routes";
import { WorkspaceEntityDrawer } from "./workspace-entity-drawer";

const WORK_GROUP_LABELS: Record<DeadlineTone, string> = {
  overdue: "عقب‌افتاده",
  today: "امروز",
  soon: "این هفته",
  later: "بعداً",
  none: "بدون مهلت",
};

/** Per-status counts over the whole filtered set (keys match the board columns). */
type TaskSummary = { total: number; overdue: number } & Record<WorkspaceTaskStatus, number>;
import type { WorkspaceLookups } from "./use-workspace-lookups";

export interface TaskRow {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  description: string;
  status: WorkspaceTaskStatus;
  priority: WorkspacePriority;
  assigneeUserId: string | null;
  assigneeName: string | null;
  dueDate: string | null;
  partyName: string | null;
  phaseName: string | null;
  checklistTotal: number;
  checklistDone: number;
  commentCount: number;
  blockedBy: number;
}

type View = "work" | "list" | "board" | "timeline" | "calendar";

const VIEW_TABS = [
  { key: "work" as const, label: "کار من", icon: UserCheckIcon },
  { key: "list" as const, label: "فهرست", icon: ListIcon },
  { key: "board" as const, label: "کانبان", icon: KanbanIcon },
  { key: "timeline" as const, label: "خط زمانی", icon: GanttChartIcon },
  { key: "calendar" as const, label: "تقویم", icon: CalendarDaysIcon },
];

export function TasksSection({
  lookups,
  intent,
  canManage,
  canContribute = canManage,
  initialMine = false,
  projectId,
}: {
  lookups: WorkspaceLookups;
  /** A consumed URL intent — see `WorkspaceIntent`. */
  intent?: WorkspaceIntent;
  canManage: boolean;
  /**
   * May work tasks (status, checklist) without re-scoping them — a
   * contributor. The server still limits that to tasks assigned to them.
   */
  canContribute?: boolean;
  initialMine?: boolean;
  projectId?: string;
}) {
  const [error, setError] = useState("");
  const [view, setView] = useState<View>(projectId ? "list" : "work");
  const [mine, setMine] = useState(initialMine);
  const [openOnly, setOpenOnly] = useState(true);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [drawer, setDrawer] = useState<string | null>(null);
  useEffect(() => {
    if (intent?.create) setCreating(true);
    // `?open=<id>` — the drawer's «باز کردن فهرست وظایف» lands on this record.
    if (intent?.openId) setDrawer(intent.openId);
  }, [intent]);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (mine || view === "work") params.set("mine", "true");
    if (openOnly || view === "work") params.set("status", "open_only");
    if (search.trim()) params.set("q", search.trim());
    const qs = params.toString();
    return `/api/workspace/tasks${qs ? `?${qs}` : ""}`;
  }, [projectId, mine, openOnly, search, view]);
  const list = usePagedList<TaskRow, TaskSummary>(query, "tasks");
  const tasks = list.rows;
  const load = list.reload;
  useEffect(() => {
    if (list.error) setError(list.error);
  }, [list.error]);

  async function move(task: TaskRow, status: WorkspaceTaskStatus) {
    const { ok, data } = await api(`/api/workspace/tasks/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    if (ok) load();
    else setError(workspaceError((data as unknown as { error?: string }).error));
  }

  const sorted = useMemo(
    () => (tasks ?? []).slice().sort(compareTasksForList),
    [tasks],
  );

  const byColumn = useMemo(() => {
    const map = new Map<WorkspaceTaskStatus, TaskRow[]>();
    for (const column of TASK_BOARD_COLUMNS) map.set(column, []);
    for (const task of sorted) map.get(task.status)?.push(task);
    return map;
  }, [sorted]);

  // «کار من»: what needs me, by urgency — the same buckets as the dashboard.
  const today = useMemo(() => todayIsoDate(), []);
  const byUrgency = useMemo(() => {
    const groups: Record<DeadlineTone, TaskRow[]> = { overdue: [], today: [], soon: [], later: [], none: [] };
    for (const task of sorted) groups[deadlineTone(task.dueDate, today)].push(task);
    return groups;
  }, [sorted, today]);

  // «خط زمانی»: Saturday-first week lanes, earliest first.
  const byWeek = useMemo(() => {
    const map = new Map<string, TaskRow[]>();
    for (const task of sorted) {
      if (!task.dueDate) continue;
      const week = weekStartSaturday(task.dueDate);
      const lane = map.get(week);
      if (lane) lane.push(task);
      else map.set(week, [task]);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [sorted]);

  const canMove = canManage || canContribute;
  const [dragging, setDragging] = useState<string | null>(null);

  const byDate = useMemo(() => {
    const map = new Map<string, TaskRow[]>();
    for (const task of sorted) {
      if (!task.dueDate) continue;
      const list = map.get(task.dueDate);
      if (list) list.push(task);
      else map.set(task.dueDate, [task]);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [sorted]);

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <SectionCard
        title="وظایف"
        description="یک مجموعه، چند نما: کار من، فهرست، کانبان، خط زمانی و تقویم"
        actions={
          canManage ? (
            <PrimaryButton type="button" onClick={() => setCreating(true)}>
              <PlusIcon className="size-4" aria-hidden />
              وظیفهٔ جدید
            </PrimaryButton>
          ) : null
        }
        flush
      >
        <div className="flex flex-col gap-3 border-b border-border/80 p-4">
          <TabBar
            idPrefix="workspace-tasks"
            label="نمای وظایف"
            tabs={VIEW_TABS}
            active={view}
            onChange={setView}
          />
          <SearchField
            label="جست‌وجوی وظیفه"
            value={search}
            onChange={setSearch}
            placeholder="عنوان وظیفه…"
            onClear={() => setSearch("")}
          />
          {/* «کار من» already means "mine, open" — its chips would show a
              filter that is not the one applied, so they only appear in the
              other views. */}
          {view !== "work" ? (
            <FilterChipRow label="فیلتر وظایف">
              <FilterChip selected={mine} onClick={() => setMine((prev) => !prev)}>
                واگذارشده به من
              </FilterChip>
              <FilterChip selected={openOnly} onClick={() => setOpenOnly((prev) => !prev)}>
                فقط باز
              </FilterChip>
            </FilterChipRow>
          ) : null}
        </div>

        {tasks === null ? (
          <LoadingSkeleton rows={5} label="در حال بارگذاری وظایف" />
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={CheckSquareIcon}
            title="وظیفه‌ای یافت نشد"
          >
            وظایف هر پروژه اینجا و در صفحهٔ همان پروژه دیده می‌شوند.
          </EmptyState>
        ) : (
          <TabPanel idPrefix="workspace-tasks" active={view}>
            {view === "work" ? (
              <div className="flex flex-col gap-4 p-4">
                {(["overdue", "today", "soon", "later", "none"] as const).map((tone) =>
                  byUrgency[tone].length ? (
                    <section key={tone} aria-label={WORK_GROUP_LABELS[tone]} className="flex flex-col gap-2">
                      <h3 className="text-sm font-semibold">
                        {WORK_GROUP_LABELS[tone]}{" "}
                        <span className="text-xs font-normal text-muted-foreground tabular-nums">
                          {toPersianDigits(String(byUrgency[tone].length))}
                        </span>
                      </h3>
                      <ul className={cn(cardClass, "divide-y divide-border/80 overflow-hidden")}>
                        {byUrgency[tone].map((task) => (
                          <li key={task.id}>
                            <button
                              type="button"
                              onClick={() => setDrawer(task.id)}
                              className="flex min-h-11 w-full flex-wrap items-center gap-2 px-4 py-2 text-start text-sm hover:bg-muted/40"
                            >
                              <span className="min-w-0 flex-1 truncate font-medium">{task.title}</span>
                              <span className="truncate text-xs text-muted-foreground">{task.projectName}</span>
                              <PriorityBadge priority={task.priority} />
                              <DateCell date={task.dueDate} className="text-xs" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null,
                )}
              </div>
            ) : view === "timeline" ? (
              byWeek.length === 0 ? (
                <EmptyState icon={GanttChartIcon} title="وظیفهٔ مهلت‌داری نیست">
                  برای دیدن خط زمانی، به وظایف تاریخ مهلت بدهید.
                </EmptyState>
              ) : (
                // Wide by nature, so it scrolls in its own box — never the page.
                <div className="overflow-x-auto p-4">
                  <ol className="flex min-w-max gap-3">
                    {byWeek.map(([week, items]) => (
                      <li key={week} className="flex w-56 shrink-0 flex-col gap-2">
                        <h3 className="text-xs font-semibold text-muted-foreground">
                          هفتهٔ {formatJalali(week)}
                          {week <= today && today < addDays(week, 7) ? " · این هفته" : ""}
                        </h3>
                        {items.map((task) => (
                          <button
                            key={task.id}
                            type="button"
                            onClick={() => setDrawer(task.id)}
                            className={cn(cardClass, "flex min-h-11 flex-col gap-1 p-2 text-start text-sm")}
                          >
                            <span className="truncate font-medium">{task.title}</span>
                            <span className="flex items-center gap-1.5">
                              <TaskStatusBadge status={task.status} />
                              <DateCell date={task.dueDate} relative={false} className="text-xs" />
                            </span>
                          </button>
                        ))}
                      </li>
                    ))}
                  </ol>
                </div>
              )
            ) : view === "list" ? (
              <DataTable caption="فهرست وظایف میز کار" frame={false}>
                <DataTableHead>
                  <Th>عنوان</Th>
                  <Th>پروژه</Th>
                  <Th>مسئول</Th>
                  <Th>وضعیت</Th>
                  <Th>اولویت</Th>
                  <Th>مهلت</Th>
                  <Th>چک‌لیست</Th>
                </DataTableHead>
                <DataTableBody>
                  {sorted.map((task) => (
                    <DataTableRow key={task.id} onClick={() => setDrawer(task.id)}>
                      <Td>
                        <div className="flex flex-col">
                          <span className="font-medium">{task.title}</span>
                          {task.blockedBy > 0 ? (
                            <span className="text-xs text-rose-700 dark:text-rose-300">
                              منتظر {toPersianDigits(String(task.blockedBy))} وظیفهٔ دیگر
                            </span>
                          ) : null}
                        </div>
                      </Td>
                      <Td>{task.projectName}</Td>
                      <Td>{task.assigneeName ?? <span className="text-muted-foreground">—</span>}</Td>
                      <Td>
                        <TaskStatusBadge status={task.status} />
                      </Td>
                      <Td>
                        <PriorityBadge priority={task.priority} />
                      </Td>
                      <Td>
                        <DateCell date={task.dueDate} />
                      </Td>
                      <Td className="tabular-nums">
                        {task.checklistTotal === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          `${toPersianDigits(String(task.checklistDone))}/${toPersianDigits(String(task.checklistTotal))}`
                        )}
                      </Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            ) : view === "board" ? (
              <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
                {TASK_BOARD_COLUMNS.map((column) => {
                  const items = byColumn.get(column) ?? [];
                  return (
                    <section key={column} className="flex min-w-0 flex-col gap-2">
                      <header className="flex items-center justify-between px-1">
                        <h3 className="text-sm font-semibold">{TASK_STATUS_LABELS[column]}</h3>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {toPersianDigits(String(list.summary?.[column] ?? items.length))}
                        </span>
                      </header>
                      <div
                        className={cn(
                          "flex min-h-24 flex-col gap-2 rounded-xl bg-muted/40 p-2",
                          dragging && "outline-dashed outline-1 outline-border",
                        )}
                        onDragOver={(event) => {
                          if (canMove && dragging) event.preventDefault();
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          const id = event.dataTransfer.getData("text/plain");
                          const task = sorted.find((t) => t.id === id);
                          setDragging(null);
                          if (task && task.status !== column) void move(task, column);
                        }}
                      >
                        {items.map((task) => (
                          <article
                            key={task.id}
                            className={cn(cardClass, "flex flex-col gap-2 p-3", canMove && "cursor-grab")}
                            draggable={canMove}
                            onDragStart={(event) => {
                              event.dataTransfer.setData("text/plain", task.id);
                              event.dataTransfer.effectAllowed = "move";
                              setDragging(task.id);
                            }}
                            onDragEnd={() => setDragging(null)}
                          >
                            <button
                              type="button"
                              onClick={() => setDrawer(task.id)}
                              className="text-start text-sm font-medium underline-offset-4 hover:underline"
                            >
                              {task.title}
                            </button>
                            <p className="truncate text-xs text-muted-foreground">{task.projectName}</p>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <PriorityBadge priority={task.priority} />
                              <DateCell date={task.dueDate} relative={false} className="text-xs" />
                            </div>
                            {canMove ? (
                              // The keyboard / touch path: drag-and-drop is
                              // never the only way to change a status.
                              <label className="block">
                                <span className="sr-only">ستون «{task.title}»</span>
                                <select
                                  className={inputClass}
                                  value={task.status}
                                  onChange={(event) =>
                                    move(task, event.target.value as WorkspaceTaskStatus)
                                  }
                                >
                                  {TASK_STATUSES.map((status) => (
                                    <option key={status} value={status}>
                                      {TASK_STATUS_LABELS[status]}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            ) : null}
                          </article>
                        ))}
                        {items.length === 0 ? (
                          <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                            خالی
                          </p>
                        ) : null}
                      </div>
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col gap-3 p-4">
                {byDate.length === 0 ? (
                  <EmptyState
                    icon={CalendarDaysIcon}
                    title="وظیفهٔ مهلت‌دار نداریم"
                  >
                    برای دیدن وظایف در تقویم، به آن‌ها تاریخ مهلت بدهید.
                  </EmptyState>
                ) : (
                  byDate.map(([date, items]) => (
                    <section key={date} className={cn(cardClass, "overflow-hidden")}>
                      <header className="flex items-center justify-between border-b border-border/80 bg-muted/60 px-4 py-2">
                        <h3 className="text-sm font-semibold">{formatJalali(date)}</h3>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {toPersianDigits(String(items.length))} وظیفه
                        </span>
                      </header>
                      <ul className="divide-y divide-border/80">
                        {items.map((task) => (
                          <li key={task.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                            <button
                              type="button"
                              onClick={() => setDrawer(task.id)}
                              className="min-w-0 flex-1 truncate text-start font-medium underline-offset-4 hover:underline"
                            >
                              {task.title}
                            </button>
                            <span className="truncate text-xs text-muted-foreground">
                              {task.projectName}
                            </span>
                            <TaskStatusBadge status={task.status} />
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))
                )}
              </div>
            )}
          </TabPanel>
        )}
        <LoadMoreFooter
          loaded={tasks?.length ?? 0}
          page={list.page}
          loading={list.loadingMore}
          onLoadMore={list.loadMore}
        />
      </SectionCard>

      {creating ? (
        <TaskDialog
          lookups={lookups}
          projectId={projectId ?? intent?.projectId}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            load();
          }}
          onError={setError}
        />
      ) : null}

      <WorkspaceEntityDrawer
        entity={drawer ? { kind: "task", id: drawer } : null}
        onClose={() => setDrawer(null)}
        lookups={lookups}
        onChanged={load}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------- */

interface ChecklistItem {
  id: string;
  title: string;
  done: boolean;
}

/**
 * One dialog for creating and editing, because the fields are identical and
 * two dialogs would be two places to add the next one. Editing additionally
 * loads the task's checklist, which only exists once the task does.
 */
function TaskDialog({
  lookups,
  task,
  projectId,
  canManage = true,
  canContribute = canManage,
  onClose,
  onSaved,
  onError,
}: {
  lookups: WorkspaceLookups;
  task?: TaskRow;
  projectId?: string;
  canManage?: boolean;
  canContribute?: boolean;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [project, setProject] = useState(task?.projectId ?? projectId ?? "");
  const [status, setStatus] = useState<WorkspaceTaskStatus | "">(task?.status ?? "open");
  const [priority, setPriority] = useState<WorkspacePriority | "">(task?.priority ?? "normal");
  const [assignee, setAssignee] = useState(task?.assigneeUserId ?? "");
  const [dueDate, setDueDate] = useState(task?.dueDate ?? "");
  const [saving, setSaving] = useState(false);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [newItem, setNewItem] = useState("");

  const taskId = task?.id;

  useEffect(() => {
    if (!taskId) return;
    api<{ checklist: ChecklistItem[] }>(`/api/workspace/tasks/${taskId}/checklist`).then(
      ({ ok, data }) => {
        if (ok) setChecklist(data.checklist);
      },
    );
  }, [taskId]);

  async function submit() {
    if (!title.trim() || saving) return;
    setSaving(true);
    // A contributor only works the task: send the status alone, which is all
    // the server lets them change.
    const payload = !canManage ? { status: status || "open" } : {
      projectId: project,
      title,
      description,
      status: status || "open",
      priority: priority || "normal",
      assigneeUserId: assignee || null,
      dueDate: dueDate || null,
    };
    const { ok, data } = taskId
      ? await api(`/api/workspace/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(payload) })
      : await api("/api/workspace/tasks", { method: "POST", body: JSON.stringify(payload) });
    setSaving(false);
    if (ok) onSaved();
    else onError(workspaceError((data as unknown as { error?: string }).error));
  }

  async function addItem() {
    if (!taskId || !newItem.trim()) return;
    const { ok, data } = await api<{ checklist: ChecklistItem[] }>(
      `/api/workspace/tasks/${taskId}/checklist`,
      { method: "POST", body: JSON.stringify({ title: newItem }) },
    );
    if (ok) {
      setChecklist(data.checklist);
      setNewItem("");
    } else onError(workspaceError((data as unknown as { error?: string }).error));
  }

  async function toggleItem(item: ChecklistItem) {
    if (!taskId) return;
    const { ok, data } = await api<{ checklist: ChecklistItem[] }>(
      `/api/workspace/tasks/${taskId}/checklist`,
      { method: "PATCH", body: JSON.stringify({ itemId: item.id, done: !item.done }) },
    );
    if (ok) setChecklist(data.checklist);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-2xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">{taskId ? "ویرایش وظیفه" : "وظیفهٔ جدید"}</h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="عنوان">
              <input
                className={inputClass}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
              />
            </Field>
          </div>
          <PickerField
            label="پروژه"
            value={project}
            onChange={setProject}
            options={lookups.projects.map((p) => ({ id: p.id, label: p.name }))}
          />
          <PickerField
            label="مسئول"
            value={assignee}
            onChange={setAssignee}
            options={lookups.members.map((m) => ({ id: m.id, label: m.fullName }))}
          />
          <SelectField
            label="وضعیت"
            value={status}
            onChange={setStatus}
            options={TASK_STATUSES}
            labels={TASK_STATUS_LABELS}
          />
          <SelectField
            label="اولویت"
            value={priority}
            onChange={setPriority}
            options={PRIORITIES}
            labels={PRIORITY_LABELS}
          />
          <DateField label="مهلت" value={dueDate} onChange={setDueDate} />
          <div className="sm:col-span-2">
            <Field label="توضیح">
              <textarea
                className={`${inputClass} min-h-20`}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
          </div>

          {taskId ? (
            <div className="sm:col-span-2">
              <h3 className="mb-2 text-sm font-medium">چک‌لیست</h3>
              <ul className="mb-2 flex flex-col gap-1">
                {checklist.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={item.done}
                      onChange={() => toggleItem(item)}
                      id={`check-${item.id}`}
                      className="size-4 rounded border-border accent-amber-600 dark:accent-amber-400"
                    />
                    <label
                      htmlFor={`check-${item.id}`}
                      className={item.done ? "text-muted-foreground line-through" : ""}
                    >
                      {item.title}
                    </label>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <input
                  className={inputClass}
                  value={newItem}
                  onChange={(e) => setNewItem(e.target.value)}
                  placeholder="مورد تازه…"
                  aria-label="مورد تازهٔ چک‌لیست"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addItem();
                    }
                  }}
                />
                <SecondaryButton onClick={addItem} disabled={!newItem.trim()}>
                  افزودن
                </SecondaryButton>
              </div>
            </div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-border/80 p-4">
          <SecondaryButton onClick={onClose}>بستن</SecondaryButton>
          {canManage || (canContribute && taskId) ? (
            <PrimaryButton
              type="button"
              onClick={submit}
              disabled={!title.trim() || !project || saving}
            >
              {saving ? "در حال ذخیره" : "ذخیره"}
            </PrimaryButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}
