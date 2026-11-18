"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpIcon, BrainCircuitIcon, SquareIcon, SparklesIcon, ZapIcon } from "lucide-react";
import { AiMarkdown } from "@/components/ai/ai-markdown";
import { Button } from "@/components/ui/button";
import { AI_CHAT_MODES, type AiRuntimeMode } from "@/lib/ai-runtime-modes-shared";
import { errorMessage } from "@/app/platform/ui";

type Turn = { role: "user" | "assistant"; content: string };
type DraftTest = { id: string; mode: AiRuntimeMode };
type Diagnostics = {
  requestId: string;
  modelAlias: string;
  promptVersions: { base: number | null; mode: number | null };
  draftScope?: string | null;
  draftVersion?: number | null;
  durationMs?: number;
  tokens?: number | null;
  toolResults?: { name: string; allowed: boolean; durationMs: number }[];
};
interface PlatformAiSession {
  mode: AiRuntimeMode;
  setMode: (mode: AiRuntimeMode) => void;
  text: string;
  setText: (text: string) => void;
  turns: Turn[];
  pending: Turn[];
  busy: boolean;
  error: string;
  diagnostics: Diagnostics | null;
  tools: boolean;
  setTools: (enabled: boolean) => void;
  draftTest: boolean;
  send: () => Promise<void>;
  stop: () => void;
  reset: () => void;
}
const Ctx = createContext<PlatformAiSession | null>(null);
const LABELS = { auto: "خودکار", instant: "سریع", thinking: "تفکر عمیق" } as const;
const ICONS = { auto: SparklesIcon, instant: ZapIcon, thinking: BrainCircuitIcon } as const;
const STREAM_ERRORS: Record<string, string> = {
  model_unavailable: "مدل در تنظیمات فعال یا در دسترس نیست.",
  provider_auth: "درگاه مدل درخواست را رد کرد. اتصال LiteLLM را بررسی کنید.",
  provider_rate_limited: "درگاه مدل به محدودیت درخواست رسیده است. کمی بعد دوباره ارسال کنید.",
  provider_timeout: "زمان پاسخ مدل به پایان رسید.",
  provider_failed: "دریافت پاسخ مدل ممکن نشد. دوباره تلاش کنید.",
  request_cancelled: "تولید پاسخ متوقف شد.",
  stream_interrupted: "پاسخ کامل نرسید. می‌توانید پیام را دوباره ارسال کنید.",
  invalid_provider_reply: "مدل پاسخ قابل‌نمایشی برنگرداند.",
  invalid_draft_test: "این پیش‌نویس دیگر برای حالت انتخاب‌شده قابل آزمایش نیست.",
};

function readSaved(key: string | null): { turns?: Turn[]; mode?: AiRuntimeMode } {
  if (!key) return {};
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "{}");
  } catch {
    return {};
  }
}

/** Read the SDK's SSE framing without bringing a second chat runtime into the console. */
async function consumeTurn(response: Response, onText: (delta: string) => void, onDiagnostics: (data: Diagnostics) => void) {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? (response.status === 403 ? "forbidden" : "provider_failed"));
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("stream_interrupted");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let complete = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += result.value;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!frame.startsWith("data: ") || frame === "data: [DONE]") continue;
        const part = JSON.parse(frame.slice(6));
        if (part.type === "text-delta") onText(part.delta);
        if (part.type === "data-diagnostics" || part.type === "data-completion") onDiagnostics(part.data);
        if (part.type === "finish") complete = true;
        if (part.type === "error") throw new Error(part.errorText);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!complete) throw new Error("stream_interrupted");
}

export function PlatformAiChatProvider({ children, sessionScope, draftTest }: {
  children: ReactNode;
  sessionScope?: string;
  draftTest?: DraftTest;
}) {
  const storageKey = sessionScope && !draftTest ? `platform-ai:${sessionScope}` : null;
  const [mode, setMode] = useState<AiRuntimeMode>(() => draftTest?.mode ?? readSaved(storageKey).mode ?? "auto");
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>(() => readSaved(storageKey).turns ?? []);
  const [pending, setPending] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [tools, setTools] = useState(false);
  const [containsToolContext, setContainsToolContext] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (!storageKey) return;
    try {
      if (containsToolContext) sessionStorage.removeItem(storageKey);
      else sessionStorage.setItem(storageKey, JSON.stringify({ mode, turns }));
    } catch {
      // Chat still works when browser storage is unavailable.
    }
  }, [containsToolContext, mode, storageKey, turns]);

  async function send() {
    const message = text.trim();
    if (!message || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    const user: Turn = { role: "user", content: message };
    let answer = "";
    setBusy(true);
    setError("");
    setDiagnostics(null);
    setPending([user]);
    if (tools) setContainsToolContext(true);
    try {
      const response = await fetch("/api/platform/ai/playground", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          message, mode, tools, draftId: draftTest?.id,
          history: draftTest ? [] : turns.slice(-6).map(({ role, content }) => ({ role, content: content.slice(0, 1800) })),
        }),
      });
      await consumeTurn(response, (delta) => {
        if (requestRef.current !== controller || controller.signal.aborted) return;
        answer += delta;
        setPending([user, { role: "assistant", content: answer }]);
      }, (data) => {
        if (requestRef.current === controller && !controller.signal.aborted) setDiagnostics(data);
      });
      if (requestRef.current !== controller) return;
      controller.signal.throwIfAborted();
      setTurns((current) => [...current, user, { role: "assistant" as const, content: answer }].slice(-40));
      setPending([]);
      setText("");
    } catch (failure) {
      if (requestRef.current !== controller) return;
      const code = controller.signal.aborted ? "request_cancelled"
        : failure instanceof Error && failure.name === "TypeError" ? "network_error"
          : failure instanceof Error ? failure.message : "stream_interrupted";
      if (code === "unauthorized" || code === "forbidden") {
        setPending([]);
        setTurns([]);
        setDiagnostics(null);
      }
      if (tools && code !== "unauthorized" && code !== "forbidden") {
        setTools(false);
      }
      setError(Object.hasOwn(STREAM_ERRORS, code) ? STREAM_ERRORS[code] : errorMessage(code));
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setBusy(false);
      }
    }
  }

  function reset() {
    requestRef.current?.abort();
    requestRef.current = null;
    setBusy(false);
    setTurns([]);
    setPending([]);
    setText("");
    setError("");
    setDiagnostics(null);
    setTools(false);
    setContainsToolContext(false);
  }

  return <Ctx.Provider value={{
    mode, setMode, text, setText, turns, pending, busy, error, diagnostics, tools, setTools,
    draftTest: Boolean(draftTest), send, stop: () => requestRef.current?.abort(), reset,
  }}>
    {children}
  </Ctx.Provider>;
}

