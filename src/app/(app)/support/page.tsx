"use client";

/**
 * The member's support desk (migration 0130).
 *
 * Every member of a business can open a ticket, follow the conversation and
 * reply from here; owners and managers additionally see the whole business
 * queue (the service enforces both rules server-side — this page only renders
 * what it is given). Dates are Shamsi via formatJalali, per the platform rule.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  InboxIcon,
  LifeBuoyIcon,
  MessageSquarePlusIcon,
  PaperclipIcon,
  RefreshCwIcon,
  SearchIcon,
  SendIcon,
  Trash2Icon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { cn } from "@/lib/utils";
import {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  isTicketOpen,
} from "@/lib/support-tickets";
import { api, ErrorBox } from "@/app/dashboard/ui";
import {
  PageHeader,
  PageShell,
  SectionCard,
  EmptyState,
  LoadingSkeleton,
  StatusBadge,
  cardClass,
} from "@/app/dashboard/page-chrome";

interface SupportTicket {
  id: string;
  businessId: string;
  locationId: string | null;
  locationName: string | null;
  userId: string | null;
  userName: string | null;
  subject: string;
  category: string;
  priority: string;
  status: string;
  assignedAdminId: string | null;
  assignedAdminName: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

interface SupportMessage {
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

interface SupportTicketDetail extends SupportTicket {
  messages: SupportMessage[];
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return toPersianDigits(
    formatJalali(iso, { withTime: true, withMonthName: true }),
  );
}

function statusTone(
  status: string,
): "active" | "positive" | "neutral" | "danger" {
  if (status === "resolved" || status === "closed") return "positive";
  if (status === "waiting_customer") return "active";
  return "neutral";
}

/**
 * Issue #984 — opens the installed standalone support companion with this
 * ticket hinted. Desktop shell only (`window.businessSuiteDesktop`): the
 * bridge reports install presence truthfully, which a browser cannot. Hidden
 * entirely outside the desktop app; disabled with an explanatory title when
 * the companion is not installed. Launching authorizes nothing by itself.
 */
