"use client";

/**
 * The support desk's detail drawer — one ticket's full conversation plus the
 * operator's write actions (reply, re-status, re-prioritise, re-categorise,
 * reassign). The conversation and any attachments load on demand when the
 * drawer opens; every write goes through the audited PATCH/POST endpoints and
 * refreshes the list on success.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLinkIcon, SendIcon } from "lucide-react";
import {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUSES,
  ticketStatusLabel,
} from "@/lib/support-tickets";
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
import {
  PlatformDetailDrawer,
  PlatformDetailSection,
  PlatformStatusBadge,
  type StatusTone,
} from "@/components/platform";
import { usePlatformQuery, usePlatformMutation } from "../_lib/use-platform-data";
import { fmtDateTime } from "@/lib/platform-format";

export interface SupportMessage {
  id: string;
  ticketId: string;
  authorType: "member" | "admin";
  userId: string | null;
  userName: string | null;
  adminId: string | null;
  adminName: string | null;
  body: string;
  attachment: string | null;
  createdAt: string;
}

export interface SupportTicketDetail {
  id: string;
  businessId: string;
  businessName: string;
  locationName: string | null;
  userName: string | null;
  subject: string;
  category: string;
  priority: string;
  status: string;
  assignedAdminId: string | null;
  assignedAdminName: string | null;
  createdAt: string;
  closedAt: string | null;
  messages: SupportMessage[];
}

export const STATUS_TONE: Record<string, StatusTone> = {
  open: "warning",
  in_progress: "info",
  waiting_customer: "neutral",
  resolved: "success",
  closed: "muted",
};

export const PRIORITY_TONE: Record<string, StatusTone> = {
  low: "muted",
  normal: "neutral",
  high: "warning",
  urgent: "danger",
};

export function statusBadge(status: string) {
  return (
    <PlatformStatusBadge
      tone={STATUS_TONE[status] ?? "neutral"}
      label={ticketStatusLabel(status, "operator")}
    />
  );
}

export function priorityBadge(priority: string) {
  return (
    <PlatformStatusBadge
      tone={PRIORITY_TONE[priority] ?? "neutral"}
      label={TICKET_PRIORITY_LABELS[priority as keyof typeof TICKET_PRIORITY_LABELS] ?? priority}
    />
  );
}

export function SupportTicketDrawer({
  ticketId,
  assignableAdmins,
  onClose,
  onChanged,
}: {
  ticketId: string | null;
  assignableAdmins: { id: string; fullName: string }[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [reply, setReply] = useState("");

  const detail = usePlatformQuery<{ ticket: SupportTicketDetail }>(
    ticketId ? `/api/platform/support/tickets/${ticketId}` : null,
    [ticketId],
  );
  const ticket = detail.data?.ticket ?? null;

  useEffect(() => {
    setReply("");
  }, [ticketId]);

  const patch = usePlatformMutation<Record<string, unknown>>(
    ticketId ? `/api/platform/support/tickets/${ticketId}` : "",
    {
      method: "PATCH",
      request: (fields) => ({ options: { body: JSON.stringify(fields) } }),
      successToast: "تیکت به‌روزرسانی شد.",
      onSuccess: () => {
        detail.refetch();
        onChanged();
      },
    },
  );

  const sendReply = usePlatformMutation<{ body: string }>(
    ticketId ? `/api/platform/support/tickets/${ticketId}/messages` : "",
    {
      method: "POST",
      request: (args) => ({ options: { body: JSON.stringify(args) } }),
      successToast: "پاسخ ارسال شد.",
      onSuccess: () => {
        setReply("");
        detail.refetch();
        onChanged();
      },
    },
  );

  return (
    <PlatformDetailDrawer
      open={Boolean(ticketId)}
      onOpenChange={(v) => !v && onClose()}
      title={ticket?.subject ?? "جزئیات تیکت"}
      description={ticket ? ticket.businessName : undefined}
      className="sm:max-w-xl"
    >
      {detail.loading ? (
        <p className="text-sm text-muted-foreground">در حال بارگذاری گفت‌وگو…</p>
      ) : ticket ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {statusBadge(ticket.status)}
            {priorityBadge(ticket.priority)}
            <span className="text-xs text-muted-foreground">{fmtDateTime(ticket.createdAt)}</span>
          </div>

          <div className="mb-4 grid gap-1 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">کسب‌وکار</span>
              <Link
                href={`/platform/businesses/${ticket.businessId}`}
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                {ticket.businessName}
                <ExternalLinkIcon className="size-3.5" />
              </Link>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">کاربر</span>
              <span className="text-foreground">{ticket.userName ?? "کاربر حذف‌شده"}</span>
            </div>
            {ticket.locationName ? (
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">شعبه</span>
                <span className="text-foreground">{ticket.locationName}</span>
              </div>
            ) : null}
          </div>
          <Button asChild className="mb-4 w-full sm:w-auto">
            <Link href={`/platform/businesses/${ticket.businessId}/support?ticketId=${ticket.id}`}>
              شروع نشست پشتیبانی
              <ExternalLinkIcon className="size-3.5" />
            </Link>
          </Button>

          {/* Conversation */}
          <PlatformDetailSection title="گفت‌وگو">
            <div className="max-h-[22rem] space-y-3 overflow-y-auto py-1">
              {ticket.messages.length === 0 ? (
                <p className="text-xs text-muted-foreground">پیامی در این تیکت نیست.</p>
              ) : (
                ticket.messages.map((message) => (
                  <div
                    key={message.id}
                    className={`max-w-[92%] rounded-xl border p-3 ${
                      message.authorType === "admin"
                        ? "ms-auto border-primary/25 bg-primary/10"
                        : "border-border bg-card"
                    }`}
                  >
                    <p className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {message.authorType === "admin"
                          ? message.adminName ?? "تیم پشتیبانی"
                          : message.userName ?? "کاربر"}
                      </span>
                      <span>{fmtDateTime(message.createdAt)}</span>
                      {message.authorType === "admin" ? (
                        <span className="text-primary">پاسخ سکو</span>
                      ) : null}
                    </p>
                    <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{message.body}</p>
                    {message.attachment ? (
                      <a
                        href={message.attachment}
                        download={`ticket-${ticket.id}-${message.id}.jpg`}
                        className="mt-2 block overflow-hidden rounded-lg border border-border bg-muted"
                      >
                        { }
                        <img src={message.attachment} alt="پیوست تیکت" className="max-h-44 w-full object-contain" />
                      </a>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </PlatformDetailSection>

          {/* Lifecycle controls */}
          <PlatformDetailSection title="مدیریت تیکت">
            <div className="grid gap-3 py-1 sm:grid-cols-2">
              <LabeledSelect
                label="وضعیت"
                value={ticket.status}
                options={TICKET_STATUSES.map((v) => ({ value: v, label: ticketStatusLabel(v, "operator") }))}
                disabled={patch.busy}
                onChange={(v) => void patch.mutate({ status: v })}
              />
              <LabeledSelect
                label="اولویت"
                value={ticket.priority}
                options={TICKET_PRIORITIES.map((v) => ({ value: v, label: TICKET_PRIORITY_LABELS[v] }))}
                disabled={patch.busy}
                onChange={(v) => void patch.mutate({ priority: v })}
              />
              <LabeledSelect
                label="دسته"
                value={ticket.category}
                options={TICKET_CATEGORIES.map((v) => ({ value: v, label: TICKET_CATEGORY_LABELS[v] }))}
                disabled={patch.busy}
                onChange={(v) => void patch.mutate({ category: v })}
              />
              <LabeledSelect
                label="پاسخ‌دهنده"
                value={ticket.assignedAdminId ?? "__none__"}
                options={[
                  { value: "__none__", label: "بدون پاسخ‌دهنده" },
                  ...assignableAdmins.map((a) => ({ value: a.id, label: a.fullName })),
                ]}
                disabled={patch.busy}
                onChange={(v) => void patch.mutate({ assignedAdminId: v === "__none__" ? null : v })}
              />
            </div>
          </PlatformDetailSection>

          {/* Reply box */}
          <div className="space-y-2">
            <Textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder="پاسخ تیم پشتیبانی…"
              rows={3}
              className="resize-y"
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">
                پاسخ شما تیکت را به «در انتظار پاسخ کاربر» می‌برد.
              </p>
              <Button
                onClick={() => reply.trim() && void sendReply.mutate({ body: reply.trim() })}
                disabled={sendReply.busy || !reply.trim()}
                className="gap-2"
              >
                <SendIcon className="size-4" aria-hidden="true" />
                {sendReply.busy ? "در حال ارسال…" : "ارسال پاسخ"}
              </Button>
            </div>
          </div>
        </>
      ) : detail.errorText ? (
        <p className="text-sm text-red-600 dark:text-red-400">{detail.errorText}</p>
      ) : null}
    </PlatformDetailDrawer>
  );
}

function LabeledSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