export function usePlatformAiChat() {
  const value = useContext(Ctx);
  if (!value) throw new Error("PlatformAiChatProvider missing");
  return value;
}

export function PlatformAiChatPanel({ compact = false }: { compact?: boolean }) {
  const chat = usePlatformAiChat();
  return <section dir="rtl" className="flex min-h-0 min-w-0 flex-1 flex-col gap-3" aria-label="گفتگوی مدیر پلتفرم">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="text-xs text-muted-foreground">
        {chat.draftTest ? "آزمایش پیش‌نویس ذخیره‌شده" : "آزمایش مدل و پرامپت"}
        {!chat.draftTest && <label className="flex items-center gap-2">
          <input type="checkbox" checked={chat.tools} disabled={chat.busy}
            onChange={(event) => chat.setTools(event.target.checked)} />
          فعال‌کردن ابزارهای فقط‌خواندنی سلامت پلتفرم
        </label>}
      </div>
      <Button size="sm" variant="ghost" onClick={chat.reset} disabled={chat.busy}>گفتگوی جدید</Button>
    </div>
    <div className={`flex min-h-40 flex-1 flex-col gap-2 overflow-y-auto rounded-xl border border-border bg-muted/10 p-3 ${compact ? "max-h-[55vh]" : "max-h-[65vh]"}`}>
      {chat.turns.length === 0 && chat.pending.length === 0 ? <p className="text-sm text-muted-foreground">سؤالی بنویسید تا مدل انتخاب‌شده و پرامپت فعال آزمایش شود.</p> : null}
      {[...chat.turns, ...chat.pending].map((turn, index) => <div key={index} dir="auto"
        className={`max-w-[94%] whitespace-pre-wrap break-words rounded-xl border border-border p-3 text-sm ${turn.role === "user" ? "self-start bg-card" : "self-end bg-muted"}`}>
        {turn.role === "assistant" ? <AiMarkdown content={turn.content} plainLinks /> : turn.content}
      </div>)}
    </div>
    {chat.diagnostics && <details className="break-words text-xs text-muted-foreground">
      <summary className="cursor-pointer">جزئیات اجرا · <bdi>{chat.diagnostics.modelAlias}</bdi></summary>
      <div className="mt-1 space-y-1">
        <div>شناسهٔ درخواست <bdi>{chat.diagnostics.requestId}</bdi></div>
        <div>نسخهٔ پایه {chat.diagnostics.promptVersions.base ?? "پیش‌فرض"}</div>
        <div>نسخهٔ حالت {chat.diagnostics.promptVersions.mode ?? "پیش‌فرض"}</div>
        {chat.diagnostics.draftScope && <div>پیش‌نویس <bdi>{chat.diagnostics.draftScope}</bdi> · {chat.diagnostics.draftVersion}</div>}
        {chat.diagnostics.durationMs !== undefined && <div>مدت اجرا {chat.diagnostics.durationMs} میلی‌ثانیه</div>}
        {chat.diagnostics.tokens != null && <div>تعداد توکن {chat.diagnostics.tokens}</div>}
        {chat.diagnostics.toolResults?.map((tool, index) => <div key={index}>
          <bdi>{tool.name}</bdi> · {tool.allowed ? "اجرا شد" : "رد شد"} · {tool.durationMs} میلی‌ثانیه
        </div>)}
      </div>
    </details>}
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
            disabled={chat.busy || chat.draftTest} aria-label={`حالت پاسخ‌گویی: ${LABELS[key]}`}
            aria-pressed={chat.mode === key} title={LABELS[key]} onClick={() => chat.setMode(key)}>
            <Icon className="size-4" />
          </Button>;
        })}
        {chat.busy
          ? <Button size="icon-sm" onClick={chat.stop} aria-label="توقف پاسخ"><SquareIcon className="size-4" /></Button>
          : <Button size="icon-sm" disabled={!chat.text.trim()} onClick={() => void chat.send()}
              aria-label={chat.error ? "ارسال دوبارهٔ پیام آزمایشی" : "ارسال پیام آزمایشی"}><ArrowUpIcon className="size-4" /></Button>}
      </div>
    </div>
  </section>;
}
