"use client";

/**
 * Issue #984 — the ticket's «هوش پشتیبانی» tab: ticket-scoped Support AI.
 * The operator picks a conversation (or opens one), asks the model to
 * investigate the ticket's redacted evidence, and reviews proposed plans;
 * bounded repairs still execute only through the approved catalog flow with
 * consent and post-verification. Deterministic investigation works even when
 * the gateway is down.
 */
import { useState } from "react";
import { SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PlatformDetailSection, PlatformStatusBadge } from "@/components/platform";
import { usePlatformMutation, usePlatformQuery } from "../../_lib/use-platform-data";
import { useCan } from "../../_lib/capability-context";
import { fmtDateTime, fmtToman } from "@/lib/platform-format";
import {
  SUPPORT_AI_PROFILE_LABELS,
  SUPPORT_AI_PROFILES,
} from "@/lib/support-companion/types";
import type {
  SupportAiConversationDto,
  SupportAiMessageDto,
  TicketSupportContext,
} from "./types";

export function SupportAiPanel({ ticketId }: { ticketId: string }) {
  const can = useCan();
  const [conversationId, setConversationId] = useState<string | null>(null);

  if (!can("support.ai.use")) {
    return <p className="text-xs text-muted-foreground">هوش پشتیبانی نیازمند مجوز «استفاده از هوش پشتیبانی» است.</p>;
  }

  return (
    <div className="space-y-4">
      <ConversationPicker ticketId={ticketId} value={conversationId} onChange={setConversationId} />
      {conversationId ? (
        <ConversationView ticketId={ticketId} conversationId={conversationId} />
      ) : (
        <p className="text-xs text-muted-foreground">یک گفت‌وگو انتخاب کنید یا گفت‌وگوی تازه‌ای باز کنید.</p>
      )}
    </div>
  );
}

