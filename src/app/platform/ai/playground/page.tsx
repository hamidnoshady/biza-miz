"use client";

/**
 * The full-page version of the one Superadmin AI test session.
 * Switching to another platform page keeps the same conversation in the
 * authorized left dock, without mounting a second provider or tenant tools.
 */
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AI_CHAT_MODES, type AiRuntimeMode } from "@/lib/ai-runtime-modes-shared";
import { AiConsoleNav } from "../ai-console-nav";
import { InfoBox, useCan } from "../../ui";
import { PlatformAiChatPanel, PlatformAiChatProvider } from "../platform-ai-chat-session";

export default function PlatformAiPlaygroundPage() {
  const canManage = useCan()("ai.config.manage");
  if (!canManage) return <InfoBox>دسترسی لازم برای آزمایش دستیار را ندارید.</InfoBox>;
  return <div className="space-y-4" dir="rtl">
    <AiConsoleNav />
    <h1 className="text-xl font-bold">آزمایش مدل‌ها و پرامپت‌های دستیار</h1>
    <InfoBox>
      این گفتگو در صفحه‌های دیگر Superadmin هم ادامه دارد.
      مدل و پرامپت منتشرشده آزمایش می‌شوند؛ ابزارهای کسب‌وکار و اجرای عملیات در این حالت فعال نیستند.
    </InfoBox>
    <Suspense fallback={<p>در حال آماده‌سازی گفتگو…</p>}><PlaygroundChat /></Suspense>
  </div>;
}

function PlaygroundChat() {
  const params = useSearchParams();
  const id = params.get("draft");
  const mode = params.get("mode");
  if (!id) return <PlatformAiChatPanel />;
  if (!mode || !(AI_CHAT_MODES as readonly string[]).includes(mode)) {
    return <InfoBox>حالت آزمایش پیش‌نویس معتبر نیست.</InfoBox>;
  }
  return <PlatformAiChatProvider key={`${id}:${mode}`} draftTest={{ id, mode: mode as AiRuntimeMode }}>
    <PlatformAiChatPanel />
  </PlatformAiChatProvider>;
}
