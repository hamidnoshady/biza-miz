"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpIcon,
  BrainCircuitIcon,
  SparklesIcon,
  SquareIcon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AI_CHAT_MODES, type AiRuntimeMode } from "@/lib/ai-runtime-modes-shared";
import {
  readPlatformAiStream,
  type PlatformAiDiagnostics,
  type PlatformAiStreamEvent,
} from "./platform-ai-stream";

type TurnStatus = "streaming" | "complete" | "cancelled" | "incomplete" | "error";
type Turn = {
  role: "user" | "assistant";
  content: string;
  status?: TurnStatus;
  diagnostics?: PlatformAiDiagnostics;
};

interface PlatformAiSession {
  mode: AiRuntimeMode;
  setMode: (mode: AiRuntimeMode) => void;
  text: string;
  setText: (text: string) => void;
  turns: Turn[];
  busy: boolean;
  error: string;
  model: string;
  /** ESH-184 — health tools are never requested unless this is explicitly on. */
  tools: boolean;
  setTools: (tools: boolean) => void;
  send: () => Promise<void>;
  stop: () => void;
  reset: () => void;
}
const Ctx = createContext<PlatformAiSession | null>(null);
const LABELS = { auto: "خودکار", instant: "سریع", thinking: "تفکر عمیق" } as const;
const ICONS = { auto: SparklesIcon, instant: ZapIcon, thinking: BrainCircuitIcon } as const;
const STATUS_LABELS: Record<TurnStatus, string> = {
  streaming: "در حال دریافت",
  complete: "",
  cancelled: "لغو شد",
  incomplete: "ناقص",
  error: "خطا",
};
const ERROR_TEXT = "پاسخ مدل دریافت نشد. حالت و تنظیمات مدل را در کنترل‌پلین هوش مصنوعی بررسی کنید.";

