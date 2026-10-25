"use client";

/**
 * The clean conversation composer for the AI assistant (`/dashboard`, Issue #905).
 *
 * Owner UX correction (2026-10-17):
 * - Default composer shows only the text input, the `+` entry point on the
 *   trailing tools side (physical bottom-right), the send/stop button anchored
 *   at the physical bottom-left inside the input box (in both RTL and LTR),
 *   and attachment previews only when attachments exist.
 * - All secondary tools — attachments (image/receipt, PDF), assistant/task,
 *   focus, response mode, project, search, and message settings — are accessed
 *   through the concise, labeled `+` menu with current selection summaries and
 *   checkmarks, gated by capability and permissions.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertCircleIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  BarChart3Icon,
  CheckIcon,
  ChevronLeftIcon,
  FileTextIcon,
  FolderKanbanIcon,
  ImageIcon,
  BrainCircuitIcon,
  SparklesIcon,
  ZapIcon,
  ChevronDownIcon,
  LayersIcon,
  MessageSquareIcon,
  PenLineIcon,
  PlusIcon,
  RotateCcwIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  APP_FOCUS_OPTIONS,
  RUNTIME_MODE_LABELS,
  useAiWorkspaceProjects,
  type AiWorkspaceContextProps,
} from "@/app/dashboard/ai/ai-workspace-context";
import {
  AI_RUNTIME_MODES,
  AI_CHAT_MODES,
  isAiRuntimeModeAvailable,
} from "@/lib/ai-runtime-modes-shared";
import { useAiComposerSearch } from "./ai-composer-tools";
import { MediaPickerDialog, mediaFileUrl } from "@/app/dashboard/media/media-picker";
import {
  TaskIcon,
  resolveAvailablePresetTasks,
  resolveCurrentTaskSummary,
} from "./ai-task-selector";
import { formatAttachmentSize } from "./chat-bubble";
import { animateSendPulse } from "./chat-animations";
import type { AiTaskId } from "@/lib/ai-tasks";
import type { AssistantMode, ChatAttachment } from "./use-ai-chat";

type ComposerMenuView =
  | "root"
  | "task"
  | "focus"
  | "mode"
  | "project"
  | "search"
  | "settings";

interface ChatComposerProps {
  mode: AssistantMode;
  input: string;
  setInput: (value: string) => void;
  busy: boolean;
  canPropose: boolean;
  attachments: ChatAttachment[];
  onAttachFiles: (files: File[]) => void;
  onClearAttachment: (id?: string) => void;
  task: AiTaskId;
  onTaskChange: (id: AiTaskId) => void;
  customTask: string;
  onCustomTaskChange: (text: string) => void;
  eligibleTaskIds?: readonly AiTaskId[];
  showTaskSelector?: boolean;
  workspaceContext?: Omit<AiWorkspaceContextProps, "disabled" | "compact">;
  inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
  actionsAllowed: boolean;
  setActionsAllowed: (allowed: boolean) => void;
  loadConversation: (id: string) => void;
  sendMessage: (prompt?: string) => void;
  onCancelGeneration?: () => void;
  cancellable?: boolean;
  /** The small print under the composer (mode-dependent). */
  footer?: ReactNode;
}

