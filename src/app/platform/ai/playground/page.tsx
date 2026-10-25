"use client";

/**
 * The full-page version of the one Superadmin AI test session.
 * Switching to another platform page keeps the same conversation in the
 * authorized left dock, without mounting a second provider or tenant tools.
 */
import { AiConsoleNav } from "../ai-console-nav";
import { InfoBox, useCan } from "../../ui";
import { PlatformAiChatPanel } from "../platform-ai-chat-session";

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
    <PlatformAiChatPanel />
  </div>;
}
