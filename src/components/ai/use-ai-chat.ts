"use client";

/**
 * Shared chat core behind the assistant's one chat home (`/dashboard`,
 * Phase 36b/Wave 2 issue #142): streaming, cost display, propose→confirm and
 * conversation persistence (Wave 1, issue #141) all live here once, so the
 * page and its management panel can never drift.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ACTION_CATALOG, type ProposedAction } from "@/lib/ai";
import type { InputRequestSpec, InputResponse } from "@/lib/ai-input-protocol";
import {
  MAX_ATTACHMENT_IMAGE_BYTES,
  MAX_ATTACHMENT_PDF_BYTES,
  MAX_ATTACHMENT_TEXT_BYTES,
  MAX_ATTACHMENTS,
} from "@/lib/ai-attachment-limits";
import type { AiTaskId } from "@/lib/ai-tasks";
import {
  AI_RUNTIME_MODES,
  normalizeAiRuntimeMode,
  type AiRuntimeMode,
} from "@/lib/ai-runtime-modes-shared";
import { applyProposalRequest } from "./apply-proposal";
import { canGrantAiSessionConsent } from "@/lib/ai-session-consent-shared";
import { guardedNavigate } from "@/components/navigation/unsaved-changes-guard";
import { AI_GUIDED_TOUR_EVENT } from "@/lib/ai-guided-tour-events";
import { parseReceiptImageDataUrl } from "@/lib/ai-receipt";

export type AssistantMode = "wizard" | "dashboard" | "floor";
export type AiAppFocus = "all" | "accounting" | "growth" | "crm" | "website" | "workspace";

export const AI_APP_FOCUSES: readonly AiAppFocus[] = [
  "all",
  "workspace",
  "accounting",
  "crm",
  "growth",
  "website",
] as const;

export function normalizeAiAppFocus(
  raw: unknown,
  allowed?: readonly AiAppFocus[],
): AiAppFocus {
  if (typeof raw !== "string") return "all";
  const trimmed = raw.trim().toLowerCase() as AiAppFocus;
  if (!(AI_APP_FOCUSES as readonly string[]).includes(trimmed)) return "all";
  if (allowed && allowed.length > 0 && !allowed.includes(trimmed)) return "all";
  return trimmed;
}

/** Phase E — a typed input request attached to an assistant turn. */
interface AiInputRequestState {
  /** The persisted request id; null when the turn was not persisted. */
  id: string | null;
  spec: InputRequestSpec;
  /** Set once the user answered, so the card locks and shows the answer. */
  answered?: boolean;
  /** Set once the user dismissed the card without answering. */
  dismissed?: boolean;
}

/**
 * Issue #812 §19 — the explicit lifecycle of an assistant reply. A stream that
 * ends without its terminal `done` event used to leave partial text on screen
 * looking like a finished answer. Every reply now carries one of these, and a
 * partial one is visibly marked instead of silently passed off as complete.
 */
export type AiMessageStatus = "streaming" | "complete" | "cancelled" | "incomplete" | "error";

export interface AiChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /**
   * Set for assistant replies only. `undefined` on a message restored from an
   * older transcript that predates the field — the UI treats that as complete.
   */
  status?: AiMessageStatus;
  proposal?: ProposedAction | null;
  /** Phase E — a structured input request the assistant raised this turn. */
  inputRequest?: AiInputRequestState | null;
  auditId?: string | null;
  proposalStatus?: "proposed" | "processing" | "applied" | "failed" | "dismissed" | "reverted" | null;
  applied?: boolean;
  /** Actual Rial charged for this turn, shown quietly once it finishes. */
  costRial?: number | null;
  /** Client-side send time, shown as a small clock under the bubble. */
  createdAt?: number;
  /** Snapshot of the attachments this turn carried (rendered in the bubble). */
  attachments?: ChatAttachment[];
}

/**
 * Wave 5 / Issue #759 — files attached to the next turn only in the browser.
 * Images are copied to the tenant Media Library by the server with provenance;
 * PDFs are extracted for this turn and are not persisted.
 */