function faNumber(value: number, maximumFractionDigits = 0): string {
  return value.toLocaleString("fa-IR", { maximumFractionDigits });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function promptVersions(value: unknown): PlatformAiDiagnostics["promptVersions"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  return {
    base: numberValue(row.base),
    mode: numberValue(row.mode),
  };
}

/** One platform-only in-memory chat across all Superadmin routes; no tenant state. */
export function PlatformAiChatProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AiRuntimeMode>("auto");
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [model, setModel] = useState("");
  const [tools, setToolsState] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);

  function updateReply(update: (turn: Turn) => Turn) {
    setTurns((current) => {
      const index = current.length - 1;
      if (index < 0 || current[index].role !== "assistant") return current;
      return [...current.slice(0, index), update(current[index])];
    });
  }

  function setTools(value: boolean) {
    setToolsState(value);
  }

  async function send() {
    const message = text.trim();
    if (!message || requestRef.current) return;
    const history = turns
      .slice(-6)
      .filter((turn) => turn.content.trim())
      .map(({ role, content }) => ({ role, content: content.slice(0, 1800) }));
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    setError("");
    setTurns((current) => [
      ...current.slice(-39),
      { role: "user", content: message },
      { role: "assistant", content: "", status: "streaming" },
    ]);

    const isCurrent = () => !controller.signal.aborted && requestRef.current === controller;
    const handleEvent = ({ event, data }: PlatformAiStreamEvent): boolean => {
      if (!isCurrent()) return true;
      if (event === "start") {
        const requestId = stringValue(data.requestId);
        const modelAlias = stringValue(data.modelAlias);
        const authorizedTools = Array.isArray(data.tools)
          ? data.tools.filter((name): name is string => typeof name === "string")
          : [];
        if (modelAlias) setModel(modelAlias);
        updateReply((turn) => ({
          ...turn,
          status: "streaming",
          diagnostics: {
            ...turn.diagnostics,
            requestId: requestId ?? turn.diagnostics?.requestId,
            mode: stringValue(data.mode) ?? turn.diagnostics?.mode,
            modelAlias: modelAlias ?? turn.diagnostics?.modelAlias,
            promptVersions: promptVersions(data.promptVersions) ?? turn.diagnostics?.promptVersions,
            authorizedTools,
          },
        }));
        return false;
      }
      if (event === "delta") {
        const content = stringValue(data.content);
        if (!content) return false;
        updateReply((turn) => ({ ...turn, content: turn.content + content, status: "streaming" }));
        return false;
      }
      if (event === "tool") {
        const name = stringValue(data.name);
        if (!name) return false;
        updateReply((turn) => ({
          ...turn,
          diagnostics: {
            ...turn.diagnostics,
            toolGrants: [...(turn.diagnostics?.toolGrants ?? []), { name, allowed: data.allowed === true }],
          },
        }));
        return false;
      }
      if (event === "done") {
        const answer = stringValue(data.answer);
        const modelAlias = stringValue(data.modelAlias);
        if (modelAlias) setModel(modelAlias);
        setText("");
        updateReply((turn) => ({
          ...turn,
          content: answer ?? turn.content,
          status: "complete",
          diagnostics: {
            ...turn.diagnostics,
            requestId: stringValue(data.requestId) ?? turn.diagnostics?.requestId,
            modelAlias: modelAlias ?? turn.diagnostics?.modelAlias,
            promptVersions: promptVersions(data.promptVersions) ?? turn.diagnostics?.promptVersions,
            tokens: numberValue(data.tokens),
            costUsd: numberValue(data.costUsd),
            toolsUsed: Array.isArray(data.toolsUsed)
              ? data.toolsUsed.filter((name): name is string => typeof name === "string")
              : [],
            latencyMs: numberValue(data.latencyMs),
            finishReason: stringValue(data.finishReason),
          },
        }));
        return true;
      }
      if (event === "error") {
        const code = stringValue(data.error) ?? "provider_failed";
        const message = stringValue(data.message) ?? ERROR_TEXT;
        const cancelled = code === "cancelled";
        updateReply((turn) => ({
          ...turn,
          content: turn.content ? `${turn.content}\n\n⚠️ ${message}` : `⚠️ ${message}`,
          status: cancelled ? "cancelled" : "error",
          diagnostics: {
            ...turn.diagnostics,
            requestId: stringValue(data.requestId) ?? turn.diagnostics?.requestId,
          },
        }));
        if (!cancelled) setError(ERROR_TEXT);
        return true;
      }
      return false;
    };

    try {
      const response = await fetch("/api/platform/ai/playground", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        signal: controller.signal,
        body: JSON.stringify({
          message,
          mode,
          history,
          // Explicit grant: no tool is offered unless the operator turned this on.
          ...(tools ? { tools: true } : {}),
        }),
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(failure.error ?? "provider_failed");
      }
      if (!response.body) throw new Error("stream_unavailable");
      const { terminal } = await readPlatformAiStream(response.body, handleEvent);
      if (!terminal && isCurrent()) {
        updateReply((turn) => ({
          ...turn,
          content: turn.content || "⚠️ پاسخ دستیار کامل نشد. دوباره تلاش کنید.",
          status: "incomplete",
        }));
      }
    } catch (caught) {
      if (controller.signal.aborted || (caught instanceof DOMException && caught.name === "AbortError")) {
        // ESH-184 — a stopped turn keeps what already arrived, labelled.
        updateReply((turn) => ({
          ...turn,
          content: turn.content || "پاسخ‌گویی متوقف شد.",
          status: "cancelled",
        }));
      } else {
        setError(ERROR_TEXT);
        updateReply((turn) => ({
          ...turn,
          content: turn.content ? `${turn.content}\n\n⚠️ ${ERROR_TEXT}` : `⚠️ ${ERROR_TEXT}`,
          status: "error",
        }));
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setBusy(false);
      }
    }
  }

  function stop() {
    requestRef.current?.abort();
  }

  function reset() {
    requestRef.current?.abort();
    requestRef.current = null;
    setBusy(false);
    setTurns([]);
    setText("");
    setError("");
    setModel("");
  }

  return <Ctx.Provider value={{ mode, setMode, text, setText, turns, busy, error, model, tools, setTools, send, stop, reset }}>
    {children}
  </Ctx.Provider>;
}

