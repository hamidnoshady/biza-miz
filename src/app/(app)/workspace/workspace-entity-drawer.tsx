"use client";

/**
 * The Workspace entity drawer (#761 §18) — one pattern for a quick look at a
 * project, task, document or contract without leaving the page you are on.
 *
 * Built on the platform `Sheet` (Radix Dialog), so focus trap, `role=dialog`,
 * `aria-modal`, Esc-to-close and focus return are the primitive's, not
 * re-implemented here. It opens on the trailing edge like the assistant's
 * management sheet, and is full-screen on a phone.
 *
 * It reads the same `GET /api/workspace/<kind>/<id>` the full pages read, so
 * it shows exactly what the member may see — a 404 for a project they are not
 * on reads «در دسترس نیست», never a partial record.
 */

import { useEffect, useState, type RefObject } from "react";
import Link from "next/link";
import { ArrowUpLeftIcon } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { api, ErrorBox } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { workspaceProjectHref, workspaceSectionHref } from "@/lib/app-routes";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import {
  CONTRACT_STATUS_LABELS,
  DOCUMENT_STATUS_LABELS,
  PRIORITY_LABELS,
  PROJECT_STATUS_LABELS,
  TASK_STATUS_LABELS,
  type WorkspaceContractStatus,
  type WorkspaceDocumentStatus,
  type WorkspacePriority,
  type WorkspaceProjectStatus,
  type WorkspaceTaskStatus,
} from "@/lib/workspace-shared";
import { workspaceError } from "./workspace-ui";
import { WorkspaceComments, type WorkspaceComment } from "./workspace-comments";
import { TaskDrawerBody } from "./task-drawer";
import { EMPTY_LOOKUPS, useWorkspaceLookups, type WorkspaceLookups } from "./use-workspace-lookups";

export type WorkspaceEntityKind = "project" | "task" | "document" | "contract";
export interface WorkspaceEntityRef {
  kind: WorkspaceEntityKind;
  id: string;
}

const KIND_LABELS: Record<WorkspaceEntityKind, string> = {
  project: "پروژه",
  task: "وظیفه",
  document: "سند",
  contract: "قرارداد",
};

const ENDPOINT: Record<WorkspaceEntityKind, string> = {
  project: "projects",
  task: "tasks",
  document: "documents",
  contract: "contracts",
};

/** Where "open the full record" goes for each kind. */
export function workspaceEntityHref(ref: WorkspaceEntityRef): string {
  if (ref.kind === "project") return workspaceProjectHref(ref.id);
  const section = ref.kind === "task" ? "tasks" : ref.kind === "document" ? "documents" : "contracts";
  // `?open=` — the section opens this record, not just its list.
  return `${workspaceSectionHref(section)}?open=${encodeURIComponent(ref.id)}`;
}

type Comment = WorkspaceComment;

type Record_ = Record<string, unknown>;

interface Loaded {
  record: Record_;
  comments: Comment[];
}

function pick(body: Record_, kind: WorkspaceEntityKind): Record_ | null {
  const key = kind === "project" ? "project" : kind;
  return (body[key] as Record_ | undefined) ?? null;
}

