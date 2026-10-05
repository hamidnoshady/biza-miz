"use client";

/**
 * One chat bubble on the assistant's chat home (`/dashboard`), built from the
 * shared `useAiChat` core so the surface and its state can never drift.
 *
 * ChatGPT-style: the assistant speaks from the start side (the right, in
 * RTL) under a name and avatar, the user answers from the end side in a
 * filled gradient bubble, and each bubble arrives with a GSAP entrance.
 */
import { useRef } from "react";
import { AlertTriangleIcon, BotIcon, CheckIcon, CopyIcon, SquareIcon } from "lucide-react";
import { toast } from "sonner";
import { useGSAP } from "@gsap/react";
import { cn } from "@/lib/utils";
import { AiMarkdown } from "./ai-markdown";
import { AiProposalCard } from "./ai-proposal-card";
import { AiInputRequestCard } from "./ai-input-request-card";
import type { InputResponse } from "@/lib/ai-input-protocol";
import {
  animateBubbleIn,
  animateTypingDots,
  reducedMotion,
} from "./chat-animations";
import type { AiChatMessage, AiMessageStatus } from "./use-ai-chat";

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} بایت`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} کیلوبایت`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} مگابایت`;
}

/** Three dots, not a sentence — a chat says "typing", it does not narrate. */
export function TypingDots() {
  const ref = useRef<HTMLSpanElement>(null);
  useGSAP(
    () => {
      if (ref.current) animateTypingDots(ref.current);
    },
    { scope: ref },
  );
  return (
    <span
      ref={ref}
      className="inline-flex items-center gap-1 py-1"
      aria-label="در حال نوشتن"
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          data-typing-dot
          className="size-1.5 rounded-full bg-current opacity-60"
          style={reducedMotion() ? undefined : { animation: "none" }}
        />
      ))}
    </span>
  );
}

/**
 * Issue #812 §19 — how an unfinished reply is labelled. A stream that ended
 * without its terminal `done` event, or that the member stopped, keeps whatever
 * text arrived and is visibly marked rather than being passed off as a normal
 * complete answer. `undefined` (an older transcript) reads as complete.
 */
const STATUS_LABELS: Partial<Record<AiMessageStatus, { text: string; className: string; Icon: typeof AlertTriangleIcon }>> = {
  incomplete: {
    text: "پاسخ کامل نشد",
    className: "text-amber-700 dark:text-amber-300",
    Icon: AlertTriangleIcon,
  },
  cancelled: {
    text: "پاسخ‌گویی متوقف شد",
    className: "text-muted-foreground",
    Icon: SquareIcon,
  },
  error: {
    text: "پاسخ با خطا پایان یافت",
    className: "text-red-600 dark:text-red-400",
    Icon: AlertTriangleIcon,
  },
};

interface ChatBubbleProps {
  message: AiChatMessage;
  busy: boolean;
  canPropose: boolean;
  applyingId?: string | null;
  /** Formats a Rial cost for the footer. Defaults to Toman display. */
  formatCost?: (rial: number) => string;
  applyProposal: (message: AiChatMessage) => void;
  dismissProposal: (message: AiChatMessage) => void;
  /** Phase E — the structured input protocol's answer + dismiss handlers. */
  submitInputRequest?: (message: AiChatMessage, response: InputResponse) => void;
  dismissInputRequest?: (message: AiChatMessage) => void;
  /**
   * Phase 36 Wave 7 — «دوباره بپرس» on a cached answer. The parent builds
   * this from the user question that preceded the reply.
   */
  onAskAgain?: () => void;
}

export function ChatBubble({
  message,
  busy,
  canPropose,
  applyingId,
  formatCost,
  applyProposal,
  dismissProposal,
  submitInputRequest,
  dismissInputRequest,
  onAskAgain,
}: ChatBubbleProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const isUser = message.role === "user";
  const cost =
    formatCost ??
    ((rial: number) =>
      `${Math.round(rial / 10).toLocaleString("fa-IR")} تومان`);
  const time = message.createdAt
    ? new Date(message.createdAt).toLocaleTimeString("fa-IR", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  useGSAP(
    () => {
      if (rowRef.current) animateBubbleIn(rowRef.current);
    },
    { scope: rowRef },
  );

  async function copyContent() {
    if (!message.content) return;
    try {
      await navigator.clipboard.writeText(message.content);
      toast.success("پاسخ کپی شد.");
    } catch {
      toast.error("کپی ممکن نشد.");
    }
  }

  return (
    <div
      ref={rowRef}
      className={cn(
        "flex min-w-0 gap-2",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      {!isUser ? (
        <span
          aria-hidden="true"
          className={cn(
            "mt-6 grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground ring-1 ring-primary/20",
            busy && "animate-pulse",
          )}
        >
          <BotIcon className="size-4" />
        </span>
      ) : null}

      <div
        className={cn(
          "group min-w-0 space-y-1.5",
          isUser ? "max-w-[85%]" : "max-w-[82%]",
        )}
      >
        {!isUser ? (
          <div className="flex items-center gap-2 px-1">
            <span className="text-[11px] font-semibold text-foreground/80">
              دستیار هوشمند
            </span>
            {time ? (
              <span className="text-[10px] text-muted-foreground">{time}</span>
            ) : null}
          </div>
        ) : null}

        <div
          className={cn(
            "min-w-0 overflow-hidden text-sm leading-7 shadow-[0_1px_2px_rgb(41_37_36/0.04)]",
            isUser
              ? "rounded-2xl rounded-tl-md bg-primary px-4 py-2.5 text-primary-foreground"
              : "rounded-2xl rounded-tr-md border border-border/70 bg-card px-4 py-2.5 text-foreground",
          )}
        >
          {isUser ? (
            <>
              {message.attachments?.length ? (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {message.attachments.map((attachment) =>
                    attachment.kind === "image" ? (
                      <img
                        key={attachment.id}
                        src={attachment.dataUrl}
                        alt={attachment.name}
                        className="h-20 w-auto max-w-full rounded-xl border border-white/30 object-cover"
                      />
                    ) : (
                      <span
                        key={attachment.id}
                        className="flex max-w-full items-center gap-1.5 rounded-xl bg-white/15 px-2 py-1 text-[11px] ring-1 ring-white/25"
                      >
                        <span className="font-black">PDF</span>
                        <span className="truncate">{attachment.name}</span>
                      </span>
                    ),
                  )}
                </div>
              ) : null}
              <span className="whitespace-pre-wrap break-words">
                {message.content}
              </span>
            </>
          ) : message.content ? (
            <AiMarkdown content={message.content} />
          ) : (
            <TypingDots />
          )}
        </div>

        {/* The charge, after the fact and in passing — never a gate in front
            of the reply. See sendMessage in use-ai-chat.ts. */}
        {!isUser &&
        typeof message.costRial === "number" &&
        message.costRial > 0 ? (
          <p className="px-1 text-[10px] text-muted-foreground">
            هزینهٔ این پاسخ: {cost(message.costRial)}
          </p>
        ) : null}

        {/* Issue #812 §19 — an unfinished reply says so, right under the text. */}
        {!isUser && message.status && STATUS_LABELS[message.status] ? (
          <p
            className={cn(
              "flex items-center gap-1 px-1 text-[10px]",
              STATUS_LABELS[message.status]!.className,
            )}
          >
            {(() => {
              const { Icon } = STATUS_LABELS[message.status]!;
              return <Icon className="size-3" aria-hidden />;
            })()}
            {STATUS_LABELS[message.status]!.text}
          </p>
        ) : null}

        {/* Phase 36 Wave 7 — a cached answer is labelled, never passed off
            as fresh, and always comes with a way to ask for a real one. */}
        {!isUser && message.cacheNotice ? (
          <p className="flex flex-wrap items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
            <span>{message.cacheNotice}</span>
            {onAskAgain ? (
              <button
                type="button"
                className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] text-foreground/80 transition-colors hover:bg-muted disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
                disabled={busy}
                onClick={onAskAgain}
              >
                دوباره بپرس
              </button>
            ) : null}
          </p>
        ) : null}

        {!isUser && message.content && !busy ? (
          <div className="flex items-center gap-1 px-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              onClick={() => void copyContent()}
              aria-label="کپی پاسخ"
              title="کپی پاسخ"
              className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
            >
              <CopyIcon className="size-3.5" />
            </button>
            {message.applied ? (
              <span className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                <CheckIcon className="size-3" /> انجام شد
              </span>
            ) : null}
          </div>
        ) : null}

        {isUser && time ? (
          <p className="px-1 text-start text-[10px] text-muted-foreground">
            {time}
          </p>
        ) : null}

        {canPropose && message.proposal ? (
          <AiProposalCard
            proposal={message.proposal}
            applied={message.applied}
            status={message.proposalStatus}
            applying={applyingId === message.id}
            onApply={() => void applyProposal(message)}
            onDismiss={() => dismissProposal(message)}
          />
        ) : null}

        {!isUser && message.inputRequest ? (
          <AiInputRequestCard
            spec={message.inputRequest.spec}
            answered={message.inputRequest.answered}
            dismissed={message.inputRequest.dismissed}
            busy={busy}
            onSubmit={(response) => submitInputRequest?.(message, response)}
            onDismiss={() => dismissInputRequest?.(message)}
          />
        ) : null}
      </div>
    </div>
  );
}