export type AiAttachmentOrigin = import("@/lib/ai-attachment-source").AiAttachmentSource;

export interface ChatAttachment {
  id: string;
  kind: "image" | "pdf" | "text";
  dataUrl: string;
  name: string;
  sizeBytes: number;
  /** Display/audit provenance. File bytes are verified independently by server. */
  source?: AiAttachmentOrigin;
}

/** One client-side id per message/attachment — never persisted as such. */
const uid = (): string => crypto.randomUUID();

const CHAT_ERROR: Record<string, string> = {
  ai_credit_required:
    "اعتبار هوش مصنوعی کافی نیست. از صفحهٔ اعتبار و شارژ، کیف پول کسب‌وکار را شارژ کنید.",
  ai_unavailable: "سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است.",
  feature_disabled: "دستیار هوشمند برای این کسب‌وکار فعال نیست.",
  ai_auth: "اتصال سراسری سرویس هوش مصنوعی نیاز به بررسی مدیر پلتفرم دارد.",
  ai_timeout: "پاسخ سرویس دیر رسید. دوباره تلاش کنید.",
  ai_network: "اتصال به سرویس هوش مصنوعی برقرار نشد.",
  ai_rate_limited: "سرویس هوش مصنوعی در حال حاضر پرکاربرد است؛ کمی بعد دوباره تلاش کنید.",
  ai_provider: "درخواست توسط سرویس هوش مصنوعی رد شد. مدیر پلتفرم می‌تواند جزئیات فنی را بررسی کند.",
  empty_messages: "پیامی برای ارسال نیست.",
};

function greeting(mode: AssistantMode): string {
  if (mode === "wizard") {
    return "سلام! من دستیار راه‌اندازی هستم. بگویید کسب‌وکارتان چه ویژگی‌هایی دارد تا با هم فیلدهای هر مرحله را کامل کنیم. هر تغییری قبل از ثبت، تأیید شما را لازم دارد.";
  }
  if (mode === "floor") {
    return "سلام! می‌توانم دربارهٔ منوی شعبه، مواد اولیهٔ ثبت‌شده و پیش‌نمایش تقسیم برابر صورت‌حساب کمک کنم. هیچ تغییری ثبت نمی‌کنم؛ برای موارد حساسیت غذایی، دادهٔ ثبت‌نشده را حدس نمی‌زنم.";
  }
  return "سلام! می‌توانم گزارش‌های فروش، منو، موجودی و حسابداری را نشان دهم، وضعیت راه‌اندازی را بررسی کنم و کارهای مجاز را با تأیید شما انجام دهم. چه کمکی از من برمی‌آید؟";
}

function errorMessage(data: Record<string, unknown>): string {
  // The server's own message wins when it sent one: it is the specific,
  // curated Persian explanation (which provider status answered, what to do).
  // The table is the fallback for the failures that never reached it —
  // transport errors and bare codes.
  if (typeof data.message === "string" && data.message.trim()) return data.message;
  return CHAT_ERROR[String(data.error ?? "")] ?? "خطا در ارتباط با دستیار.";
}

interface ConversationMessagePayload {
  id: string;
  role: "user" | "assistant";
  content: string;
  proposal: ProposedAction | null;
  inputRequest?: { id: string; spec: InputRequestSpec; status: string } | null;
  auditId?: string | null;
  proposalStatus?: "proposed" | "processing" | "applied" | "failed" | "dismissed" | "reverted" | null;
}

/** Reads the `inputRequest` block off a done event or a loaded message. */
function parseInputRequestPayload(raw: unknown): AiInputRequestState | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const spec = obj.spec as InputRequestSpec | undefined;
  if (!spec || typeof spec !== "object" || typeof spec.kind !== "string") return null;
  return {
    id: typeof obj.id === "string" ? obj.id : null,
    spec,
    answered: obj.status === "answered",
    dismissed: obj.status === "cancelled",
  };
}

export interface LoadedConversationMeta {
  id: string;
  title: string | null;
  projectId: string | null;
}

