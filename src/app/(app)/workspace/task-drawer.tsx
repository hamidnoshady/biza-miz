"use client";

/**
 * The task inside the Workspace entity drawer (#761 §9): edit in place — no
 * separate «ویرایش» modal — with the checklist, what it waits on, its files
 * and its comment thread in one scroll.
 *
 * Every control renders from the `capabilities` the task API returns
 * (`canEdit` re-scopes, `canWork` moves status and ticks the checklist), so a
 * viewer sees a read-only record instead of fields that end in a 403. The
 * server re-checks every write regardless.
 */

import { useCallback, useEffect, useState } from "react";
import { LinkIcon, Trash2Icon } from "lucide-react";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { formatJalali } from "@/lib/jalali";
import { api, ErrorBox, inputClass, SecondaryButton } from "@/app/dashboard/ui";
import {
  PRIORITIES,
  PRIORITY_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type WorkspacePriority,
  type WorkspaceTaskStatus,
} from "@/lib/workspace-shared";
import { DateField, PickerField, SelectField, workspaceError } from "./workspace-ui";
import type { WorkspaceLookups } from "./use-workspace-lookups";

interface Task {
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
  phaseName: string | null;
  blockedBy: number;
}
interface ChecklistItem { id: string; title: string; done: boolean }
interface Dependency { dependsOnId: string; dependsOnTitle: string; dependsOnStatus: WorkspaceTaskStatus }
interface Doc { id: string; title: string; version: number }
interface Capabilities { canEdit: boolean; canWork: boolean; canComment: boolean }

interface Loaded {
  task: Task;
  checklist: ChecklistItem[];
  dependencies: Dependency[];
  documents: Doc[];
  capabilities: Capabilities;
}

