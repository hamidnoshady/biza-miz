"use client";

/**
 * The ChatGPT-style composer pinned under the assistant's chat home
 * (`/dashboard`, Phase 36c redesign).
 *
 * One rounded field with everything the chat needs: attachment chips with
 * thumbnails, an upload menu (image / PDF), the task dropdown (which app or
 * function the assistant should act as), the per-message tools, and a send
 * button. Files can also be dropped onto the field. Enter sends, Shift+Enter
 * breaks the line.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpIcon,
  FileTextIcon,
  ImageIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AiComposerTools } from "./ai-composer-tools";
import { AiTaskSelector } from "./ai-task-selector";
import { AiAgentSelector } from "./ai-agent-selector";
import { formatAttachmentSize } from "./chat-bubble";
import { animateSendPulse } from "./chat-animations";
import type { AiTaskId } from "@/lib/ai-tasks";
import type { AssistantMode, ChatAttachment } from "./use-ai-chat";

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
  /** Phase I — the custom agent this dashboard turn runs as (null = full assistant). */
  agentId: string | null;
  onAgentChange: (id: string | null) => void;
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
  agentId,
  onAgentChange,
  actionsAllowed,
  setActionsAllowed,
  loadConversation,
  sendMessage,
  onCancelGeneration,
  cancellable = false,
  footer,
}: ChatComposerProps) {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const [focused, setFocused] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const wasSendable = useRef(false);

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
    if (event.key === "Enter" && !event.shiftKey) {
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

  return (
    <div className="min-w-0">
      {/* Attachment chips — rendered above the field so they never shrink it. */}
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
                className="absolute end-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 outline-none focus-visible:ring focus-visible:ring-ring/50"
              >
                <XIcon className="size-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          "relative rounded-2xl border bg-card shadow-[0_1px_2px_rgb(41_37_36/0.04)] transition-all duration-200 p-3 sm:p-3.5",
          dragOver
            ? "border-primary ring-4 ring-primary/20"
            : focused
              ? "border-ring ring ring-ring/40"
              : "border-border/80",
        )}
      >
        {dragOver ? (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl bg-primary/5 text-[11px] font-medium text-primary">
            فایل را رها کنید تا پیوست شود
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="پیام خود را بنویسید…"
          aria-label="پیام"
          className={cn(
            "w-full resize-none bg-transparent px-1.5 py-1 text-sm leading-6 outline-none placeholder:text-muted-foreground min-h-10",
          )}
        />

        <div className="flex items-center gap-1 pt-1">
          {mode === "dashboard" ? (
            <>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = event.target.files
                    ? Array.from(event.target.files)
                    : [];
                  if (files.length > 0) onAttachFiles(files);
                  event.target.value = "";
                }}
              />
              <input
                ref={pdfInputRef}
                type="file"
                accept="application/pdf"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = event.target.files
                    ? Array.from(event.target.files)
                    : [];
                  if (files.length > 0) onAttachFiles(files);
                  event.target.value = "";
                }}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy}
                    aria-label="پیوست تصویر یا PDF"
                    title="پیوست تصویر یا PDF"
                    className="rounded-full text-muted-foreground hover:text-foreground"
                  >
                    <PlusIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  side="top"
                  className="w-60 p-1.5"
                >
                  <DropdownMenuItem
                    onClick={() => imageInputRef.current?.click()}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2"
                  >
                    <span className="grid size-8 place-items-center rounded-lg bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                      <ImageIcon className="size-4" />
                    </span>
                    <span>
                      <span className="block text-xs font-semibold">
                        تصویر فاکتور / رسید
                      </span>
                      <span className="block text-[10px] text-muted-foreground">
                        JPG، PNG یا WebP — حداکثر ۵ مگابایت؛ در Media Library ذخیره می‌شود
                      </span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => pdfInputRef.current?.click()}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2"
                  >
                    <span className="grid size-8 place-items-center rounded-lg bg-red-50 dark:bg-red-500/15 text-red-600 dark:text-red-400">
                      <FileTextIcon className="size-4" />
                    </span>
                    <span>
                      <span className="block text-xs font-semibold">
                        سند PDF
                      </span>
                      <span className="block text-[10px] text-muted-foreground">
                        متن سند خوانده می‌شود — حداکثر ۱۰ مگابایت؛ فقط برای همین نوبت
                      </span>
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null}

          <AiTaskSelector
            mode={mode}
            task={task}
            customTask={customTask}
            disabled={busy}
            onSelectTask={onTaskChange}
            onCustomTask={onCustomTaskChange}
          />

          <AiAgentSelector
            mode={mode}
            agentId={agentId}
            disabled={busy}
            onSelectAgent={onAgentChange}
          />

          <AiComposerTools
            mode={mode}
            canPropose={canPropose}
            disabled={busy}
            actionsAllowed={actionsAllowed}
            onActionsAllowedChange={setActionsAllowed}
            onSelectConversation={(id) => void loadConversation(id)}
            onSelectReportPrompt={(prompt) => setInput(prompt)}
          />

          <div className="flex-1" />

          <span
            className="hidden text-[10px] text-muted-foreground/70 sm:block"
            aria-hidden="true"
          >
            {input.trim()
              ? busy
                ? "در حال پاسخ‌گویی…"
                : "Enter برای ارسال"
              : "پیوست با آیکون + یا کشیدن فایل"}
          </span>

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

      {footer}
    </div>
  );
}