export interface UseAiChatOptions {
  mode: AssistantMode;
  currentStep?: string | null;
  /** Called whenever the active conversation id changes (new turn, load, reset). */
  onConversationIdChange?: (id: string | null) => void;
  /** Called when a historical conversation finishes loading its metadata. */
  onConversationLoaded?: (meta: LoadedConversationMeta) => void;
  /**
   * Phase F — when set, a NEW conversation started from this hook is linked to
   * this project, so its turns are shaped by the project's instruction, notes
   * and memory. Ignored once a conversation already exists (resuming keeps the
   * project the conversation already carries).
   */
  projectId?: string | null;
  appFocus?: AiAppFocus;
  runtimeMode?: AiRuntimeMode;
}

export function useAiChat({
  mode,
  currentStep,
  onConversationIdChange,
  onConversationLoaded,
  projectId = null,
  appFocus = "all",
  runtimeMode: initialRuntimeMode = AI_RUNTIME_MODES[0],
}: UseAiChatOptions) {
  const router = useRouter();
  const appFocusRef = useRef<AiAppFocus>(appFocus);
  const projectIdRef = useRef<string | null>(projectId);
  const canPropose = mode === "wizard" || mode === "dashboard";
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState<string | null>(null);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [actionsAllowed, setActionsAllowed] = useState(true);
  const [task, setTask] = useState<AiTaskId>("general");
  const [customTask, setCustomTask] = useState("");
  const [runtimeMode, setRuntimeMode] = useState<AiRuntimeMode>(() => normalizeAiRuntimeMode(initialRuntimeMode));
  const abortControllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  useEffect(() => () => {
    generationRef.current += 1;
    abortControllerRef.current?.abort();
  }, []);
  const cancelledRef = useRef(false);

  /**
   * Patch one message in the thread by id — the single way this hook edits a
   * turn already on screen (streaming deltas, apply/dismiss flags, input-card
   * state), so no call site re-spells the map-and-match itself.
   */
  function editMessage(id: string, update: (message: AiChatMessage) => AiChatMessage) {
    setMessages((current) =>
      current.map((message) => (message.id === id ? update(message) : message)),
    );
  }

  /** Removes one attachment, or all of them when no id is given. */
  function clearAttachment(id?: string) {
    setAttachments((current) =>
      id ? current.filter((attachment) => attachment.id !== id) : [],
    );
  }

  function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
      reader.readAsDataURL(file);
    });
  }

  /**
   * Reads image/PDF files client-side into data URLs. Images are persisted
   * best-effort in the tenant Media Library after a successful turn; PDFs are
   * extracted for that turn only. Dashboard mode only, at most MAX_ATTACHMENTS
   * per message — each invalid file is explained, never silently dropped.
   */
  async function attachFiles(files: File[], source?: AiAttachmentOrigin) {
    if (mode !== "dashboard") return;
    const generation = generationRef.current;
    const accepted: ChatAttachment[] = [];
    for (const file of files) {
      const isImage = file.type.startsWith("image/");
      const isPdf = file.type === "application/pdf";
      const textMime = ["text/plain", "text/csv", "text/markdown"].includes(file.type) ? file.type
        : ["", "application/octet-stream", "application/vnd.ms-excel"].includes(file.type)
          ? ({ txt: "text/plain", csv: "text/csv", md: "text/markdown" } as Record<string, string>)[file.name.split(".").at(-1)?.toLowerCase() ?? ""]
          : undefined;
      const isText = !!textMime;
      if (!isImage && !isPdf && !isText) {
        toast.error(`«${file.name}» فعلاً قابل تحلیل نیست؛ تصویر JPG/PNG/WebP، PDF یا فایل متنی UTF-8/CSV انتخاب کنید. ویدئو و Office نیاز به استخراج‌گر جداگانه دارند.`);
        continue;
      }
      const limit = isImage ? MAX_ATTACHMENT_IMAGE_BYTES : isPdf ? MAX_ATTACHMENT_PDF_BYTES : MAX_ATTACHMENT_TEXT_BYTES;
      if (file.size > limit) {
        toast.error(
          isImage
            ? `«${file.name}» بزرگ‌تر از ۵ مگابایت است.`
            : isPdf ? `«${file.name}» بزرگ‌تر از ۱۰ مگابایت است.` : `«${file.name}» بزرگ‌تر از ۱ مگابایت است.`,
        );
        continue;
      }
      try {
        const dataUrl = await readAsDataUrl(isText ? new File([file], file.name, { type: textMime }) : file);
        if (isImage && !parseReceiptImageDataUrl(dataUrl)) {
          toast.error(`فرمت «${file.name}» پشتیبانی نمی‌شود.`);
          continue;
        }
        accepted.push({
          id: uid(),
          kind: isImage ? "image" : isPdf ? "pdf" : "text",
          dataUrl,
          name: file.name,
          sizeBytes: file.size,
          ...(source ? { source } : {}),
        });
      } catch {
        toast.error(`خواندن «${file.name}» ممکن نشد.`);
      }
    }
    if (accepted.length === 0) return;
    if (generationRef.current !== generation) return;
    setAttachments((current) => {
      const room = MAX_ATTACHMENTS - current.length;
      if (room <= 0) {
        toast.error(`حداکثر ${MAX_ATTACHMENTS} پیوست در هر پیام مجاز است.`);
        return current;
      }
      const taking = accepted.slice(0, room);
      if (taking.length < accepted.length) {
        toast.error(`حداکثر ${MAX_ATTACHMENTS} پیوست در هر پیام مجاز است.`);
      }
      return [...current, ...taking];
    });
  }

  function setConversation(id: string | null) {
    setConversationId(id);
    onConversationIdChange?.(id);
  }

  function ensureGreeting() {
    setMessages((current) =>
      current.length === 0
        ? [{ id: uid(), role: "assistant", content: greeting(mode), status: "complete" }]
        : current,
    );
  }

  function startNewConversation(preserveDraft = false) {
    generationRef.current += 1;
    if (abortControllerRef.current) {
      cancelGeneration();
    }
    setLoadingConversation(false);
    setBusy(false);
    setConversationTitle(null);
    setConversation(null);
    if (!preserveDraft) { setInput(""); clearAttachment(); }
    setMessages([{ id: uid(), role: "assistant", content: greeting(mode), status: "complete" }]);
  }

  /**
   * Issue #812 §17 & Issue #905 — a conversation load is generation-guarded.
   * Rapid A → B → C clicks or clicking New Chat while a load is in flight will
   * abandon the stale response rather than overwriting the current view.
   * Also reads `conversation.title` and `conversation.projectId` so active
   * project context and header title match the loaded thread.
   */
  async function loadConversation(id: string): Promise<LoadedConversationMeta | null> {
    if (abortControllerRef.current) {
      cancelGeneration();
    }
    const generation = ++generationRef.current;
    setBusy(false);
    setLoadingConversation(true);
    clearAttachment();
    try {
      const response = await fetch(`/api/ai/conversations/${id}?mode=${encodeURIComponent(mode)}`);
      const data = (await response.json().catch(() => ({}))) as {
        conversation?: {
          id?: string;
          title?: string | null;
          projectId?: string | null;
        } | null;
        messages?: ConversationMessagePayload[];
        error?: string;
      };
      if (!response.ok || !data.messages) throw new Error(data.error ?? "not_found");
      // A newer load or a new turn claimed the thread while this one was in
      // flight: drop the stale result entirely rather than overwriting it.
      if (generationRef.current !== generation) return null;
      const loadedTitle =
        typeof data.conversation?.title === "string" && data.conversation.title.trim()
          ? data.conversation.title.trim()
          : null;
      const loadedProjectId =
        typeof data.conversation?.projectId === "string" && data.conversation.projectId.trim()
          ? data.conversation.projectId.trim()
          : null;
      setMessages(
        data.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          // A transcript written before the status field existed is a finished
          // turn; only the live stream marks its own states.
          status: (message.role === "assistant" ? "complete" : undefined) as AiMessageStatus | undefined,
          proposal: canPropose ? message.proposal : null,
          auditId: message.auditId ?? null,
          proposalStatus: message.proposalStatus ?? (message.proposal ? "proposed" : null),
          applied: message.proposalStatus === "applied",
          inputRequest: parseInputRequestPayload(message.inputRequest),
        })),
      );
      setConversationTitle(loadedTitle);
      setConversation(id);
      const meta: LoadedConversationMeta = {
        id,
        title: loadedTitle,
        projectId: loadedProjectId,
      };
      onConversationLoaded?.(meta);
      return meta;
    } catch {
      // Only the load the member is still waiting on may report a failure.
      if (generationRef.current === generation) toast.error("بازکردن این مکالمه ممکن نشد.");
      return null;
    } finally {
      if (generationRef.current === generation) setLoadingConversation(false);
    }
  }

  /**
   * Sends immediately.
   *
   * This used to POST to `/api/ai/estimate` first and park the turn behind a
   * "برآورد هزینه … شروع پاسخ" card, so every single message — including
   * "سلام" — cost the user an extra round trip and an extra tap before the
   * assistant would say anything. That is not how a chat behaves, and the card
   * was not buying the safety it looked like it was: `/api/ai/chat` runs its
   * own wallet affordability gate against `config.maxTurnRial` and refuses
   * when the wallet cannot afford AI, entirely independently of this call.
   *
   * So the estimate is gone from the send path and the *actual* charge is shown
   * under the reply once the turn settles, which is both truthful and free.
   */
  async function sendMessage(textOverride?: string) {
    const text = (textOverride ?? input).trim();
    if (!text || busy) return;
    setInput("");
    await startStream(text);
  }

  /** Ask the same question again, as a brand-new turn. */
  async function askAgain(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    await startStream(question);
  }

  async function startStream(text: string) {
    if (busy) return;
    const userMsg: AiChatMessage = {
      id: uid(),
      role: "user",
      content: text,
      createdAt: Date.now(),
      attachments: attachments.length > 0 ? [...attachments] : undefined,
    };
    const replyId = uid();
    const history = [...messages, userMsg];
    setMessages([
      ...history,
      {
        id: replyId,
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        // §19 — the reply exists but is not finished until `done` arrives.
        status: "streaming",
      },
    ]);
    setBusy(true);
    const generation = ++generationRef.current;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    cancelledRef.current = false;

    function setReply(update: (current: AiChatMessage) => AiChatMessage) {
      if (generationRef.current !== generation) return;
      editMessage(replyId, update);
    }

    function receiveEvent(block: string): boolean {
      let event = "message";
      let data = "";
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) return false;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return false;
      }

      if (event === "delta" && typeof payload.content === "string") {
        setReply((current) => ({
          ...current,
          content: current.content + payload.content,
          status: "streaming",
        }));
        return false;
      }
      if (event === "reset") {
        setReply((current) => ({ ...current, content: "", status: "streaming" }));
        return false;
      }
      if (event === "done") {
        setReply((current) => ({
          ...current,
          content:
            typeof payload.content === "string"
              ? payload.content
              : current.content,
          proposal: canPropose
            ? ((payload.proposedAction as ProposedAction | null | undefined) ??
              null)
            : null,
          inputRequest: parseInputRequestPayload(payload.inputRequest),
          auditId: typeof payload.auditId === "string" ? payload.auditId : null,
          proposalStatus: payload.proposedAction ? "proposed" : null,
          costRial: typeof payload.costRial === "number" ? payload.costRial : null,
          // §19 — the terminal event, so this reply is genuinely finished.
          status: "complete",
        }));
        // A prior explicit session grant may execute ONLY the narrowly approved
        // action family, using the same audited/idempotent apply API as a click.
        const proposed = payload.proposedAction as ProposedAction | null;
        const auditId = typeof payload.auditId === "string" ? payload.auditId : null;
        if (canPropose && proposed && auditId && canGrantAiSessionConsent(proposed.type)) {
          void fetch(`/api/ai/action-consent?actionType=${encodeURIComponent(proposed.type)}&auditId=${encodeURIComponent(auditId)}`, {
            credentials: "same-origin", cache: "no-store",
          }).then(async (response) => response.ok ? response.json() : null)
            .then((consent: { allowed?: boolean } | null) => {
              if (!consent?.allowed || generationRef.current !== generation) return;
              void applyProposal({
                id: replyId, role: "assistant", content: typeof payload.content === "string" ? payload.content : "",
                proposal: proposed, auditId, proposalStatus: "proposed", status: "complete",
              }, "session");
            }).catch(() => {});
        }
        if (typeof payload.conversationId === "string")
          setConversation(payload.conversationId);
        // Tour playback never trusts tool-provided targets or selectors: the
        // current tenant authorization is rechecked by /api/ai/guided-tour.
        const requestedTour = payload.guidedTour;
        if (mode === "dashboard" && requestedTour && typeof requestedTour === "object") {
          const guideId = (requestedTour as { guideId?: unknown }).guideId;
          if (typeof guideId === "string" && guideId.length <= 80 && generationRef.current === generation) {
            window.dispatchEvent(new CustomEvent(AI_GUIDED_TOUR_EVENT, { detail: { guideId } }));
          }
        }
        // The model only chooses a registered feature id. Verify again against
        // current tenant/session permissions immediately before router navigation.
        const navigation = payload.navigation;
        if (mode === "dashboard" && navigation && typeof navigation === "object") {
          const selected = navigation as { featureId?: unknown };
          if (typeof selected.featureId === "string" && selected.featureId.length <= 160) {
            void fetch("/api/ai/navigation", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ featureId: selected.featureId }),
            })
              .then(async (response) => response.ok ? response.json() : null)
              .then((verified: { status?: string; destination?: { href?: string } } | null) => {
                if (generationRef.current !== generation || verified?.status !== "ready") return;
                const href = verified.destination?.href;
                if (typeof href === "string" && href.startsWith("/") && !href.startsWith("//")) {
                  guardedNavigate(href, () => router.push(href));
                }
              })
              .catch(() => toast.error("مقصد در حال حاضر در دسترس نیست."));
          }
        }
        return true;
      }
      if (event === "error") {
        setReply((current) => ({
          ...current,
          content: current.content ? `${current.content}\n\n⚠️ ${errorMessage(payload)}` : "⚠️ " + errorMessage(payload),
          status: "error",
        }));
        return true;
      }
      return false;
    }

    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        signal: controller.signal,
        body: JSON.stringify({
          mode,
          currentStep: currentStep ?? null,
          conversationId,
          // Only meaningful when starting a new conversation; the backend
          // ignores it for an existing one.
          projectId: conversationId ? undefined : projectIdRef.current ?? undefined,
          messages: history.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          attachments: attachments.map((attachment) => ({
            dataUrl: attachment.dataUrl,
            name: attachment.name,
            source: attachment.source,
          })),
          task,
          customTask: customTask.trim() || undefined,
          appFocus: appFocusRef.current,
          runtimeMode,
          allowActions: actionsAllowed,
        }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        throw new Error(errorMessage(data));
      }
      if (!response.body) throw new Error("پاسخ جریانی دستیار در دسترس نیست.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let complete = false;
      try {
        while (!complete) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() ?? "";
          for (const event of events) {
            if (receiveEvent(event)) {
              complete = true;
              break;
            }
          }
        }
        buffer += decoder.decode();
        if (!complete && buffer) complete = receiveEvent(buffer);
      } finally {
        reader.releaseLock();
      }
      if (!complete) {
        // §19 — the stream ended without its terminal `done` event. Whatever
        // arrived is real and worth keeping, but it is NOT a finished answer
        // and must never be presented as one.
        setReply((current) => ({
          ...current,
          // §19 — whatever arrived is kept. A reply with no text at all gets a
          // line saying so, because an empty bubble reads as a rendering bug
          // rather than as a turn that did not finish.
          content: current.content || "⚠️ پاسخ دستیار کامل نشد. دوباره تلاش کنید.",
          status: "incomplete",
        }));
      }
    } catch (error) {
      if (cancelledRef.current || (error instanceof DOMException && error.name === "AbortError")) {
        // §19 — the member stopped it. Partial text is kept and labelled
        // «cancelled» rather than being replaced or made to look complete.
        setReply((current) => ({
          ...current,
          content: current.content || "پاسخ‌گویی متوقف شد.",
          status: "cancelled",
        }));
      } else {
        setReply((current) => ({
          ...current,
          content:
            "⚠️ " +
            (error instanceof Error
              ? error.message
              : "اتصال برقرار نشد. دوباره تلاش کنید."),
          status: "error",
        }));
      }
    } finally {
      // §17 — an OLD stream must never clear state belonging to a newer one.
      // `setBusy(false)` and `clearAttachment()` used to run unconditionally,
      // so a stale stream finishing after the member had already started a new
      // turn would un-busy the new turn and wipe its attachments. Both are now
      // gated on this stream still being the active generation.
      const stillActive = generationRef.current === generation;
      if (stillActive) {
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
        setBusy(false);
        clearAttachment();
      }
    }
  }

  function cancelGeneration() {
    if (!abortControllerRef.current) return;
    cancelledRef.current = true;
    abortControllerRef.current.abort();
  }

  async function finishAudit(
    id: string,
    status: "applied" | "failed" | "dismissed",
    result?: Record<string, unknown>,
  ) {
    const response = await fetch("/api/ai/action-audit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status, result }),
    });
    if (!response.ok) throw new Error("audit_update_failed");
  }

  async function allowSessionProposal(message: AiChatMessage) {
    const auditId = message.auditId;
    if (!auditId || !canGrantAiSessionConsent(message.proposal?.type)) return;
    try {
      const response = await fetch("/api/ai/action-consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auditId }),
      });
      if (!response.ok) {
        toast.error("مجوز این نشست ثبت نشد؛ برای اجرای این پیشنهاد فقط این بار تأیید کنید.");
        return;
      }
      toast.success("اجازهٔ تغییر وضعیت همین وظیفه برای این نشست، حداکثر دو ساعت ثبت شد.");
      await applyProposal(message);
    } catch {
      toast.error("ثبت اجازهٔ نشست ناموفق بود.");
    }
  }

  async function revokeSessionProposal(message: AiChatMessage) {
    const actionType = message.proposal?.type;
    if (!canGrantAiSessionConsent(actionType)) return;
    try {
      const response = await fetch("/api/ai/action-consent", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionType }),
      });
      if (!response.ok) throw new Error("revoke_failed");
      toast.success("اجازه‌های تغییر وضعیت وظیفه در این نشست لغو شد.");
    } catch { toast.error("لغو اجازهٔ نشست انجام نشد؛ دوباره تلاش کنید."); }
  }

  async function applyProposal(message: AiChatMessage, approval?: "session") {
    if (!canPropose) return;
    const proposal = message.proposal;
    if (!proposal) return;
    const meta = ACTION_CATALOG[proposal.type];
    if (!meta) return;
    setApplyingId(message.id);
    try {
      const outcome = await applyProposalRequest(proposal, message.auditId, approval);
      if (!outcome.ok) {
        if (outcome.error === "missing_param") {
          toast.error(outcome.detail);
          return;
        }
        // Current proposals are transitioned by the server-owned apply route.
        // A legacy card without a link has no safe mutation path and is only
        // shown for backwards compatibility.
        toast.error(`ثبت انجام نشد. ${outcome.detail}`.trim());
        return;
      }

      // The proposal route has already atomically claimed and finalized the
      // audit row. Do not issue a second status mutation from the browser.
      const auditUpdated = Boolean(message.auditId);
      editMessage(message.id, (item) => ({
        ...item,
        applied: true,
        proposalStatus: "applied",
      }));
      toast.success(
        auditUpdated
          ? `${meta.label} انجام شد.`
          : `${meta.label} انجام شد؛ اما ثبت نتیجه در گزارش ممیزی ممکن نشد.`,
      );
      router.refresh();
      if (mode === "wizard" && meta.wizardStep) {
        setTimeout(() => router.push("/setup"), 400);
      }
    } catch {
      toast.error("خطای شبکه هنگام ثبت.");
    } finally {
      setApplyingId(null);
    }
  }

  async function dismissProposal(message: AiChatMessage) {
    if (message.proposalStatus && message.proposalStatus !== "proposed") return;
    try {
      if (message.auditId) await finishAudit(message.auditId, "dismissed");
      editMessage(message.id, (item) => ({
        ...item,
        proposalStatus: "dismissed",
      }));
    } catch {
      // Keep the card executable-looking until the server confirms dismissal;
      // otherwise a transient network error would create a false local state.
      toast.error("رد پیشنهاد ثبت نشد. دوباره تلاش کنید.");
    }
  }

  /**
   * Phase E — the user answered a structured input card. The response is
   * submitted to be re-validated against the stored spec; on success the card
   * locks and the returned plain-text message (labels, not ids) is sent as the
   * next chat turn, so the model reads exactly what the user saw. The card is
   * marked answered optimistically and rolled back if the submit fails.
   */
  async function submitInputRequest(message: AiChatMessage, response: InputResponse) {
    const request = message.inputRequest;
    if (!request || request.answered || request.dismissed || busy) return;
    if (!request.id || !conversationId) {
      toast.error("این درخواست دیگر در دسترس نیست.");
      return;
    }
    editMessage(message.id, (item) =>
      item.inputRequest ? { ...item, inputRequest: { ...item.inputRequest, answered: true } } : item,
    );
    try {
      const res = await fetch(
        `/api/ai/conversations/${conversationId}/input-requests/${request.id}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ response }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        modelMessage?: string;
        error?: string;
      };
      if (!res.ok || !data.modelMessage) {
        throw new Error(data.error ?? "submit_failed");
      }
      await startStream(data.modelMessage);
    } catch (error) {
      // Roll the card back so the user can try again.
      editMessage(message.id, (item) =>
        item.inputRequest ? { ...item, inputRequest: { ...item.inputRequest, answered: false } } : item,
      );
      toast.error(
        error instanceof Error && error.message === "already_answered"
          ? "به این پرسش قبلاً پاسخ داده شده است."
          : "ثبت پاسخ ممکن نشد. دوباره تلاش کنید.",
      );
    }
  }

  /** Dismiss an input card without answering it. */
  function dismissInputRequest(message: AiChatMessage) {
    const request = message.inputRequest;
    if (!request) return;
    if (request.id && conversationId) {
      void fetch(
        `/api/ai/conversations/${conversationId}/input-requests/${request.id}`,
        { method: "DELETE" },
      ).catch(() => {});
    }
    editMessage(message.id, (item) =>
      item.inputRequest ? { ...item, inputRequest: { ...item.inputRequest, dismissed: true } } : item,
    );
  }

  return {
    resetAccount: () => {
      startNewConversation();
      appFocusRef.current = "all";
      projectIdRef.current = null;
      setTask("general"); setCustomTask(""); setRuntimeMode("auto"); setActionsAllowed(true);
    },
    canPropose,
    messages,
    input,
    setInput,
    busy,
    applyingId,
    conversationId,
    conversationTitle,
    setConversationTitle,
    loadingConversation,
    attachments,
    attachFiles,
    clearAttachment,
    actionsAllowed,
    setActionsAllowed,
    setRequestAppFocus: (next: AiAppFocus) => { appFocusRef.current = next; },
    setRequestProjectId: (next: string | null) => { projectIdRef.current = next; },
    task,
    setTask,
    customTask,
    setCustomTask,
    runtimeMode,
    setRuntimeMode,
    ensureGreeting,
    startNewConversation,
    loadConversation,
    sendMessage,
    cancelGeneration,
    askAgain,
    applyProposal,
    allowSessionProposal,
    revokeSessionProposal,
    dismissProposal,
    submitInputRequest,
    dismissInputRequest,
  };
}