export function WorkspaceEntityDrawer({
  entity,
  onClose,
  returnFocusTo,
  lookups = EMPTY_LOOKUPS,
  onChanged,
}: {
  entity: WorkspaceEntityRef | null;
  onClose: () => void;
  /** The pickers an editable task needs (assignee). */
  lookups?: WorkspaceLookups;
  /** A write landed in the drawer — the list behind it refreshes. */
  onChanged?: () => void;
  /**
   * Where focus goes on close when the drawer was not opened by a trigger
   * Radix knows about (e.g. from the palette, which has already closed) —
   * otherwise focus would fall to <body>.
   */
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  return (
    <Sheet open={entity !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <SheetContent
        side="left"
        aria-label={entity ? `جزئیات ${KIND_LABELS[entity.kind]}` : "جزئیات"}
        className="w-full max-w-none gap-0 overflow-y-auto p-0 sm:w-[32rem] sm:max-w-[32rem]"
        onCloseAutoFocus={(event) => {
          if (returnFocusTo?.current) {
            event.preventDefault();
            returnFocusTo.current.focus();
          }
        }}
      >
        {entity?.kind === "task" ? (
          <TaskDrawer key={entity.id} taskId={entity.id} lookups={lookups} onChanged={onChanged} />
        ) : entity ? (
          <DrawerBody key={`${entity.kind}:${entity.id}`} entity={entity} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function DrawerBody({ entity }: { entity: WorkspaceEntityRef }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const abort = new AbortController();
    api<Record_>(`/api/workspace/${ENDPOINT[entity.kind]}/${entity.id}`, { signal: abort.signal }).then(
      ({ ok, data, aborted }) => {
        if (aborted) return;
        const record = ok ? pick(data, entity.kind) : null;
        if (!record) {
          setError(workspaceError(typeof data.error === "string" ? data.error : "subject_not_found"));
          return;
        }
        setLoaded({ record, comments: (data.comments as Comment[] | undefined) ?? [] });
      },
    );
    return () => abort.abort();
  }, [entity.kind, entity.id]);

  const title = String(loaded?.record.name ?? loaded?.record.title ?? KIND_LABELS[entity.kind]);

  return (
    <>
      <SheetHeader className="shrink-0 border-b border-border/80 px-4 py-3 pe-12">
        <SheetDescription>{KIND_LABELS[entity.kind]}</SheetDescription>
        <SheetTitle className="truncate">{title}</SheetTitle>
      </SheetHeader>
      <div className="flex flex-col gap-4 p-4">
        {error ? (
          <ErrorBox>{error}</ErrorBox>
        ) : !loaded ? (
          <WorkspaceEntityDrawerSkeleton />
        ) : (
          <>
            <Facts kind={entity.kind} record={loaded.record} />
            <Link
              href={workspaceEntityHref(entity)}
              className="inline-flex items-center gap-1 self-start text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              <ArrowUpLeftIcon className="size-4" aria-hidden />
              باز کردن صفحهٔ کامل
            </Link>
            {entity.kind !== "project" ? (
              <WorkspaceComments
                subjectType={entity.kind}
                subjectId={entity.id}
                initial={loaded.comments}
              />
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

/** A task edits in place (#761 §9) — its own body, same frame. */
function TaskDrawer({
  taskId,
  lookups,
  onChanged,
}: {
  taskId: string;
  lookups: WorkspaceLookups;
  onChanged?: () => void;
}) {
  const [title, setTitle] = useState("وظیفه");
  const [comments, setComments] = useState<Comment[] | null>(null);
  // Opened from the command palette there are no lookups to hand down; an
  // editable assignee with an empty member list would silently clear it.
  const fetched = useWorkspaceLookups(lookups === EMPTY_LOOKUPS);
  const people = lookups === EMPTY_LOOKUPS ? fetched : lookups;
  useEffect(() => {
    api<{ comments?: Comment[] }>(`/api/workspace/tasks/${taskId}`).then(({ ok, data }) => {
      if (ok) setComments(data.comments ?? []);
    });
  }, [taskId]);
  return (
    <>
      <SheetHeader className="shrink-0 border-b border-border/80 px-4 py-3 pe-12">
        <SheetDescription>{KIND_LABELS.task}</SheetDescription>
        <SheetTitle className="truncate">{title}</SheetTitle>
      </SheetHeader>
      <div className="flex flex-col gap-4 p-4">
        <TaskDrawerBody taskId={taskId} lookups={people} onChanged={onChanged} onTitle={setTitle} />
        <Link
          href={workspaceEntityHref({ kind: "task", id: taskId })}
          className="inline-flex items-center gap-1 self-start text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          <ArrowUpLeftIcon className="size-4" aria-hidden />
          باز کردن فهرست وظایف
        </Link>
        {comments ? (
          <WorkspaceComments subjectType="task" subjectId={taskId} initial={comments} />
        ) : null}
      </div>
    </>
  );
}

export function WorkspaceEntityDrawerSkeleton() {
  return <LoadingSkeleton rows={4} label="در حال بارگذاری جزئیات" />;
}

function Facts({ kind, record }: { kind: WorkspaceEntityKind; record: Record_ }) {
  const money = useMoney();
  const date = (value: unknown) => (typeof value === "string" && value ? formatJalali(value) : "—");
  const text = (value: unknown) => (typeof value === "string" && value ? value : "—");
  const rows: Array<[string, string]> = [];

  if (kind === "project") {
    rows.push(
      ["وضعیت", PROJECT_STATUS_LABELS[record.status as WorkspaceProjectStatus] ?? "—"],
      ["اولویت", PRIORITY_LABELS[record.priority as WorkspacePriority] ?? "—"],
      ["مشتری", text(record.partyName)],
      ["مالک", text(record.ownerName)],
      ["شروع", date(record.startDate)],
      ["پایان", date(record.endDate)],
    );
    if (typeof record.budgetRial === "number") rows.push(["بودجه", money.format(record.budgetRial)]);
  } else if (kind === "task") {
    rows.push(
      ["وضعیت", TASK_STATUS_LABELS[record.status as WorkspaceTaskStatus] ?? "—"],
      ["اولویت", PRIORITY_LABELS[record.priority as WorkspacePriority] ?? "—"],
      ["پروژه", text(record.projectName)],
      ["فاز", text(record.phaseName)],
      ["مسئول", text(record.assigneeName)],
      ["مهلت", date(record.dueDate)],
    );
  } else if (kind === "document") {
    rows.push(
      ["وضعیت", DOCUMENT_STATUS_LABELS[record.status as WorkspaceDocumentStatus] ?? "—"],
      ["نسخه", record.version == null ? "—" : toPersianDigits(String(record.version))],
      ["پروژه", text(record.projectName)],
      ["فایل", text(record.fileName)],
    );
  } else {
    rows.push(
      ["وضعیت", CONTRACT_STATUS_LABELS[record.status as WorkspaceContractStatus] ?? "—"],
      ["طرف قرارداد", text(record.partyName)],
      ["پروژه", text(record.projectName)],
      ["شروع", date(record.startDate)],
      ["پایان", date(record.endDate)],
    );
    if (typeof record.valueRial === "number") rows.push(["مبلغ", money.format(record.valueRial)]);
  }

  const description = text(record.description ?? record.notes);
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 truncate">{value}</dd>
          </div>
        ))}
      </dl>
      {description !== "—" ? (
        <p className="whitespace-pre-line text-sm text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}