export function usePlatformAiChat() {
  const value = useContext(Ctx);
  if (!value) throw new Error("PlatformAiChatProvider missing");
  return value;
}

function TurnDiagnostics({ diagnostics }: { diagnostics: PlatformAiDiagnostics }) {
  const versions = diagnostics.promptVersions;
  const tools = diagnostics.toolsUsed ?? [];
  const grants = diagnostics.toolGrants ?? [];
  return <details dir="rtl" className="mt-2 rounded-lg border border-border bg-card/70 px-2 py-1.5 text-xs">
    <summary className="cursor-pointer select-none text-muted-foreground">جزئیات فنی پاسخ</summary>
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {diagnostics.requestId ? <>
        <dt className="text-muted-foreground">شناسهٔ درخواست</dt>
        <dd dir="ltr" className="truncate text-left font-mono text-foreground">{diagnostics.requestId}</dd>
      </> : null}
      {diagnostics.modelAlias ? <>
        <dt className="text-muted-foreground">مدل LiteLLM</dt>
        <dd dir="ltr" className="truncate text-left font-mono text-foreground">{diagnostics.modelAlias}</dd>
      </> : null}
      {versions ? <>
        <dt className="text-muted-foreground">نسخهٔ پرامپت (پایه / حالت)</dt>
        <dd className="text-foreground">
          {versions.base === null ? "—" : faNumber(versions.base)} / {versions.mode === null ? "—" : faNumber(versions.mode)}
        </dd>
      </> : null}
      {diagnostics.tokens != null ? <>
        <dt className="text-muted-foreground">توکن‌ها</dt>
        <dd className="text-foreground">{faNumber(diagnostics.tokens)}</dd>
      </> : null}
      {diagnostics.costUsd != null ? <>
        <dt className="text-muted-foreground">هزینهٔ گزارش‌شده (دلار)</dt>
        <dd className="text-foreground">{faNumber(diagnostics.costUsd, 6)}</dd>
      </> : null}
      {diagnostics.latencyMs != null ? <>
        <dt className="text-muted-foreground">زمان پاسخ</dt>
        <dd className="text-foreground">{faNumber(diagnostics.latencyMs)} میلی‌ثانیه</dd>
      </> : null}
      {diagnostics.authorizedTools ? <>
        <dt className="text-muted-foreground">ابزارهای مجاز این درخواست</dt>
        <dd dir="ltr" className="break-all text-left font-mono text-foreground">
          {diagnostics.authorizedTools.length ? diagnostics.authorizedTools.join(", ") : "—"}
        </dd>
      </> : null}
      <dt className="text-muted-foreground">ابزارهای اجراشده</dt>
      <dd dir="ltr" className="break-all text-left font-mono text-foreground">
        {tools.length ? tools.join(", ") : "—"}
      </dd>
      {grants.length ? <>
        <dt className="text-muted-foreground">نتیجهٔ اجرای ابزار</dt>
        <dd className="space-y-0.5 text-foreground">
          {grants.map((grant, index) => <span key={`${grant.name}-${index}`} className="block">
            <span dir="ltr" className="font-mono">{grant.name}</span>{" · "}
            {grant.allowed ? "مجاز" : "رد شد"}
          </span>)}
        </dd>
      </> : null}
      {diagnostics.finishReason ? <>
        <dt className="text-muted-foreground">وضعیت پایان</dt>
        <dd dir="ltr" className="text-left font-mono text-foreground">{diagnostics.finishReason}</dd>
      </> : null}
    </dl>
  </details>;
}