export function ChatComposer({
  mode,
  input,
  setInput,
  busy,
  canPropose,
  attachments,
  onAttachFiles,
  onClearAttachment,
  task,
  onTaskChange,
  customTask,
  onCustomTaskChange,
  eligibleTaskIds,
  showTaskSelector = true,
  workspaceContext,
  inputRef,
  actionsAllowed,
  setActionsAllowed,
  loadConversation,
  sendMessage,
  onCancelGeneration,
  cancellable = false,
  footer,
}: ChatComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const pointerToggleRef = useRef(false);
  const [focused, setFocused] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<ComposerMenuView>("root");
  const [customTaskOpen, setCustomTaskOpen] = useState(false);
  const [customTaskDraft, setCustomTaskDraft] = useState("");
  const wasSendable = useRef(false);

  const canSelectProject = Boolean(
    workspaceContext && (workspaceContext.canSelectProject ?? true),
  );
  const {
    projects,
    projectsLoading,
    projectsError,
    loadProjects,
    selectedProject,
  } = useAiWorkspaceProjects({
    canSelectProject,
    projectId: workspaceContext?.projectId ?? null,
    onProjectNameChange: workspaceContext?.onProjectNameChange,
  });

  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    results: searchResults,
    searching,
    noResults,
    resetSearch,
  } = useAiComposerSearch(canPropose && menuOpen && menuView === "search");

  const availableTasks = resolveAvailablePresetTasks(mode, eligibleTaskIds);
  const currentTask = resolveCurrentTaskSummary(task, customTask);

  const focusOptions =
    workspaceContext?.accessibleFocuses &&
    workspaceContext.accessibleFocuses.length > 0
      ? APP_FOCUS_OPTIONS.filter(
          (item) =>
            item.value === "all" ||
            workspaceContext.accessibleFocuses!.includes(item.value),
        )
      : APP_FOCUS_OPTIONS;

  const currentFocusLabel = workspaceContext
    ? (APP_FOCUS_OPTIONS.find((item) => item.value === workspaceContext.appFocus)
        ?.label ?? "همهٔ بخش‌ها")
    : "همهٔ بخش‌ها";

  const availableRuntimeModes = workspaceContext
    ? AI_RUNTIME_MODES.filter((m) =>
        isAiRuntimeModeAvailable(
          m,
          Boolean(workspaceContext.deepResearchEnabled),
        ),
      )
    : [];

  const currentProjectSummary = !canSelectProject
    ? null
    : projectsLoading
      ? "در حال خواندن…"
      : projectsError
        ? "خطا در خواندن پروژه‌ها"
        : selectedProject
          ? selectedProject.name
          : projects.length === 0
            ? "پروژه‌ای ثبت نشده"
            : "بدون پروژه";

  const resetMenuState = () => {
    setMenuView("root");
    setCustomTaskOpen(false);
    setCustomTaskDraft("");
    resetSearch();
  };

  const closeMenu = () => {
    setMenuOpen(false);
    resetMenuState();
  };

  // Auto-grow the textarea up to a ceiling.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const sendable = Boolean(input.trim()) && !busy;
  useEffect(() => {
    if (sendable && !wasSendable.current && sendRef.current) {
      animateSendPulse(sendRef.current);
    }
    wasSendable.current = sendable;
  }, [sendable]);

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      if (sendable) sendMessage();
    }
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    const files = Array.from(event.dataTransfer.files).filter(
      (file) =>
        /^image\/(jpeg|png|webp)$/.test(file.type) ||
        file.type === "application/pdf",
    );
    if (files.length > 0) onAttachFiles(files);
  }

  const showSecondaryMenu =
    mode === "dashboard" ||
    (showTaskSelector && mode !== "wizard") ||
    Boolean(workspaceContext) ||
    canPropose;

  return (
    <div className="min-w-0">
      {/* Attachment chips — rendered only when attachments exist. */}
      {attachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className="group relative flex items-center gap-2 rounded-xl border border-border/80 bg-muted/40 py-1 pe-8 ps-1.5"
            >
              {attachment.kind === "image" ? (
                <img
                  src={attachment.dataUrl}
                  alt={attachment.name}
                  className="size-9 rounded-lg border object-cover"
                />
              ) : (
                <span className="grid size-9 place-items-center rounded-lg bg-red-50 dark:bg-red-500/15 text-red-600 dark:text-red-400 ring-1 ring-red-200/70 dark:ring-red-800/70">
                  <FileTextIcon className="size-4" />
                </span>
              )}
              <span className="min-w-0">
                <span className="block max-w-32 truncate text-[11px] font-medium leading-4">
                  {attachment.name}
                </span>
                <span className="block text-[10px] leading-3 text-muted-foreground">
                  {formatAttachmentSize(attachment.sizeBytes)}
                </span>
              </span>
              <button
                type="button"
                onClick={() => onClearAttachment(attachment.id)}
                aria-label={`حذف پیوست ${attachment.name}`}
                className="absolute end-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-full text-muted-foreground opacity-100 transition-opacity hover:bg-background hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 outline-none focus-visible:ring focus-visible:ring-ring/50"
              >
                <XIcon className="size-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div
        data-composer-box=""
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          "relative rounded-2xl border bg-card shadow-[0_1px_2px_rgb(41_37_36/0.04)] transition-all duration-200 p-3 pb-12 sm:p-3.5 sm:pb-12",
          dragOver
            ? "border-primary ring-4 ring-primary/20"
            : focused
              ? "border-ring ring ring-ring/40"
              : "border-border/80",
        )}
      >
        {dragOver ? (
          <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-2xl bg-primary/5 text-[11px] font-medium text-primary">
            فایل را رها کنید تا پیوست شود
          </div>
        ) : null}

        <textarea
          ref={(node) => {
            textareaRef.current = node;
            if (inputRef) inputRef.current = node;
          }}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="پیام خود را بنویسید…"
          aria-label="پیام"
          className="w-full resize-none bg-transparent px-1.5 py-1 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground min-h-10"
        />

        {/* One upload picker; server validation still limits supported AI inputs. */}
        {mode === "dashboard" ? (
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length > 0) onAttachFiles(files);
              event.target.value = "";
            }}
          />
        ) : null}

        {/* `+` secondary-tools entry point on the physical bottom-RIGHT (trailing tools side) */}
        {showSecondaryMenu ? (
          <div className={cn("absolute bottom-2.5 z-10 flex items-center sm:bottom-3", mode === "dashboard" ? "left-2.5 sm:left-3" : "right-2.5 sm:right-3")}>
            <DropdownMenu
              open={menuOpen}
              onOpenChange={(open) => {
                pointerToggleRef.current = true;
                setMenuOpen(open);
                if (!open) {
                  resetMenuState();
                }
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  aria-label="افزودن پیوست و ابزارهای گفتگو"
                  title="افزودن پیوست و ابزارهای گفتگو"
                  onPointerDown={() => {
                    pointerToggleRef.current = false;
                  }}
                  onClick={() => {
                    if (pointerToggleRef.current) {
                      pointerToggleRef.current = false;
                      return;
                    }
                    setMenuOpen((prev) => {
                      const next = !prev;
                      if (!next) resetMenuState();
                      return next;
                    });
                  }}
                  className="size-8 rounded-full text-muted-foreground hover:text-foreground"
                >
                  <PlusIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>

              <DropdownMenuContent
                align="start"
                side="top"
                collisionPadding={12}
                className="w-72 max-w-[calc(100vw-1.5rem)] p-1.5"
              >
                {menuView === "root" ? (
                  <>
                    {mode === "dashboard" ? (
                      <>
                        <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}
                          className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2">
                          <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0">
                            <span className="block text-xs font-semibold">بارگذاری فایل</span>
                            <span className="block text-[10px] text-muted-foreground">تصویر یا PDF — فرمت‌های بیشتر پس از پشتیبانی پردازش امن</span>
                          </span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setLibraryOpen(true)}
                          className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2">
                          <FolderKanbanIcon className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0">
                            <span className="block text-xs font-semibold">انتخاب از کتابخانه رسانه</span>
                            <span className="block text-[10px] text-muted-foreground">تصاویر موجود در کتابخانه کسب‌وکار</span>
                          </span>
                        </DropdownMenuItem>
                      </>
                    ) : null}

                    {(showTaskSelector && mode !== "wizard") || workspaceContext ? (
                      <DropdownMenuSeparator className="my-1" />
                    ) : null}

                    {workspaceContext ? (
                      <>
                        <DropdownMenuItem
                          onSelect={(event) => {
                            event.preventDefault();
                            setMenuView("focus");
                          }}
                          aria-label={`تمرکز دستیار: ${currentFocusLabel}`}
                          className="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-2"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-foreground/80">
                              <LayersIcon className="size-3.5" />
                            </span>
                            <span className="min-w-0">
                              <span className="block text-xs font-semibold text-foreground">
                                تمرکز دستیار
                              </span>
                              <span className="block truncate text-[10px] text-muted-foreground">
                                {currentFocusLabel}
                              </span>
                            </span>
                          </span>
                          <ChevronLeftIcon className="size-3.5 shrink-0 text-muted-foreground ltr:rotate-180" />
                        </DropdownMenuItem>



                        {canSelectProject ? (
                          <DropdownMenuItem
                            onSelect={(event) => {
                              event.preventDefault();
                              setMenuView("project");
                            }}
                            aria-label={`پروژه: ${currentProjectSummary ?? "بدون پروژه"}`}
                            className="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-2"
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-foreground/80">
                                <FolderKanbanIcon className="size-3.5" />
                              </span>
                              <span className="min-w-0">
                                <span className="block text-xs font-semibold text-foreground">
                                  پروژه
                                </span>
                                <span
                                  className={cn(
                                    "block truncate text-[10px]",
                                    projectsError
                                      ? "text-destructive"
                                      : "text-muted-foreground",
                                  )}
                                >
                                  {currentProjectSummary}
                                </span>
                              </span>
                            </span>
                            <ChevronLeftIcon className="size-3.5 shrink-0 text-muted-foreground ltr:rotate-180" />
                          </DropdownMenuItem>
                        ) : null}
                      </>
                    ) : null}

                  </>
                ) : null}

                {menuView === "task" ? (
                  <div>
                    <div className="mb-1 flex items-center gap-1 border-b border-border/70 px-1 pb-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setCustomTaskOpen(false);
                          setCustomTaskDraft("");
                          setMenuView("root");
                        }}
                        aria-label="بازگشت به منوی ابزارها"
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
                      >
                        <ArrowRightIcon className="size-3.5 ltr:rotate-180" />
                        <span>بازگشت</span>
                      </button>
                      <span className="text-xs font-semibold text-foreground">
                        وظیفهٔ دستیار
                      </span>
                    </div>

                    <div className="max-h-64 overflow-y-auto">
                      {availableTasks.map((item) => {
                        const selected = task === item.id;
                        return (
                          <DropdownMenuItem
                            key={item.id}
                            role="menuitemradio"
                            aria-checked={selected}
                            onSelect={() => {
                              onTaskChange(item.id);
                              if (customTask) {
                                onCustomTaskChange("");
                              }
                              closeMenu();
                            }}
                            className={cn(
                              "flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2",
                              selected && "bg-primary/5",
                            )}
                          >
                            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                              <TaskIcon id={item.id} className="size-3.5" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-xs font-semibold leading-5 text-foreground">
                                {item.label}
                              </span>
                              <span className="block text-[10px] leading-4 text-muted-foreground">
                                {item.description}
                              </span>
                            </span>
                            {selected ? (
                              <CheckIcon
                                className="mt-1 size-4 shrink-0 text-primary"
                                aria-hidden="true"
                              />
                            ) : null}
                          </DropdownMenuItem>
                        );
                      })}
                    </div>

                    <DropdownMenuSeparator className="my-1" />

                    {customTaskOpen ? (
                      <div className="p-2">
                        <textarea
                          autoFocus
                          value={customTaskDraft}
                          onChange={(event) => setCustomTaskDraft(event.target.value)}
                          onKeyDown={(event) => event.stopPropagation()}
                          rows={3}
                          placeholder="مثلاً: پاسخ‌ها را کوتاه و در قالب جدول مقایسه‌ای بنویس…"
                          className="w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-xs leading-5 outline-none focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50"
                        />
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setCustomTaskOpen(false);
                              setCustomTaskDraft("");
                            }}
                            className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
                          >
                            انصراف
                          </button>
                          <Button
                            type="button"
                            size="sm"
                            disabled={!customTaskDraft.trim()}
                            onClick={() => {
                              onCustomTaskChange(customTaskDraft.trim());
                              onTaskChange("custom");
                              closeMenu();
                            }}
                          >
                            اعمال وظیفه
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <DropdownMenuItem
                        role="menuitemradio"
                        aria-checked={task === "custom" && Boolean(customTask)}
                        onSelect={(event) => {
                          event.preventDefault();
                          setCustomTaskOpen(true);
                          setCustomTaskDraft(customTask);
                        }}
                        className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2"
                      >
                        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
                          <PenLineIcon className="size-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs font-semibold leading-5 text-foreground">
                            سفارشی…
                          </span>
                          <span className="block text-[10px] leading-4 text-muted-foreground">
                            هر وظیفه‌ای که می‌خواهید، به زبان خودتان
                          </span>
                        </span>
                        {task === "custom" && Boolean(customTask) ? (
                          <CheckIcon
                            className="size-4 shrink-0 text-primary"
                            aria-hidden="true"
                          />
                        ) : null}
                      </DropdownMenuItem>
                    )}
                  </div>
                ) : null}

                {menuView === "focus" && workspaceContext ? (
                  <div>
                    <div className="mb-1 flex items-center gap-1 border-b border-border/70 px-1 pb-1.5">
                      <button
                        type="button"
                        onClick={() => setMenuView("root")}
                        aria-label="بازگشت به منوی ابزارها"
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
                      >
                        <ArrowRightIcon className="size-3.5 ltr:rotate-180" />
                        <span>بازگشت</span>
                      </button>
                      <span className="text-xs font-semibold text-foreground">
                        تمرکز دستیار
                      </span>
                    </div>
                    <div className="space-y-0.5">
                      {focusOptions.map((option) => {
                        const selected = workspaceContext.appFocus === option.value;
                        return (
                          <DropdownMenuItem
                            key={option.value}
                            role="menuitemradio"
                            aria-checked={selected}
                            onSelect={() => {
                              workspaceContext.onAppFocusChange(option.value);
                              closeMenu();
                            }}
                            className={cn(
                              "flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs",
                              selected && "bg-primary/5 font-semibold text-primary",
                            )}
                          >
                            <span>{option.label}</span>
                            {selected ? (
                              <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                            ) : null}
                          </DropdownMenuItem>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

                {menuView === "mode" && workspaceContext ? (
                  <div>
                    <div className="mb-1 flex items-center gap-1 border-b border-border/70 px-1 pb-1.5">
                      <button
                        type="button"
                        onClick={() => setMenuView("root")}
                        aria-label="بازگشت به منوی ابزارها"
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
                      >
                        <ArrowRightIcon className="size-3.5 ltr:rotate-180" />
                        <span>بازگشت</span>
                      </button>
                      <span className="text-xs font-semibold text-foreground">
                        حالت پاسخ‌گویی
                      </span>
                    </div>
                    <div className="space-y-0.5">
                      {availableRuntimeModes.map((m) => {
                        const selected = workspaceContext.runtimeMode === m;
                        return (
                          <DropdownMenuItem
                            key={m}
                            role="menuitemradio"
                            aria-checked={selected}
                            onSelect={() => {
                              workspaceContext.onRuntimeModeChange(m);
                              closeMenu();
                            }}
                            className={cn(
                              "flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs",
                              selected && "bg-primary/5 font-semibold text-primary",
                            )}
                          >
                            <span>{RUNTIME_MODE_LABELS[m]}</span>
                            {selected ? (
                              <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                            ) : null}
                          </DropdownMenuItem>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

                {menuView === "project" && workspaceContext && canSelectProject ? (
                  <div>
                    <div className="mb-1 flex items-center gap-1 border-b border-border/70 px-1 pb-1.5">
                      <button
                        type="button"
                        onClick={() => setMenuView("root")}
                        aria-label="بازگشت به منوی ابزارها"
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
                      >
                        <ArrowRightIcon className="size-3.5 ltr:rotate-180" />
                        <span>بازگشت</span>
                      </button>
                      <span className="text-xs font-semibold text-foreground">
                        پروژه
                      </span>
                    </div>

                    {projectsLoading ? (
                      <div className="p-2">
                        <Skeleton
                          className="h-7 w-full rounded-md"
                          aria-label="در حال خواندن پروژه‌ها"
                        />
                      </div>
                    ) : projectsError ? (
                      <div
                        role="status"
                        className="m-1 flex items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
                      >
                        <span className="flex items-center gap-1.5 font-medium">
                          <AlertCircleIcon className="size-3.5 shrink-0" aria-hidden="true" />
                          <span>خطا در خواندن پروژه‌ها</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => void loadProjects()}
                          className="inline-flex items-center gap-1 rounded-md bg-background/80 px-2 py-1 text-[11px] font-semibold text-foreground hover:bg-background outline-none focus-visible:ring focus-visible:ring-ring/50"
                        >
                          <RotateCcwIcon className="size-3" aria-hidden="true" />
                          تلاش مجدد
                        </button>
                      </div>
                    ) : (
                      <div className="max-h-60 space-y-0.5 overflow-y-auto">
                        <DropdownMenuItem
                          role="menuitemradio"
                          aria-checked={!workspaceContext.projectId}
                          onSelect={() => {
                            workspaceContext.onProjectChange(null);
                            closeMenu();
                          }}
                          className={cn(
                            "flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs",
                            !workspaceContext.projectId &&
                              "bg-primary/5 font-semibold text-primary",
                          )}
                        >
                          <span>
                            {projects.length === 0
                              ? "بدون پروژه (پروژه‌ای ثبت نشده)"
                              : "بدون پروژه"}
                          </span>
                          {!workspaceContext.projectId ? (
                            <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                          ) : null}
                        </DropdownMenuItem>
                        {projects.map((project) => {
                          const selected = workspaceContext.projectId === project.id;
                          return (
                            <DropdownMenuItem
                              key={project.id}
                              role="menuitemradio"
                              aria-checked={selected}
                              onSelect={() => {
                                workspaceContext.onProjectChange(project.id);
                                closeMenu();
                              }}
                              className={cn(
                                "flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs",
                                selected && "bg-primary/5 font-semibold text-primary",
                              )}
                            >
                              <span className="truncate">{project.name}</span>
                              {selected ? (
                                <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                              ) : null}
                            </DropdownMenuItem>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : null}

                {menuView === "search" && canPropose ? (
                  <div className="p-1">
                    <div className="mb-1.5 flex items-center gap-1 border-b border-border/70 pb-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          resetSearch();
                          setMenuView("root");
                        }}
                        aria-label="بازگشت به منوی ابزارها"
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
                      >
                        <ArrowRightIcon className="size-3.5 ltr:rotate-180" />
                        <span>بازگشت</span>
                      </button>
                      <span className="text-xs font-semibold text-foreground">
                        جست‌وجو در گزارش‌ها و گفتگوها
                      </span>
                    </div>
                    <input
                      autoFocus
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      onKeyDown={(event) => event.stopPropagation()}
                      placeholder="جست‌وجو در گزارش‌ها و گفتگوهای قبلی…"
                      aria-label="جست‌وجو در گزارش‌ها و گفتگوهای قبلی"
                      className="mb-2 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-xs outline-none focus-visible:border-ring"
                    />
                    {searching ? (
                      <div
                        role="status"
                        aria-live="polite"
                        aria-busy="true"
                        aria-label="در حال جست‌وجو"
                        className="space-y-1.5 px-1 py-1"
                      >
                        <Skeleton aria-hidden="true" className="h-5 w-full rounded-md" />
                        <Skeleton aria-hidden="true" className="h-5 w-4/5 rounded-md" />
                      </div>
                    ) : null}
                    {noResults ? (
                      <p className="px-1 py-1 text-[11px] text-muted-foreground">
                        نتیجه‌ای یافت نشد.
                      </p>
                    ) : null}
                    {searchResults?.reports?.length ? (
                      <div className="mb-1.5">
                        <p className="px-1 pb-1 text-[10px] font-medium text-muted-foreground">
                          گزارش‌ها
                        </p>
                        {searchResults.reports.map((report) => (
                          <button
                            key={report.key}
                            type="button"
                            onClick={() => {
                              setInput(`گزارش «${report.label}» را اجرا و خلاصه کن.`);
                              closeMenu();
                            }}
                            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-start text-xs hover:bg-muted outline-none focus-visible:ring focus-visible:ring-ring/50"
                          >
                            <BarChart3Icon className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate">{report.label}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {searchResults?.conversations?.length ? (
                      <div>
                        <p className="px-1 pb-1 text-[10px] font-medium text-muted-foreground">
                          گفتگوهای قبلی
                        </p>
                        {searchResults.conversations.map((conversation) => (
                          <button
                            key={conversation.id}
                            type="button"
                            onClick={() => {
                              loadConversation(conversation.id);
                              closeMenu();
                            }}
                            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-start text-xs hover:bg-muted outline-none focus-visible:ring focus-visible:ring-ring/50"
                          >
                            <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate">{conversation.title}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {menuView === "settings" && canPropose ? (
                  <div className="p-1.5">
                    <div className="mb-2 flex items-center gap-1 border-b border-border/70 pb-1.5">
                      <button
                        type="button"
                        onClick={() => setMenuView("root")}
                        aria-label="بازگشت به منوی ابزارها"
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
                      >
                        <ArrowRightIcon className="size-3.5 ltr:rotate-180" />
                        <span>بازگشت</span>
                      </button>
                      <span className="text-xs font-semibold text-foreground">
                        تنظیمات این پیام
                      </span>
                    </div>
                    <label className="flex items-center justify-between gap-2 px-1 py-1 text-xs">
                      <span className="leading-5">
                        اجازهٔ اقدام در این پیام
                        <span className="block text-[10px] text-muted-foreground">
                          خاموش‌کردن یعنی دستیار فقط پاسخ می‌دهد و در این پیام هیچ
                          پیشنهاد تغییری نمی‌سازد.
                        </span>
                      </span>
                      <Switch
                        checked={actionsAllowed}
                        onCheckedChange={setActionsAllowed}
                        aria-label="اجازهٔ اقدام در این پیام"
                      />
                    </label>
                  </div>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}

        {/* Persistent task/mode controls next to Send in the physical RIGHT edge. */}
        <div className={cn("absolute bottom-2.5 z-10 flex items-center gap-1 sm:bottom-3", mode === "dashboard" ? "right-2.5 sm:right-3" : "left-2.5 sm:left-3")}>
          {mode === "dashboard" && showTaskSelector ? (
            <label className="relative min-w-0">
              <span className="sr-only">وظیفه دستیار</span>
              <select
                value={task}
                disabled={busy}
                aria-label={`وظیفه دستیار: ${currentTask.label}`}
                onChange={(event) => {
                  if (event.target.value === "custom") {
                    setCustomTaskOpen(true);
                    setCustomTaskDraft(customTask);
                    setMenuView("task");
                    setMenuOpen(true);
                    return;
                  }
                  onTaskChange(event.target.value as AiTaskId);
                  if (customTask) onCustomTaskChange("");
                }}
                className="h-8 max-w-28 appearance-none rounded-full border border-border bg-card ps-2 pe-5 text-[11px] outline-none focus-visible:ring focus-visible:ring-ring/50 sm:max-w-36"
              >
                {availableTasks.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                <option value="custom">وظیفه سفارشی…</option>
              </select>
              <ChevronDownIcon className="pointer-events-none absolute end-1 top-2 size-3 text-muted-foreground" />
            </label>
          ) : null}
          {mode === "dashboard" && workspaceContext ? AI_CHAT_MODES.map((value) => {
            const Icon = value === "auto" ? SparklesIcon : value === "instant" ? ZapIcon : BrainCircuitIcon;
            const label = value === "auto" ? "خودکار" : value === "instant" ? "سریع" : "تفکر عمیق";
            return (
              <Button key={value} type="button" variant={workspaceContext.runtimeMode === value ? "secondary" : "ghost"}
                size="icon-sm" disabled={busy} aria-label={`حالت پاسخ‌گویی: ${label}`} title={label}
                aria-pressed={workspaceContext.runtimeMode === value}
                onClick={() => workspaceContext.onRuntimeModeChange(value)}
                className="size-7 shrink-0 rounded-full">
                <Icon className="size-3.5" />
              </Button>
            );
          }) : null}
          {busy && cancellable ? (
            <Button
              type="button"
              size="icon-sm"
              onClick={onCancelGeneration}
              aria-label="توقف پاسخ‌گویی"
              title="توقف پاسخ‌گویی"
              className="size-8 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              <SquareIcon className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              ref={sendRef}
              type="button"
              size="icon-sm"
              onClick={() => sendMessage()}
              disabled={busy || !input.trim()}
              aria-label="ارسال پیام"
              title="ارسال پیام (Enter)"
              className={cn(
                "size-8 rounded-full transition-all",
                !busy && input.trim() && "opacity-100",
              )}
            >
              <ArrowUpIcon className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {mode === "dashboard" && libraryOpen ? (
        <MediaPickerDialog title="انتخاب تصویر از کتابخانه" kind="image" canUpload={false}
          onClose={() => setLibraryOpen(false)}
          onPick={async (asset) => {
            try {
              const response = await fetch(mediaFileUrl(asset.id), { credentials: "same-origin" });
              if (!response.ok) throw new Error("media_fetch_failed");
              const blob = await response.blob();
              onAttachFiles([new File([blob], asset.fileName, { type: blob.type })]);
              setLibraryOpen(false);
            } catch {
              toast.error("دریافت فایل از کتابخانه ممکن نشد.");
            }
          }}
        />
      ) : null}
      {footer}
    </div>
  );
}
