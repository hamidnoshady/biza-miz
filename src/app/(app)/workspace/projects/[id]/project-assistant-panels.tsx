"use client";

/**
 * The AI-assistant side of a project — its static instruction, its
 * conversations, its files, its notes, its standing memory and its short
 * assistant to-dos.
 *
 * This is the pre-Phase-G `/projects/[id]` page, moved rather than rewritten:
 * the same components, the same `/api/ai/projects/**` calls, the same limits.
 * «میز کار من» wraps it in a project page that also carries phases, workspace
 * tasks, documents, contracts and the team — so nothing a business already
 * relied on disappeared, it just stopped being the whole of a project.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BrainIcon,
  CheckIcon,
  CircleIcon,
  FileTextIcon,
  ImageIcon,
  ListTodoIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  SaveIcon,
  StickyNoteIcon,
  TrashIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { SectionCard, SectionCardSkeleton, cardClass } from "@/app/dashboard/page-chrome";
import { api, inputClass } from "@/app/dashboard/ui";
import {
  PROJECT_INSTRUCTION_CHAR_LIMIT,
  PROJECT_MEMORY_CHAR_LIMIT,
  PROJECT_MEMORY_MAX_ENTRIES,
  PROJECT_TASK_CHAR_LIMIT,
  PROJECT_TASK_MAX_OPEN,
  instructionWeight,
} from "@/lib/ai-projects-shared";
import { formatPersianNumber } from "@/lib/digits";

interface Project {
  id: string;
  name: string;
  instructions: string;
  createdBy: string;
  archivedAt: string | null;
  createdAt: string;
  status: "active" | "paused" | "completed";
  ownerUserId: string | null;
  ownerName: string | null;
  budgetRial: number | null;
  updatedAt: string;
}
interface Cost { spentRial: number; budgetRial: number | null; remainingBudgetRial: number | null; campaigns: number }
interface OwnerOption { id: string; fullName: string }
interface ProjectFile {
  id: string;
  kind: "image" | "video" | "document";
  fileName: string;
  source: "upload" | "ai_attachment" | "ai_generated";
  createdByAi: boolean;
  createdAt: string;
}

interface Note {
  id: string;
  projectId: string;
  title: string;
  content: string;
  createdBy: string;
  createdAt: string;
}

interface Conversation {
  id: string;
  mode: string;
  title: string;
  lastMessageAt: string;
  createdAt: string;
  projectId: string | null;
}

interface Memory {
  id: string;
  projectId: string;
  content: string;
  source: "user" | "ai";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface Task {
  id: string;
  projectId: string;
  title: string;
  status: "open" | "done";
  source: "user" | "ai";
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
  updatedAt: string;
}

export function ProjectAssistantPanels({ projectId: id }: { projectId: string }) {
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [cost, setCost] = useState<Cost | null>(null);
  const [owners, setOwners] = useState<OwnerOption[]>([]);
  const [editingOperations, setEditingOperations] = useState(false);
  const [statusDraft, setStatusDraft] = useState<Project["status"]>("active");
  const [ownerDraft, setOwnerDraft] = useState("");
  const [budgetDraft, setBudgetDraft] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [memory, setMemory] = useState<Memory[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [showAddMemory, setShowAddMemory] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [showAddTask, setShowAddTask] = useState(false);
  const [taskDraft, setTaskDraft] = useState("");
  const [editingInstructions, setEditingInstructions] = useState(false);
  const [instructionsDraft, setInstructionsDraft] = useState("");
  const [showAddNote, setShowAddNote] = useState(false);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [projRes, notesRes, memoryRes, tasksRes, filesRes, convsRes] = await Promise.all([
      api<{ project: Project; cost: Cost; owners: OwnerOption[] }>(`/api/ai/projects/${id}`),
      api<{ notes: Note[] }>(`/api/ai/projects/${id}/notes`),
      api<{ memory: Memory[] }>(`/api/ai/projects/${id}/memory`),
      api<{ tasks: Task[] }>(`/api/ai/projects/${id}/tasks`),
      api<{ files: ProjectFile[] }>(`/api/ai/projects/${id}/files`),
      api<{ conversations: Conversation[] }>(`/api/ai/conversations?project=${id}&limit=100`),
    ]);
    if (projRes.ok) {
      setProject(projRes.data.project);
      setCost(projRes.data.cost);
      setOwners(projRes.data.owners);
    }
    if (notesRes.ok) setNotes(notesRes.data.notes);
    if (memoryRes.ok) setMemory(memoryRes.data.memory);
    if (tasksRes.ok) setTasks(tasksRes.data.tasks);
    if (filesRes.ok) setFiles(filesRes.data.files);
    // The API already scopes to this project (?project=), so no client filter.
    if (convsRes.ok) setConversations(convsRes.data.conversations);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSaveInstructions() {
    setError("");
    const { ok, data } = await api<{ project: Project }>(
      `/api/ai/projects/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ instructions: instructionsDraft }),
      },
    );
    if (ok) {
      setProject(data.project);
      setEditingInstructions(false);
    } else {
      const err = data as unknown as Record<string, string>;
      setError(err.error ?? "خطا در ذخیره");
    }
  }

  function beginOperationsEdit() {
    if (!project) return;
    setStatusDraft(project.status);
    setOwnerDraft(project.ownerUserId ?? "");
    setBudgetDraft(project.budgetRial === null ? "" : String(project.budgetRial));
    setEditingOperations(true);
  }

  async function handleSaveOperations() {
    if (!project) return;
    setError("");
    const budgetRial = budgetDraft.trim() === "" ? null : Number(budgetDraft);
    const { ok, data } = await api<{ project: Project; error?: string }>(`/api/ai/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: statusDraft,
        ownerUserId: ownerDraft || null,
        budgetRial,
        }),
    });
    if (!ok) { setError(data.error ?? "خطا در ذخیرهٔ تنظیمات پروژه"); return; }
    setProject(data.project);
    setEditingOperations(false);
    await load();
  }

  async function handleAddNote() {
    const title = noteTitle.trim();
    if (!title) return;
    setError("");
    const { ok, data } = await api<{ note: Note }>(
      `/api/ai/projects/${id}/notes`,
      {
        method: "POST",
        body: JSON.stringify({ title, content: noteContent }),
      },
    );
    if (ok) {
      setNotes((prev) => [...prev, data.note]);
      setNoteTitle("");
      setNoteContent("");
      setShowAddNote(false);
    } else {
      const err = data as unknown as Record<string, string>;
      setError(err.error ?? "خطا در افزودن یادداشت");
    }
  }

  async function handleDeleteNote(noteId: string) {
    await api(`/api/ai/projects/${id}/notes/${noteId}`, { method: "DELETE" });
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
  }

  async function handleAddMemory() {
    const content = memoryDraft.trim();
    if (!content) return;
    setError("");
    const { ok, data } = await api<{ memory: Memory }>(
      `/api/ai/projects/${id}/memory`,
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    );
    if (ok) {
      setMemory((prev) => [...prev, data.memory]);
      setMemoryDraft("");
      setShowAddMemory(false);
    } else {
      const err = data as unknown as Record<string, string>;
      setError(err.error ?? "خطا در افزودن حافظه");
    }
  }

  async function handleDeleteMemory(memoryId: string) {
    await api(`/api/ai/projects/${id}/memory/${memoryId}`, { method: "DELETE" });
    setMemory((prev) => prev.filter((m) => m.id !== memoryId));
  }

  async function handleAddTask() {
    const title = taskDraft.trim();
    if (!title) return;
    setError("");
    const { ok, data } = await api<{ task: Task }>(`/api/ai/projects/${id}/tasks`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    if (ok) {
      setTasks((prev) => [data.task, ...prev]);
      setTaskDraft("");
      setShowAddTask(false);
    } else {
      const err = data as unknown as Record<string, string>;
      setError(err.error ?? "خطا در افزودن کار");
    }
  }

  async function handleToggleTask(task: Task) {
    const done = task.status !== "done";
    const { ok, data } = await api<{ task: Task }>(
      `/api/ai/projects/${id}/tasks/${task.id}`,
      { method: "PATCH", body: JSON.stringify({ done }) },
    );
    if (ok) {
      setTasks((prev) => prev.map((t) => (t.id === task.id ? data.task : t)));
    }
  }

  async function handleDeleteTask(taskId: string) {
    await api(`/api/ai/projects/${id}/tasks/${taskId}`, { method: "DELETE" });
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
  }

  if (!project) return <SectionCardSkeleton rows={6} label="در حال بارگذاری پروژه" />;

  const titlesWeight = notes.map((n) => n.title);
  const currentWeight = instructionWeight(project.instructions, titlesWeight);
  const openTaskCount = tasks.filter((t) => t.status === "open").length;
  const remaining = PROJECT_INSTRUCTION_CHAR_LIMIT - currentWeight;

  return (
    <div className="pb-2">
      <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          onClick={() => router.push(`/dashboard?ctx=پروژه: ${project.name}`)}
        >
          <MessageSquareIcon className="size-4" />
          گفت‌وگوی جدید
        </Button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="space-y-4">
          {/* Instructions */}
          <SectionCard
            title="دستور ایستا"
            description="این دستور در متن راهنمای همهٔ گفت‌وگوهای این پروژه می‌نشیند."
            actions={
              !editingInstructions ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setInstructionsDraft(project.instructions);
                    setEditingInstructions(true);
                  }}
                >
                  <PencilIcon className="size-3" />
                  ویرایش
                </Button>
              ) : undefined
            }
          >
            <div className="p-4">
              {editingInstructions ? (
                <div className="space-y-3">
                  <textarea
                    value={instructionsDraft}
                    onChange={(e) => setInstructionsDraft(e.target.value)}
                    rows={6}
                    className={inputClass}
                    placeholder="دستور ایستای پروژه…"
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      {remaining} نویسه باقی‌مانده
                    </span>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleSaveInstructions}>
                        <SaveIcon className="size-3" />
                        ذخیره
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditingInstructions(false)}
                      >
                        انصراف
                      </Button>
                    </div>
                  </div>
                </div>
              ) : project.instructions ? (
                <p className="whitespace-pre-wrap text-sm">{project.instructions}</p>
              ) : (
                <p className="text-sm text-muted-foreground">هنوز دستوری تنظیم نشده.</p>
              )}
            </div>
          </SectionCard>

          {/* Conversations */}
          <SectionCard
            title={`گفت‌وگوها (${conversations.length})`}
            actions={
              <Link href={`/dashboard?project=${id}`}>
                <Button variant="outline" size="sm">
                  <MessageSquareIcon className="size-3" />
                  چت در این پروژه
                </Button>
              </Link>
            }
          >
            <div className="p-4">
              {conversations.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  هنوز گفت‌وگویی در این پروژه نیست.
                </p>
              ) : (
                <ul className="space-y-2">
                  {conversations.map((conv) => (
                    <li key={conv.id}>
                      <Link
                        href={`/dashboard?conversation=${conv.id}`}
                        className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition hover:bg-muted/50"
                      >
                        <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{conv.title}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </SectionCard>

          {/* Files — the media assets tagged to this project (images users sent
              the assistant here, and anything else filed under the project).
              Read-only: files are created through chat/media and tagged there. */}
          <SectionCard title={`فایل‌ها (${formatPersianNumber(files.length)})`}>
            <div className="p-4">
              {files.length === 0 ? (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <ImageIcon className="size-4" />
                  هنوز فایلی در این پروژه نیست. تصویری که در گفت‌وگوهای این پروژه به دستیار می‌فرستید اینجا نگهداری می‌شود.
                </p>
              ) : (
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {files.map((file) => (
                    <li key={file.id} className="overflow-hidden rounded-xl border border-border/80 bg-card">
                      <a href={`/api/media/${file.id}/file`} target="_blank" rel="noreferrer" className="block">
                        {file.kind === "image" ? (
                          <img
                            src={`/api/media/${file.id}/file`}
                            alt={file.fileName}
                            className="h-24 w-full bg-muted/50 object-cover"
                          />
                        ) : (
                          <div className="flex h-24 w-full items-center justify-center bg-muted/50">
                            <FileTextIcon className="size-8 text-muted-foreground" />
                          </div>
                        )}
                        <div className="p-2">
                          <p className="truncate text-xs text-foreground" title={file.fileName}>{file.fileName}</p>
                          {file.createdByAi ? (
                            <span className="mt-1 inline-block rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-600 dark:text-violet-400">
                              ساختهٔ دستیار
                            </span>
                          ) : file.source === "ai_attachment" ? (
                            <span className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              از گفت‌وگو
                            </span>
                          ) : null}
                        </div>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </SectionCard>
        </div>

        {/* Operating ownership, budget and ledger-backed project cost centre. */}
        <aside className="space-y-3">
          <SectionCard
            title="مرکز هزینهٔ پروژه"
            description="خرج از اسناد قطعی هزینهٔ کمپین خوانده می‌شود، نه از برآورد صف ارسال."
            actions={!editingOperations ? <Button variant="outline" size="sm" onClick={beginOperationsEdit}><PencilIcon className="size-3" /> ویرایش</Button> : undefined}
          >
            <div className="space-y-3 p-4 text-sm">
              {editingOperations ? <>
                <label className="grid gap-1 text-xs text-muted-foreground">وضعیت<select className={inputClass} value={statusDraft} onChange={(e) => setStatusDraft(e.target.value as Project["status"])}><option value="active">فعال</option><option value="paused">متوقف</option><option value="completed">تکمیل‌شده</option></select></label>
                <label className="grid gap-1 text-xs text-muted-foreground">مالک<select className={inputClass} value={ownerDraft} onChange={(e) => setOwnerDraft(e.target.value)}><option value="">بدون مالک</option>{owners.map((member) => <option value={member.id} key={member.id}>{member.fullName}</option>)}</select></label>
                <label className="grid gap-1 text-xs text-muted-foreground">بودجه (ریال)<PersianNumberInput className={inputClass} inputMode="numeric" allowDecimal={false} allowNegative={false} value={budgetDraft} onChange={(e) => setBudgetDraft(e.target.value)} placeholder="بدون سقف" /></label>
                
                <div className="flex gap-2"><Button size="sm" onClick={handleSaveOperations}><SaveIcon className="size-3" /> ذخیره</Button><Button variant="outline" size="sm" onClick={() => setEditingOperations(false)}>انصراف</Button></div>
              </> : <>
                <p>وضعیت: <b>{project.status === "active" ? "فعال" : project.status === "paused" ? "متوقف" : "تکمیل‌شده"}</b></p>
                <p>مالک: <b>{project.ownerName ?? "تعیین نشده"}</b></p>
                
                <div className="rounded-lg bg-muted/50 p-3"><p className="text-xs text-muted-foreground">خرج تا امروز</p><b className="text-base">{formatPersianNumber(cost?.spentRial ?? 0)} ریال</b><p className="mt-2 text-xs text-muted-foreground">بودجه: {cost?.budgetRial === null || cost?.budgetRial === undefined ? "تعریف نشده" : `${formatPersianNumber(cost.budgetRial)} ریال`}</p>{cost?.remainingBudgetRial !== null && cost?.remainingBudgetRial !== undefined ? <p className="text-xs text-muted-foreground">ماندهٔ بودجه: {formatPersianNumber(cost.remainingBudgetRial)} ریال</p> : null}<p className="mt-2 text-xs text-muted-foreground">{formatPersianNumber(cost?.campaigns ?? 0)} کمپین مرتبط</p></div>
              </>}
            </div>
          </SectionCard>

          {/* Notes sidebar */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">
              یادداشت‌ها ({notes.length})
            </h2>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddNote(true)}
            >
              <PlusIcon className="size-3" />
              یادداشت
            </Button>
          </div>

          {showAddNote && (
            <div className={`${cardClass} p-3`}>
              <input
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                placeholder="عنوان یادداشت"
                className={`${inputClass} mb-2`}
                autoFocus
              />
              <textarea
                value={noteContent}
                onChange={(e) => setNoteContent(e.target.value)}
                rows={3}
                placeholder="متن یادداشت (اختیاری)"
                className={`${inputClass} mb-2`}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddNote} disabled={!noteTitle.trim()}>
                  ذخیره
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setShowAddNote(false);
                    setNoteTitle("");
                    setNoteContent("");
                  }}
                >
                  انصراف
                </Button>
              </div>
            </div>
          )}

          {notes.length === 0 && !showAddNote ? (
            <p className="text-xs text-muted-foreground">یادداشتی نیست.</p>
          ) : (
            <div className="space-y-2">
              {notes.map((note) => (
                <div
                  key={note.id}
                  className="group rounded-xl border border-border/80 bg-card p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <StickyNoteIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                      <h3 className="text-sm font-medium">{note.title}</h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteNote(note.id)}
                      aria-label={"حذف یادداشت " + note.title}
                      className="rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 outline-none focus-visible:ring focus-visible:ring-ring/50 focus-visible:opacity-100"
                      title="حذف"
                    >
                      <TrashIcon className="size-3.5" />
                    </button>
                  </div>
                  {note.content && (
                    <p className="mt-1.5 line-clamp-3 text-xs text-muted-foreground">
                      {note.content}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Tasks — units of work with an open/done lifecycle. Open tasks are
              carried into every thread of this project so the assistant knows
              what is still outstanding; done tasks stay for the record. */}
          <div className="flex items-center justify-between pt-2">
            <h2 className="text-sm font-semibold text-foreground">
              کارهای پروژه ({formatPersianNumber(openTaskCount)} باز)
            </h2>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddTask(true)}
              disabled={openTaskCount >= PROJECT_TASK_MAX_OPEN}
            >
              <PlusIcon className="size-3" />
              کار
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            کارهای باز به دستیار گفته می‌شوند تا بداند چه چیزی هنوز انجام نشده است.
          </p>

          {showAddTask && (
            <div className={`${cardClass} p-3`}>
              <input
                value={taskDraft}
                onChange={(e) => setTaskDraft(e.target.value.slice(0, PROJECT_TASK_CHAR_LIMIT))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && taskDraft.trim()) handleAddTask();
                }}
                placeholder="یک کار کوتاه برای این پروژه"
                className={`${inputClass} mb-1`}
                autoFocus
              />
              <p className="mb-2 text-left text-[11px] text-muted-foreground">
                {formatPersianNumber(PROJECT_TASK_CHAR_LIMIT - taskDraft.length)}
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddTask} disabled={!taskDraft.trim()}>
                  افزودن
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setShowAddTask(false);
                    setTaskDraft("");
                  }}
                >
                  انصراف
                </Button>
              </div>
            </div>
          )}

          {tasks.length === 0 && !showAddTask ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ListTodoIcon className="size-3.5" />
              کاری ثبت نشده.
            </p>
          ) : (
            <div className="space-y-1.5">
              {tasks.map((task) => (
                <div
                  key={task.id}
                  className="group flex items-start justify-between gap-2 rounded-xl border border-border/80 bg-card p-2.5"
                >
                  <button
                    type="button"
                    onClick={() => handleToggleTask(task)}
                    className="flex min-w-0 flex-1 items-start gap-2 text-right outline-none"
                    aria-label={task.status === "done" ? "بازکردن کار" : "انجام‌شدن کار"}
                  >
                    {task.status === "done" ? (
                      <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <CircleIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition group-hover:text-foreground" />
                    )}
                    <span
                      className={`min-w-0 text-xs ${task.status === "done" ? "text-muted-foreground line-through" : "text-foreground"}`}
                    >
                      {task.title}
                      {task.source === "ai" && (
                        <span className="mr-1 inline-block rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-600 dark:text-violet-400">
                          دستیار
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteTask(task.id)}
                    aria-label="حذف کار"
                    className="rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 outline-none focus-visible:ring focus-visible:ring-ring/50 focus-visible:opacity-100"
                    title="حذف"
                  >
                    <TrashIcon className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Memory — standing facts the assistant carries into every thread
              of this project. */}
          <div className="flex items-center justify-between pt-2">
            <h2 className="text-sm font-semibold text-foreground">
              حافظهٔ پروژه ({memory.length})
            </h2>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddMemory(true)}
              disabled={memory.length >= PROJECT_MEMORY_MAX_ENTRIES}
            >
              <PlusIcon className="size-3" />
              نکته
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            نکاتی که دستیار باید در همهٔ گفت‌وگوهای این پروژه به یاد داشته باشد.
          </p>

          {showAddMemory && (
            <div className={`${cardClass} p-3`}>
              <textarea
                value={memoryDraft}
                onChange={(e) => setMemoryDraft(e.target.value.slice(0, PROJECT_MEMORY_CHAR_LIMIT))}
                rows={2}
                placeholder="یک نکتهٔ کوتاه که باید به خاطر بماند"
                className={`${inputClass} mb-1`}
                autoFocus
              />
              <p className="mb-2 text-left text-[11px] text-muted-foreground">
                {formatPersianNumber(PROJECT_MEMORY_CHAR_LIMIT - memoryDraft.length)}
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddMemory} disabled={!memoryDraft.trim()}>
                  ذخیره
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setShowAddMemory(false);
                    setMemoryDraft("");
                  }}
                >
                  انصراف
                </Button>
              </div>
            </div>
          )}

          {memory.length === 0 && !showAddMemory ? (
            <p className="text-xs text-muted-foreground">حافظه‌ای ثبت نشده.</p>
          ) : (
            <div className="space-y-2">
              {memory.map((item) => (
                <div
                  key={item.id}
                  className="group rounded-xl border border-border/80 bg-card p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-1.5">
                      <BrainIcon className="mt-0.5 size-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
                      <p className="text-xs text-foreground">{item.content}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteMemory(item.id)}
                      aria-label="حذف نکتهٔ حافظه"
                      className="rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 outline-none focus-visible:ring focus-visible:ring-ring/50 focus-visible:opacity-100"
                      title="حذف"
                    >
                      <TrashIcon className="size-3.5" />
                    </button>
                  </div>
                  {item.source === "ai" && (
                    <span className="mt-1 inline-block rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-600 dark:text-violet-400">
                      ثبت‌شده توسط دستیار
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