export function TaskDrawerBody({
  taskId,
  lookups,
  onChanged,
  onTitle,
}: {
  taskId: string;
  lookups: WorkspaceLookups;
  /** A write landed — lists behind the drawer refresh. */
  onChanged?: () => void;
  onTitle?: (title: string) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [siblings, setSiblings] = useState<Array<{ id: string; title: string }>>([]);

  const load = useCallback(async () => {
    const { ok, data } = await api<Loaded & { error?: string }>(`/api/workspace/tasks/${taskId}`);
    if (!ok) {
      setError(workspaceError(data.error));
      return;
    }
    setLoaded(data);
    onTitle?.(data.task.title);
  }, [taskId, onTitle]);

  useEffect(() => {
    void load();
  }, [load]);

  // Candidates for «منتظر کدام وظیفه است» — only the same project's tasks,
  // which is all the server would accept.
  useEffect(() => {
    if (!loaded?.capabilities.canEdit) return;
    api<{ tasks: Array<{ id: string; title: string }> }>(
      `/api/workspace/tasks?projectId=${loaded.task.projectId}&status=all&limit=200`,
    ).then(({ ok, data }) => {
      if (ok) setSiblings(data.tasks.filter((t) => t.id !== taskId));
    });
  }, [loaded?.capabilities.canEdit, loaded?.task.projectId, taskId]);

  async function patch(body: Record<string, unknown>) {
    const { ok, data } = await api<{ error?: string }>(`/api/workspace/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    if (!ok) {
      setError(workspaceError(data.error));
      return;
    }
    setError("");
    await load();
    onChanged?.();
  }

  async function sub(path: string, init: RequestInit) {
    const { ok, data } = await api<{ error?: string }>(`/api/workspace/tasks/${taskId}/${path}`, init);
    if (!ok) setError(workspaceError(data.error));
    else setError("");
    await load();
    onChanged?.();
  }

  if (!loaded) {
    return error ? <ErrorBox>{error}</ErrorBox> : <TaskDrawerSkeleton />;
  }

  const { task, checklist, dependencies, documents, capabilities } = loaded;
  const openBlockers = dependencies.filter((d) => d.dependsOnStatus !== "done");
  const memberOptions = lookups.members.map((m) => ({ id: m.id, label: m.fullName }));

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      {capabilities.canEdit ? (
        <InlineText
          label="عنوان"
          value={task.title}
          onSave={(title) => patch({ title })}
        />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {capabilities.canWork ? (
          <SelectField<WorkspaceTaskStatus>
            label="وضعیت"
            value={task.status}
            onChange={(status) => status && void patch({ status })}
            options={TASK_STATUSES}
            labels={TASK_STATUS_LABELS}
            hint={
              openBlockers.length
                ? `منتظر ${openBlockers.length.toLocaleString("fa-IR")} وظیفهٔ ناتمام — تا انجام آن‌ها نمی‌توان «انجام‌شده» زد.`
                : undefined
            }
          />
        ) : (
          <ReadOnly label="وضعیت" value={TASK_STATUS_LABELS[task.status]} />
        )}
        {capabilities.canEdit ? (
          <SelectField<WorkspacePriority>
            label="اولویت"
            value={task.priority}
            onChange={(priority) => priority && void patch({ priority })}
            options={PRIORITIES}
            labels={PRIORITY_LABELS}
          />
        ) : (
          <ReadOnly label="اولویت" value={PRIORITY_LABELS[task.priority]} />
        )}
        {capabilities.canEdit ? (
          <PickerField
            label="مسئول"
            value={task.assigneeUserId ?? ""}
            onChange={(assigneeUserId) => void patch({ assigneeUserId: assigneeUserId || null })}
            options={memberOptions}
            placeholder="— بدون مسئول —"
          />
        ) : (
          <ReadOnly
            label="مسئول"
            value={task.assigneeName ?? "—"}
          />
        )}
        {capabilities.canEdit ? (
          <DateField
            label="مهلت"
            value={task.dueDate ?? ""}
            onChange={(dueDate) => void patch({ dueDate: dueDate || null })}
          />
        ) : (
          <ReadOnly label="مهلت" value={task.dueDate ? formatJalali(task.dueDate) : "—"} />
        )}
        <ReadOnly label="پروژه" value={task.projectName} />
        <ReadOnly label="فاز" value={task.phaseName ?? "—"} />
      </div>

      {capabilities.canEdit ? (
        <InlineText
          label="شرح"
          value={task.description}
          multiline
          onSave={(description) => patch({ description })}
        />
      ) : task.description ? (
        <p className="whitespace-pre-line text-sm text-muted-foreground">{task.description}</p>
      ) : null}

      <section aria-label="چک‌لیست" className="flex flex-col gap-2 border-t border-border/80 pt-4">
        <h3 className="text-sm font-semibold">چک‌لیست</h3>
        {checklist.length === 0 ? (
          <p className="text-sm text-muted-foreground">موردی ندارد.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {checklist.map((item) => (
              <li key={item.id} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={item.done}
                  disabled={!capabilities.canWork}
                  aria-label={item.title}
                  onChange={(event) =>
                    void sub("checklist", {
                      method: "PATCH",
                      body: JSON.stringify({ itemId: item.id, done: event.target.checked }),
                    })
                  }
                />
                <span className={item.done ? "line-through text-muted-foreground" : ""}>{item.title}</span>
              </li>
            ))}
          </ul>
        )}
        {capabilities.canWork ? (
          <AddLine
            placeholder="مورد تازه…"
            label="افزودن به چک‌لیست"
            onAdd={(title) =>
              sub("checklist", { method: "POST", body: JSON.stringify({ title }) })
            }
          />
        ) : null}
      </section>

      <section aria-label="منتظر وظایف" className="flex flex-col gap-2 border-t border-border/80 pt-4">
        <h3 className="text-sm font-semibold">منتظر این وظایف</h3>
        {dependencies.length === 0 ? (
          <p className="text-sm text-muted-foreground">به وظیفهٔ دیگری وابسته نیست.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {dependencies.map((dep) => (
              <li key={dep.dependsOnId} className="flex min-h-11 items-center gap-2 text-sm">
                <LinkIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{dep.dependsOnTitle}</span>
                <span className="text-xs text-muted-foreground">{TASK_STATUS_LABELS[dep.dependsOnStatus]}</span>
                {capabilities.canEdit ? (
                  <button
                    type="button"
                    className="rounded-md p-2 text-muted-foreground hover:text-foreground"
                    aria-label={`حذف وابستگی به ${dep.dependsOnTitle}`}
                    onClick={() =>
                      void sub(`dependencies?dependsOnId=${dep.dependsOnId}`, { method: "DELETE" })
                    }
                  >
                    <Trash2Icon className="size-4" aria-hidden />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {capabilities.canEdit && siblings.length ? (
          <PickerField
            label="افزودن وابستگی"
            value=""
            onChange={(dependsOnId) =>
              dependsOnId &&
              void sub("dependencies", { method: "POST", body: JSON.stringify({ dependsOnId }) })
            }
            options={siblings
              .filter((t) => !dependencies.some((d) => d.dependsOnId === t.id))
              .map((t) => ({ id: t.id, label: t.title }))}
            placeholder="— منتظر کدام وظیفه است؟ —"
          />
        ) : null}
      </section>

      <section aria-label="اسناد" className="flex flex-col gap-2 border-t border-border/80 pt-4">
        <h3 className="text-sm font-semibold">اسناد</h3>
        {documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">سندی به این وظیفه وصل نیست.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {documents.map((doc) => (
              <li key={doc.id}>
                {doc.title}{" "}
                <span className="text-xs text-muted-foreground">نسخهٔ {doc.version.toLocaleString("fa-IR")}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function TaskDrawerSkeleton() {
  return <LoadingSkeleton rows={6} label="در حال بارگذاری وظیفه" />;
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** A field that saves on blur (or Enter for one line) — editing in place. */
function InlineText({
  label,
  value,
  multiline,
  onSave,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  onSave: (next: string) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value.trim()) void onSave(draft);
  };
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      {multiline ? (
        <textarea
          className={`${inputClass} min-h-20`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
        />
      ) : (
        <input
          className={inputClass}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          }}
        />
      )}
    </label>
  );
}

function AddLine({
  placeholder,
  label,
  onAdd,
}: {
  placeholder: string;
  label: string;
  onAdd: (text: string) => Promise<void> | void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="flex gap-2">
      <input
        className={inputClass}
        aria-label={label}
        placeholder={placeholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && text.trim()) {
            void onAdd(text.trim());
            setText("");
          }
        }}
      />
      <SecondaryButton
        onClick={() => {
          if (!text.trim()) return;
          void onAdd(text.trim());
          setText("");
        }}
        disabled={!text.trim()}
      >
        افزودن
      </SecondaryButton>
    </div>
  );
}
