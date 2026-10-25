"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { ArrowUpIcon, BrainCircuitIcon, SparklesIcon, ZapIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AI_CHAT_MODES, type AiRuntimeMode } from "@/lib/ai-runtime-modes-shared";
import { api } from "@/app/platform/ui";

type Turn = { role: "user" | "assistant"; content: string };
interface PlatformAiSession {
  mode: AiRuntimeMode;
  setMode: (mode: AiRuntimeMode) => void;
  text: string;
  setText: (text: string) => void;
  turns: Turn[];
  busy: boolean;
  error: string;
  model: string;
  send: () => Promise<void>;
  reset: () => void;
}
const Ctx = createContext<PlatformAiSession | null>(null);
const LABELS = { auto: "خودکار", instant: "سریع", thinking: "تفکر عمیق" } as const;
const ICONS = { auto: SparklesIcon, instant: ZapIcon, thinking: BrainCircuitIcon } as const;

/** One platform-only in-memory chat across all Superadmin routes; no tenant state. */
export function PlatformAiChatProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AiRuntimeMode>("auto");
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [model, setModel] = useState("");

  async function send() {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ answer?: string; modelAlias?: string; error?: string }>("/api/platform/ai/playground", {
        method: "POST", body: JSON.stringify({ message, mode }),
      });
      if (!result.ok || !result.data.answer) throw new Error(result.data.error ?? "provider_failed");
      setTurns((current) => [...current, { role: "user", content: message }, { role: "assistant", content: result.data.answer! }].slice(-40));
      setModel(result.data.modelAlias ?? "");
      setText("");
    } catch {
      setError("پاسخ مدل دریافت نشد. حالت و تنظیمات مدل را در کنترل‌پلین هوش مصنوعی بررسی کنید.");
    } finally { setBusy(false); }
  }

  function reset() { setTurns([]); setText(""); setError(""); setModel(""); }

  return <Ctx.Provider value={{ mode, setMode, text, setText, turns, busy, error, model, send, reset }}>
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
      <p className="text-xs text-muted-foreground">
        مدل و پرامپت منتشرشده • خواندنی • بدون دسترسی به اطلاعات تنانت‌ها
      </p>
      <Button size="sm" variant="ghost" onClick={chat.reset} disabled={chat.busy}>گفتگوی جدید</Button>
    </div>
    <div className={`flex min-h-40 flex-1 flex-col gap-2 overflow-y-auto rounded-xl border border-border bg-muted/10 p-3 ${compact ? "max-h-[55vh]" : "max-h-[65vh]"}`}>
      {chat.turns.length === 0 ? <p className="text-sm text-muted-foreground">سؤالی بنویسید تا مدل انتخاب‌شده و نسخهٔ منتشرشدهٔ پرامپت آزمایش شود.</p> : null}
      {chat.turns.map((turn, index) => <div key={index}
        className={`max-w-[94%] whitespace-pre-wrap break-words rounded-xl border border-border p-3 text-sm ${turn.role === "user" ? "self-start bg-card" : "self-end bg-muted"}`}>
        {turn.content}
      </div>)}
    </div>
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
        <Button size="icon-sm" disabled={chat.busy || !chat.text.trim()} onClick={() => void chat.send()}
          aria-label="ارسال پیام آزمایشی"><ArrowUpIcon className="size-4" /></Button>
      </div>
    </div>
  </section>;
}