function ConversationPicker({
  ticketId,
  value,
  onChange,
}: {
  ticketId: string;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const can = useCan();
  const context = usePlatformQuery<{ context: TicketSupportContext }>(
    `/api/platform/support/tickets/${ticketId}/context`,
    [ticketId],
  );
  const conversations = usePlatformQuery<{ conversations: SupportAiConversationDto[] }>(
    `/api/platform/support/support-ai?ticketId=${ticketId}`,
    [ticketId],
  );
  const [installationId, setInstallationId] = useState("");
  const [modelProfile, setModelProfile] = useState("support-default");
  const create = usePlatformMutation<void, { conversation: SupportAiConversationDto }>(
    `/api/platform/support/support-ai`,
    {
      method: "POST",
      request: () => ({
        options: {
          body: JSON.stringify({
            ticketId,
            installationId: installationId || null,
            modelProfile,
          }),
        },
      }),
      successToast: "گفت‌وگوی پشتیبانی باز شد.",
      errorMessages: { profile_not_permitted: "این پروفایل مدل نیازمند مجوز «پیکربندی هوش پشتیبانی» است." },
      onSuccess: (data) => {
        conversations.refetch();
        onChange(data.conversation.id);
      },
    },
  );

  const installations = (context.data?.context.installations ?? []).filter(
    (i) => i.enrollmentState === "active",
  );
  const items = conversations.data?.conversations ?? [];

  return (
    <PlatformDetailSection title="گفت‌وگوها">
      {items.length > 0 ? (
        <div className="mb-3 space-y-1">
          <Label className="text-[11px] text-muted-foreground">گفت‌وگوی فعال</Label>
          <Select value={value ?? ""} onValueChange={(v) => onChange(v || null)}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="انتخاب گفت‌وگو…" />
            </SelectTrigger>
            <SelectContent>
              {items.map((conversation) => (
                <SelectItem key={conversation.id} value={conversation.id}>
                  {SUPPORT_AI_PROFILE_LABELS[conversation.modelProfile as keyof typeof SUPPORT_AI_PROFILE_LABELS] ?? conversation.modelProfile}
                  {" — "}
                  {fmtDateTime(conversation.createdAt)}
                  {conversation.state !== "active" ? " (بسته)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">نصب (اختیاری)</Label>
          <Select value={installationId || "__none__"} onValueChange={(v) => setInstallationId(v === "__none__" ? "" : v)}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="بدون نصب" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">بدون نصب</SelectItem>
              {installations.map((installation) => (
                <SelectItem key={installation.id} value={installation.id}>
                  {installation.displayName || "نصب ویندوز"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">پروفایل مدل</Label>
          <Select value={modelProfile} onValueChange={setModelProfile}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPORT_AI_PROFILES.map((profile) => (
                <SelectItem
                  key={profile}
                  value={profile}
                  disabled={profile !== "support-default" && !can("support.ai.configure")}
                >
                  {SUPPORT_AI_PROFILE_LABELS[profile]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <Button className="mt-3" onClick={() => void create.mutate()} disabled={create.busy}>
        {create.busy ? "در حال باز کردن…" : "گفت‌وگوی تازه"}
      </Button>
    </PlatformDetailSection>
  );
}

function ConversationView({ ticketId, conversationId }: { ticketId: string; conversationId: string }) {
  const [draft, setDraft] = useState("");
  const view = usePlatformQuery<{
    conversation: SupportAiConversationDto;
    messages: SupportAiMessageDto[];
    toolEvents: { id: string; tool_name: string; result_summary: string; created_at: string }[];
  }>(`/api/platform/support/support-ai/${conversationId}?ticketId=${ticketId}`, [conversationId]);

  const message = usePlatformMutation<void, { reply: string }>(
    `/api/platform/support/support-ai/${conversationId}`,
    {
      method: "POST",
      request: () => ({ options: { body: JSON.stringify({ ticketId, action: "message", body: draft.trim() }) } }),
      errorMessages: {
        runtime_unavailable: "درگاه هوش مصنوعی در دسترس نیست؛ از «بررسی قطعی» استفاده کنید.",
        spend_limit_exceeded: "سقف هزینه این گفت‌وگو تمام شده است.",
        provider_failed: "خطای ارائه‌دهنده مدل؛ دوباره تلاش کنید.",
      },
      onSuccess: () => {
        setDraft("");
        view.refetch();
      },
    },
  );
  const investigate = usePlatformMutation<void, { summary: string }>(
    `/api/platform/support/support-ai/${conversationId}`,
    {
      method: "POST",
      request: () => ({ options: { body: JSON.stringify({ ticketId, action: "investigate" }) } }),
      successToast: "خلاصه قطعی بررسی ثبت شد.",
      onSuccess: () => view.refetch(),
    },
  );

  const conversation = view.data?.conversation ?? null;
  const messages = view.data?.messages ?? [];
  const toolEvents = view.data?.toolEvents ?? [];
  const closed = conversation?.state !== "active";

  if (view.loading) return <p className="text-sm text-muted-foreground">در حال بارگذاری گفت‌وگو…</p>;
  if (view.errorText) return <p className="text-sm text-red-600 dark:text-red-400">{view.errorText}</p>;
  if (!conversation) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <PlatformStatusBadge tone={closed ? "muted" : "info"} label={closed ? "بسته" : "فعال"} />
        <span>
          {SUPPORT_AI_PROFILE_LABELS[conversation.modelProfile as keyof typeof SUPPORT_AI_PROFILE_LABELS] ?? conversation.modelProfile}
        </span>
        <span>هزینه ثبت‌شده: {fmtToman(conversation.spendRial)}</span>
      </div>

      <PlatformDetailSection title="گفت‌وگو">
        <div className="max-h-[20rem] space-y-2 overflow-y-auto py-1">
          {messages.length === 0 ? (
            <p className="text-xs text-muted-foreground">هنوز پیامی نیست؛ سؤال خود را بپرسید یا «بررسی قطعی» را اجرا کنید.</p>
          ) : (
            messages.map((item) => (
              <div
                key={item.id}
                className={`max-w-[95%] rounded-xl border p-2.5 ${
                  item.role === "assistant"
                    ? "border-primary/25 bg-primary/10"
                    : "border-border bg-card"
                }`}
              >
                <p className="mb-1 text-[11px] text-muted-foreground">
                  {item.role === "assistant" ? "هوش پشتیبانی" : item.role === "system" ? "سیستم" : "اپراتور"} —{" "}
                  {fmtDateTime(item.createdAt)}
                </p>
                <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{item.content}</p>
              </div>
            ))
          )}
        </div>
        {!closed ? (
          <div className="mt-3 space-y-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="از هوش پشتیبانی بخواهید شواهد تیکت را بررسی کند…"
              rows={3}
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void message.mutate()} disabled={message.busy || !draft.trim()} className="gap-2">
                <SendIcon className="size-4" aria-hidden="true" />
                {message.busy ? "در حال ارسال…" : "ارسال"}
              </Button>
              <Button variant="outline" onClick={() => void investigate.mutate()} disabled={investigate.busy}>
                {investigate.busy ? "…" : "بررسی قطعی (بدون مدل)"}
              </Button>
            </div>
          </div>
        ) : null}
      </PlatformDetailSection>

      {toolEvents.length > 0 ? (
        <PlatformDetailSection title="رویدادهای ابزار (حسابرسی)">
          <ul className="space-y-1 text-xs">
            {toolEvents.map((event) => (
              <li key={event.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-foreground" dir="ltr">
                  {event.tool_name}
                </span>
                <span className="text-muted-foreground">
                  {event.result_summary} — {fmtDateTime(event.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </PlatformDetailSection>
      ) : null}
    </div>
  );
}