export function PlatformAiChatPanel({ compact = false }: { compact?: boolean }) {
  const chat = usePlatformAiChat();
  return <section dir="rtl" className="flex min-h-0 min-w-0 flex-1 flex-col gap-3" aria-label="گفتگوی مدیر پلتفرم">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-muted-foreground">
        مدل و پرامپت منتشرشده • فقط‌خواندنی • ابزارهای سلامت پلتفرم، بدون دسترسی به داده‌های مالی تنانت‌ها
      </p>
      <div className="flex items-center gap-1">
        <Button size="sm" variant={chat.tools ? "secondary" : "ghost"} disabled={chat.busy}
          aria-pressed={chat.tools} onClick={() => chat.setTools(!chat.tools)}
          title={chat.tools ? "ابزارهای سلامت پلتفرم برای این درخواست مجاز است" : "بدون ابزار؛ فقط پاسخ متنی"}>
          <WrenchIcon className="size-4" />
          ابزارهای سلامت
        </Button>
        <Button size="sm" variant="ghost" onClick={chat.reset} disabled={chat.busy}>گفتگوی جدید</Button>
      </div>
    </div>
    <div role="log" aria-live="polite" aria-label="پاسخ‌های دستیار"
      className={`flex min-h-40 flex-1 flex-col gap-2 overflow-y-auto rounded-xl border border-border bg-muted/10 p-3 ${compact ? "max-h-[55vh]" : "max-h-[65vh]"}`}>
      {chat.turns.length === 0 ? <p className="text-sm text-muted-foreground">سؤالی بنویسید تا مدل انتخاب‌شده و نسخهٔ منتشرشدهٔ پرامپت آزمایش شود.</p> : null}
      {chat.turns.map((turn, index) => <div key={index}
        className={`max-w-[94%] whitespace-pre-wrap break-words rounded-xl border border-border p-3 text-sm ${turn.role === "user" ? "self-start bg-card" : "self-end bg-muted"}`}>
        <div dir="auto">{turn.content}</div>
        {turn.role === "assistant" && turn.status && turn.status !== "complete" ? <p
          className={`mt-1 text-xs ${turn.status === "error" ? "text-destructive" : "text-muted-foreground"}`}>
          {STATUS_LABELS[turn.status]}
        </p> : null}
        {turn.role === "assistant" && turn.diagnostics ? <TurnDiagnostics diagnostics={turn.diagnostics} /> : null}
      </div>)}
    </div>
    {chat.busy ? <p role="status" className="text-xs text-muted-foreground">در حال دریافت پاسخ از LiteLLM…</p> : null}
    {chat.model ? <p className="text-xs text-muted-foreground" dir="ltr">LiteLLM alias: {chat.model}</p> : null}
    {chat.error ? <p role="alert" className="text-sm text-destructive">{chat.error}</p> : null}
    <div className="shrink-0 rounded-xl border border-border bg-card p-2">
      <textarea rows={compact ? 2 : 3} maxLength={3000} value={chat.text}
        aria-label="پیام آزمایشی" placeholder="پیام خود را بنویسید..."
        disabled={chat.busy} onChange={(e) => chat.setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault(); void chat.send();
          }
        }}
        className="w-full resize-none bg-transparent px-2 py-1 text-sm outline-none"
      />
      <div className="flex items-center justify-end gap-1" dir="rtl">
        {AI_CHAT_MODES.map((key) => {
          const Icon = ICONS[key];
          return <Button key={key} size="icon-sm" variant={chat.mode === key ? "secondary" : "ghost"}
            disabled={chat.busy} aria-label={`حالت پاسخ‌گویی: ${LABELS[key]}`}
            aria-pressed={chat.mode === key} title={LABELS[key]} onClick={() => chat.setMode(key)}>
            <Icon className="size-4" />
          </Button>;
        })}
        {chat.busy
          ? <Button size="icon-sm" variant="secondary" aria-label="توقف پاسخ" title="توقف پاسخ"
              onClick={chat.stop}><SquareIcon className="size-4" /></Button>
          : <Button size="icon-sm" disabled={!chat.text.trim()} onClick={() => void chat.send()}
              aria-label="ارسال پیام آزمایشی"><ArrowUpIcon className="size-4" /></Button>}
      </div>
    </div>
  </section>;
}
