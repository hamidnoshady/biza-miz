"use client";

import { useState } from "react";
import { ArrowUpIcon, BrainCircuitIcon, SparklesIcon, ZapIcon } from "lucide-react";
import { AI_CHAT_MODES, type AiRuntimeMode } from "@/lib/ai-runtime-modes-shared";
import { AiConsoleNav } from "../ai-console-nav";
import { api, Button, Card, ErrorBox, InfoBox } from "../../ui";

type Turn = { role: "user" | "assistant"; content: string };
const ICONS = { auto: SparklesIcon, instant: ZapIcon, thinking: BrainCircuitIcon } as const;
const NAMES = { auto: "خودکار", instant: "سریع", thinking: "تفکر عمیق" } as const;

/** A safe test surface; no tenant tools, actions, or tenant knowledge. */
export default function PlatformAiPlaygroundPage() {
  const [mode, setMode] = useState<AiRuntimeMode>("auto");
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastModel, setLastModel] = useState("");

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setBusy(true);
    setError("");
    const result = await api<{ answer?: string; modelAlias?: string; error?: string }>("/api/platform/ai/playground", {
      method: "POST",
      body: JSON.stringify({ message, mode }),
    });
    setBusy(false);
    if (!result.ok || !result.data.answer) {
      setError(result.data.error ?? "پاسخ مدل دریافت نشد.");
      return;
    }
    setTurns((current) => [...current, { role: "user", content: message }, { role: "assistant", content: result.data.answer! }]);
    setLastModel(result.data.modelAlias ?? "");
    setInput("");
  }

  return (
    <div className="space-y-4" dir="rtl">
      <AiConsoleNav />
      <h1 className="text-xl font-bold">آزمایش مدل‌ها و پرامپت‌های دستیار</h1>
      <InfoBox>
        این بخش برای مدیر پلتفرم است. پاسخ با مدل و نسخه منتشرشده پرامپت حالت انتخابی تولید می‌شود؛
        ابزارهای کسب‌وکار و اجرای عملیات اینجا فعال نیستند.
        تنظیم مدل‌ها در «حالت‌های اجرا»، پرامپت‌ها در «لایه‌های پرامپت» و ایجنت‌ها در «ایجنت‌های سیستمی» انجام می‌شود.
      </InfoBox>
      <Card title="محیط آزمایش" >
        <div className="space-y-3">
          <div className="flex min-h-56 max-h-[55vh] flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-muted/20 p-3" aria-label="گفتگوی آزمایشی">
            {turns.length === 0 ? <p className="text-sm text-muted-foreground">یک پیام آزمایشی بنویسید تا مدل انتخاب‌شده و پرامپت منتشرشده بررسی شود.</p> : null}
            {turns.map((turn, index) => (
              <div key={index} className={`max-w-[90%] whitespace-pre-wrap rounded-xl border border-border p-3 text-sm ${turn.role === "user" ? "self-start bg-background" : "self-end bg-muted"}`}>
                {turn.content}
              </div>
            ))}
          </div>
          {lastModel ? <p className="text-xs text-muted-foreground" dir="ltr">LiteLLM alias: {lastModel}</p> : null}
          {error ? <ErrorBox>{error}</ErrorBox> : null}
          <div className="rounded-xl border border-border bg-background p-3">
            <textarea rows={3} className="w-full resize-none bg-transparent p-1 text-sm outline-none" maxLength={3000}
              aria-label="پیام آزمایشی" placeholder="پیام خود را بنویسید..." value={input} disabled={busy}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
            />
            <div className="mt-2 flex items-center justify-end gap-1.5" dir="rtl">
              {AI_CHAT_MODES.map((value) => {
                const Icon = ICONS[value];
                return <Button key={value} type="button" size="icon-sm"
                  variant={mode === value ? "secondary" : "ghost"} disabled={busy}
                  aria-label={`حالت پاسخ‌گویی: ${NAMES[value]}`} title={NAMES[value]}
                  aria-pressed={mode === value} onClick={() => setMode(value)}
                ><Icon className="size-4" /></Button>;
              })}
              <Button type="button" size="icon-sm" onClick={() => void send()}
                disabled={busy || !input.trim()} aria-label="ارسال پیام آزمایشی" title="ارسال">
                <ArrowUpIcon className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