function CompanionOpenButton({ ticketId }: { ticketId: string }) {
  const bridge =
    typeof window !== "undefined" ? window.businessSuiteDesktop?.supportCompanion ?? null : null;
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge
      .status()
      .then((result) => {
        if (!cancelled) setInstalled(result.installed);
      })
      .catch(() => {
        if (!cancelled) setInstalled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  if (!bridge) return null;

  async function open() {
    if (!bridge || launching) return;
    setLaunching(true);
    try {
      const result = await bridge.launch(ticketId);
      if (!result.ok) {
        toast.error(
          result.error === "not_installed"
            ? "همراه پشتیبانی روی این دستگاه نصب نشده است. از پشتیبانی نصب‌کننده را بخواهید."
            : "باز کردن همراه پشتیبانی ناموفق بود. دوباره تلاش کنید.",
        );
      }
    } catch {
      toast.error("باز کردن همراه پشتیبانی ناموفق بود. دوباره تلاش کنید.");
    } finally {
      setLaunching(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void open()}
      disabled={installed === false || launching}
      title={
        installed === false
          ? "همراه پشتیبانی نصب نشده است"
          : "باز کردن همراه پشتیبانی برای این تیکت"
      }
    >
      <LifeBuoyIcon aria-hidden="true" className="size-4" />
      همراه پشتیبانی
    </Button>
  );
}

export default function SupportPage() {
  const [tickets, setTickets] = useState<SupportTicket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SupportTicketDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [newOpen, setNewOpen] = useState(false);

  const load = useCallback(async () => {
    const { ok, data } = await api<{
      tickets?: SupportTicket[];
      error?: string;
    }>("/api/support/tickets?limit=500");
    if (ok) {
      setTickets(data.tickets ?? []);
      setError(null);
    } else {
      setError(data.error ?? "خطای غیرمنتظره. دوباره تلاش کنید.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase();
    return (tickets ?? []).filter((ticket) => {
      if (status && ticket.status !== status) return false;
      if (!needle) return true;
      return [
        ticket.subject,
        ticket.locationName,
        ticket.assignedAdminName,
        ticket.lastMessagePreview,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [q, status, tickets]);

  const stats = useMemo(() => {
    const all = tickets ?? [];
    return {
      open: all.filter((t) => isTicketOpen(t.status)).length,
      waitingMe: all.filter((t) => t.status === "waiting_customer").length,
      resolved: all.filter((t) => t.status === "resolved").length,
      total: all.length,
    };
  }, [tickets]);

  const selectTicket = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    const { ok, data } = await api<{
      ticket?: SupportTicketDetail;
      error?: string;
    }>(`/api/support/tickets/${id}`);
    setDetailLoading(false);
    if (ok && data.ticket) setDetail(data.ticket);
    else setDetailError(data.error ?? "خطای غیرمنتظره. دوباره تلاش کنید.");
  }, []);

  const selectedSummary =
    visible.find((ticket) => ticket.id === selectedId) ?? null;

  const refreshAfterChange = useCallback(async () => {
    await load();
    if (selectedId) {
      const { ok, data } = await api<{
        ticket?: SupportTicketDetail;
        error?: string;
      }>(`/api/support/tickets/${selectedId}`);
      if (ok && data.ticket) setDetail(data.ticket);
    }
  }, [load, selectedId]);

  return (
    <PageShell className="max-w-[1200px]">
      <PageHeader
        title="پشتیبانی"
        description="سؤالی دارید یا مشکلی پیش آمده؟ تیکت بسازید؛ تیم پشتیبانی در همین گفت‌وگو پاسخ می‌دهد."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => void load()}
              className="gap-2"
            >
              <RefreshCwIcon aria-hidden="true" className="size-4" />
              تازه‌سازی
            </Button>
            <Button onClick={() => setNewOpen(true)} className="gap-2">
              <MessageSquarePlusIcon aria-hidden="true" className="size-4" />
              تیکت جدید
            </Button>
          </>
        }
      />

      <ErrorBox>{error}</ErrorBox>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="تیکت‌های باز" value={stats.open} hint="در انتظار پیگیری" />
        <Stat
          label="در انتظار پاسخ شما"
          value={stats.waitingMe}
          hint="پاسخ پشتیبانی آمده است"
          highlight={stats.waitingMe > 0}
        />
        <Stat label="حل‌شده" value={stats.resolved} hint="در مجموع" />
        <Stat label="کل تیکت‌ها" value={stats.total} hint="از ابتدا" />
      </div>

      <SectionCard
        title="تیکت‌های من"
        description={
          tickets ? `${toPersianDigits(visible.length)} تیکت` : undefined
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                value={q}
                onChange={(event) => setQ(event.target.value)}
                placeholder="جست‌وجو در تیکت‌ها…"
                aria-label="جست‌وجو در تیکت‌ها"
                className="w-56 rounded-lg border border-input bg-transparent py-1.5 ps-9 pe-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50"
              />
            </div>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring"
              aria-label="فیلتر وضعیت"
            >
              <option value="">همهٔ وضعیت‌ها</option>
              {TICKET_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {TICKET_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {tickets === null ? (
          <LoadingSkeleton
            rows={4}
            label="در حال بارگذاری تیکت‌ها"
            className="p-4 sm:p-5"
          />
        ) : visible.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>
              {tickets.length === 0
                ? "هنوز تیکتی نساخته‌اید. از دکمهٔ «تیکت جدید» شروع کنید."
                : "تیکتی با این فیلترها پیدا نشد."}
            </EmptyState>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,0.9fr)]">
            <div className="space-y-2 p-3 sm:p-4">
              {visible.map((ticket) => (
                <button
                  key={ticket.id}
                  type="button"
                  aria-pressed={selectedId === ticket.id}
                  onClick={() => void selectTicket(ticket.id)}
                  className={`block w-full rounded-xl border p-4 text-start transition-colors ${
                    selectedId === ticket.id
                      ? "border-teal-400/60 bg-teal-50 dark:border-teal-500/40 dark:bg-teal-500/10"
                      : "border-border/80 bg-card hover:border-teal-300 dark:hover:border-teal-700"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-foreground">
                        {ticket.subject}
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span>{ticket.locationName ?? "کسب‌وکار"}</span>
                        <span>•</span>
                        <span>
                          {TICKET_CATEGORY_LABELS[
                            ticket.category as keyof typeof TICKET_CATEGORY_LABELS
                          ] ?? ticket.category}
                        </span>
                        {ticket.assignedAdminName ? (
                          <span>• {ticket.assignedAdminName}</span>
                        ) : null}
                      </p>
                    </div>
                    <StatusBadge tone={statusTone(ticket.status)}>
                      {TICKET_STATUS_LABELS[
                        ticket.status as keyof typeof TICKET_STATUS_LABELS
                      ] ?? ticket.status}
                    </StatusBadge>
                  </div>
                  <p className="mt-3 line-clamp-2 text-sm leading-6 text-muted-foreground">
                    {ticket.lastMessagePreview ?? "بدون پیام"}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{fmtDate(ticket.updatedAt)}</span>
                    <span>{toPersianDigits(ticket.messageCount)} پیام</span>
                  </div>
                </button>
              ))}
            </div>

            <TicketDetailPanel
              summary={selectedSummary}
              detail={detail}
              loading={detailLoading}
              error={detailError}
              onClose={() => {
                setSelectedId(null);
                setDetail(null);
                setDetailError(null);
              }}
              onChanged={() => void refreshAfterChange()}
            />
          </div>
        )}
      </SectionCard>

      <NewTicketDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={() => {
          setNewOpen(false);
          void load();
        }}
      />
    </PageShell>
  );
}

function Stat({
  label,
  value,
  hint,
  highlight = false,
}: {
  label: string;
  value: number;
  hint?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        cardClass,
        "p-4",
        highlight && "border-amber-400/60 dark:border-amber-500/50",
      )}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`mt-1 text-2xl font-bold tabular-nums ${highlight ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}
      >
        {toPersianDigits(value)}
      </p>
      {hint ? (
        <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function TicketDetailPanel({
  summary,
  detail,
  loading,
  error,
  onClose,
  onChanged,
}: {
  summary: SupportTicket | null;
  detail: SupportTicketDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setReply("");
    setAttachment(null);
    setActionError(null);
  }, [summary?.id]);

  if (!summary) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border p-6 text-center text-muted-foreground">
        <InboxIcon aria-hidden="true" className="mb-3 size-8" />
        <p className="text-sm">
          برای دیدن گفت‌وگو و ارسال پاسخ، یک تیکت را انتخاب کنید.
        </p>
      </div>
    );
  }

  const ticket = detail ?? summary;
  const open = isTicketOpen(ticket.status);

  function pickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("فقط تصویر می‌توانید پیوست کنید.");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      toast.error("حجم تصویر باید کمتر از ۴ مگابایت باشد.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAttachment(String(reader.result));
    reader.onerror = () => toast.error("خواندن تصویر ممکن نشد.");
    reader.readAsDataURL(file);
  }

  async function sendReply() {
    const text = reply.trim();
    if (!text) return;
    setSending(true);
    setActionError(null);
    const { ok, data } = await api<{
      message?: SupportMessage;
      error?: string;
    }>(`/api/support/tickets/${summary!.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: text, attachment }),
    });
    setSending(false);
    if (ok && data.message) {
      setReply("");
      setAttachment(null);
      onChanged();
    } else {
      setActionError(data.error ?? "خطای غیرمنتظره. دوباره تلاش کنید.");
    }
  }

  async function toggleClosed() {
    setActionError(null);
    const next = open ? "closed" : "open";
    const { ok, data } = await api<{
      ticket?: SupportTicketDetail;
      error?: string;
    }>(`/api/support/tickets/${summary!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: next }),
    });
    if (ok && data.ticket) onChanged();
    else setActionError(data.error ?? "خطای غیرمنتظره. دوباره تلاش کنید.");
  }

  return (
    <div className={`min-w-0 ${cardClass}`}>
      <div className="flex items-start justify-between gap-3 border-b border-border/80 p-4">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">گفت‌وگوی تیکت</p>
          <p className="mt-1 truncate font-semibold text-foreground">
            {ticket.subject}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge tone={statusTone(ticket.status)}>
              {TICKET_STATUS_LABELS[
                ticket.status as keyof typeof TICKET_STATUS_LABELS
              ] ?? ticket.status}
            </StatusBadge>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {TICKET_PRIORITY_LABELS[
                ticket.priority as keyof typeof TICKET_PRIORITY_LABELS
              ] ?? ticket.priority}
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {TICKET_CATEGORY_LABELS[
                ticket.category as keyof typeof TICKET_CATEGORY_LABELS
              ] ?? ticket.category}
            </span>
            {ticket.assignedAdminName ? (
              <span className="rounded-full bg-teal-500/10 px-2 py-0.5 text-xs text-teal-700 dark:text-teal-300">
                {ticket.assignedAdminName}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="بستن گفت‌وگو"
          >
            بستن
          </Button>
          <CompanionOpenButton ticketId={ticket.id} />
        </div>
      </div>

      <div className="max-h-[26rem] space-y-3 overflow-y-auto p-4">
        {(detail?.messages ?? []).map((message) => (
          <div
            key={message.id}
            className={`max-w-[92%] rounded-xl border p-3 ${
              message.authorType === "member"
                ? "border-teal-300/70 bg-teal-50 dark:border-teal-500/30 dark:bg-teal-500/10"
                : "border-border/80 bg-muted/50"
            }`}
          >
            <p className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">
                {message.authorType === "member"
                  ? (message.userName ?? "شما")
                  : (message.adminName ?? "تیم پشتیبانی")}
              </span>
              <span>{fmtDate(message.createdAt)}</span>
            </p>
            <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
              {message.body}
            </p>
            {message.attachment ? (
              <a
                href={message.attachment}
                download={`ticket-${ticket.id}-${message.id}.jpg`}
                className="mt-2 block overflow-hidden rounded-lg border border-border/80 bg-card"
              >
                <img
                  src={message.attachment}
                  alt="پیوست تیکت"
                  className="max-h-44 w-full object-contain"
                />
              </a>
            ) : null}
          </div>
        ))}
        {!detail && loading ? (
          <LoadingSkeleton rows={2} compact label="در حال بارگذاری گفت‌وگو" />
        ) : null}
        {detail && detail.messages.length === 0 ? (
          <p className="text-xs text-muted-foreground">هنوز پیامی نیست.</p>
        ) : null}
      </div>

      <ErrorBox>{error}</ErrorBox>
      {actionError ? <ErrorBox>{actionError}</ErrorBox> : null}

      <div className="space-y-2 border-t border-border/80 p-4">
        {attachment ? (
          <div className="relative overflow-hidden rounded-lg border border-border/80">
            <img
              src={attachment}
              alt="پیوست در حال ارسال"
              className="max-h-40 w-full object-cover"
            />
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => setAttachment(null)}
              className="absolute end-2 top-2"
            >
              <Trash2Icon aria-hidden="true" />
              حذف
            </Button>
          </div>
        ) : null}
        <textarea
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          placeholder={
            open
              ? "پاسخ یا توضیح جدید…"
              : "تیکت بسته است؛ با ارسال پیام دوباره باز می‌شود."
          }
          rows={3}
          className="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-base leading-6 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 md:text-sm"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={pickFile}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              className="gap-2"
            >
              <PaperclipIcon aria-hidden="true" className="size-4" />
              پیوست تصویر
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void toggleClosed()}
            >
              {open ? "بستن تیکت" : "بازکردن دوباره"}
            </Button>
          </div>
          <Button
            onClick={() => void sendReply()}
            disabled={sending || !reply.trim()}
            className="gap-2"
          >
            <SendIcon aria-hidden="true" className="size-4" />
            {sending ? "در حال ارسال…" : "ارسال"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function NewTicketDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState<string>("technical");
  const [priority, setPriority] = useState<string>("normal");
  const [description, setDescription] = useState("");
  const [attachment, setAttachment] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setSubject("");
    setCategory("technical");
    setPriority("normal");
    setDescription("");
    setAttachment(null);
    setSubmitting(false);
  };

  function pickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("فقط تصویر می‌توانید پیوست کنید.");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      toast.error("حجم تصویر باید کمتر از ۴ مگابایت باشد.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAttachment(String(reader.result));
    reader.onerror = () => toast.error("خواندن تصویر ممکن نشد.");
    reader.readAsDataURL(file);
  }

  async function submit() {
    if (!subject.trim() || !description.trim()) {
      toast.error("عنوان و شرح مشکل را وارد کنید.");
      return;
    }
    setSubmitting(true);
    const { ok, data } = await api<{
      ticket?: SupportTicketDetail;
      error?: string;
    }>("/api/support/tickets", {
      method: "POST",
      body: JSON.stringify({
        subject: subject.trim(),
        category,
        priority,
        description: description.trim(),
        attachment,
      }),
    });
    setSubmitting(false);
    if (ok && data.ticket) {
      toast.success("تیکت شما ثبت شد.");
      reset();
      onCreated();
    } else {
      toast.error(data.error ?? "ثبت تیکت ناموفق بود؛ دوباره تلاش کنید.");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LifeBuoyIcon
              aria-hidden="true"
              className="size-5 text-teal-600 dark:text-teal-400"
            />
            تیکت جدید
          </DialogTitle>
          <DialogDescription>
            مشکل یا سؤال را شرح دهید؛ تیم پشتیبانی در همین تیکت پاسخ می‌دهد.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ticket-subject">عنوان</Label>
            <input
              id="ticket-subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="مثلاً: خطا در ثبت سفارش"
              maxLength={150}
              className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 md:text-sm"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ticket-category">دسته</Label>
              <select
                id="ticket-category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none focus-visible:border-ring md:text-sm"
              >
                {TICKET_CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {TICKET_CATEGORY_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ticket-priority">اولویت</Label>
              <select
                id="ticket-priority"
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
                className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none focus-visible:border-ring md:text-sm"
              >
                {TICKET_PRIORITIES.map((value) => (
                  <option key={value} value={value}>
                    {TICKET_PRIORITY_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ticket-description">شرح مشکل</Label>
            <textarea
              id="ticket-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="چه کاری انجام می‌دادید و چه اتفاقی افتاد؟"
              rows={4}
              className="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-base leading-6 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 md:text-sm"
            />
          </div>

          {attachment ? (
            <div className="relative overflow-hidden rounded-lg border border-border/80">
              <img
                src={attachment}
                alt="پیوست تیکت"
                className="max-h-44 w-full object-cover"
              />
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => setAttachment(null)}
                className="absolute end-2 top-2"
              >
                <Trash2Icon aria-hidden="true" />
                حذف تصویر
              </Button>
            </div>
          ) : (
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={pickFile}
            />
          )}
        </div>

        <DialogFooter showCloseButton>
          {!attachment ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => fileRef.current?.click()}
            >
              <PaperclipIcon aria-hidden="true" className="size-4" />
              پیوست تصویر
            </Button>
          ) : null}
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
          >
            {submitting ? "در حال ارسال…" : "ثبت تیکت"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
