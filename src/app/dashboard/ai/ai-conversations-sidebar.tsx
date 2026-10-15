"use client";

/**
 * «گفتگوهای اخیر» — the private conversation history list for the assistant.
 *
 * Issue #905:
 * - Renders inside the canonical contextual sidebar on `/dashboard` (`embedded`)
 *   or inside the shared `Sheet` overlay on mobile / collapsed rail (`sheet`).
 * - Server-backed search (`?q=`) across permitted conversation titles and
 *   message contents, plus compound cursor pagination (`?before=&beforeId=`)
 *   for older history pages.
 * - Groups conversations into Today («امروز»), Yesterday («دیروز»), and Earlier
 *   («پیش‌تر») in the Persian/Shamsi calendar.
 * - Distinguishes loading, persistent inline error with Retry («تلاش مجدد»),
 *   search-empty, and empty-history states.
 * - Uses a keyboard- and touch-accessible row action menu (`DropdownMenu`) with
 *   inline rename and explicit labelled destructive confirmation (no false Undo
 *   for hard deletion).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RotateCcwIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingSkeleton } from "../page-chrome";
import { cn } from "@/lib/utils";
import { useFeatureLocked } from "@/components/feature-lock";
import {
  CONVERSATION_BUCKET_LABELS,
  conversationDateBucket,
  formatDateTime,
  type ConversationDateBucket,
} from "./format";

export interface ConversationSummary {
  id: string;
  mode: "wizard" | "dashboard" | "floor";
  title: string;
  lastMessageAt: string;
  createdAt: string;
  projectId?: string | null;
}

interface NextCursor {
  before: string;
  beforeId: string;
}

const BUCKET_ORDER: readonly ConversationDateBucket[] = [
  "today",
  "yesterday",
  "earlier",
];

export function AiConversationsSidebar({
  activeId,
  /** Bumped by the parent when a new conversation may have been created. */
  refreshToken,
  onSelect,
  onDeleted,
  onRenamed,
  onClose,
  embedded = false,
}: {
  activeId: string | null;
  refreshToken: number;
  onSelect: (id: string) => void;
  onDeleted?: (id: string) => void;
  onRenamed?: (conversation: ConversationSummary) => void;
  onClose?: () => void;
  embedded?: boolean;
}) {
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<NextCursor | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const locked = useFeatureLocked();
  const requestSeqRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setDebouncedQuery("");
      return;
    }
    const timer = window.setTimeout(() => {
      setDebouncedQuery(trimmed);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  const reload = useCallback(async () => {
    if (locked) {
      setItems([]);
      setError(null);
      setHasMore(false);
      setNextCursor(null);
      return;
    }
    const seq = ++requestSeqRef.current;
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "30", mode: "dashboard" });
      if (debouncedQuery) {
        params.set("q", debouncedQuery);
      }
      const response = await fetch(`/api/ai/conversations?${params.toString()}`);
      const data = (await response.json().catch(() => ({}))) as {
        conversations?: ConversationSummary[];
        hasMore?: boolean;
        nextCursor?: NextCursor | null;
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        throw new Error(data.message ?? "خواندن گفتگوهای اخیر ممکن نشد.");
      }
      if (requestSeqRef.current !== seq) return;
      const list = (data.conversations ?? []).filter(
        (item) => item.mode === "dashboard",
      );
      setItems(list);
      setHasMore(Boolean(data.hasMore));
      setNextCursor(data.nextCursor ?? null);
    } catch (reason) {
      if (requestSeqRef.current !== seq) return;
      const msg =
        reason instanceof Error && reason.message
          ? reason.message
          : "خواندن گفتگوهای اخیر ممکن نشد.";
      setError(msg);
      setItems((current) => current ?? []);
    }
  }, [debouncedQuery, locked]);

  useEffect(() => {
    void reload();
  }, [reload, refreshToken]);

  async function loadOlder() {
    if (locked || loadingMore || !hasMore || !nextCursor) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        limit: "30",
        mode: "dashboard",
        before: nextCursor.before,
        beforeId: nextCursor.beforeId,
      });
      if (debouncedQuery) {
        params.set("q", debouncedQuery);
      }
      const response = await fetch(`/api/ai/conversations?${params.toString()}`);
      const data = (await response.json().catch(() => ({}))) as {
        conversations?: ConversationSummary[];
        hasMore?: boolean;
        nextCursor?: NextCursor | null;
        message?: string;
      };
      if (!response.ok) {
        throw new Error(data.message ?? "خواندن گفتگوهای قدیمی‌تر ممکن نشد.");
      }
      const older = (data.conversations ?? []).filter(
        (item) => item.mode === "dashboard",
      );
      setItems((current) => {
        const existing = current ?? [];
        const seen = new Set(existing.map((i) => i.id));
        return [...existing, ...older.filter((i) => !seen.has(i.id))];
      });
      setHasMore(Boolean(data.hasMore));
      setNextCursor(data.nextCursor ?? null);
    } catch (reason) {
      toast.error(
        reason instanceof Error ? reason.message : "خواندن گفتگوهای قدیمی‌تر ممکن نشد.",
      );
    } finally {
      setLoadingMore(false);
    }
  }

  // While debounce is settling, also apply immediate client substring match if
  // the user just typed a character, while server results replace `items`.
  const visibleItems = useMemo(() => {
    const base = items ?? [];
    const trimmed = query.trim();
    if (!trimmed || trimmed === debouncedQuery) return base;
    return base.filter((item) => item.title.includes(trimmed));
  }, [debouncedQuery, items, query]);

  const grouped = useMemo(() => {
    const now = new Date();
    const map: Record<ConversationDateBucket, ConversationSummary[]> = {
      today: [],
      yesterday: [],
      earlier: [],
    };
    for (const item of visibleItems) {
      const bucket = conversationDateBucket(item.lastMessageAt, now);
      map[bucket].push(item);
    }
    return BUCKET_ORDER.map((bucket) => ({
      bucket,
      label: CONVERSATION_BUCKET_LABELS[bucket],
      items: map[bucket],
    })).filter((group) => group.items.length > 0);
  }, [visibleItems]);

  async function submitRename(id: string) {
    const title = renameValue.replace(/\s+/g, " ").trim();
    if (!title) {
      toast.error("عنوان گفتگو نمی‌تواند خالی باشد.");
      return;
    }
    setBusyId(id);
    try {
      const response = await fetch(`/api/ai/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        conversation?: ConversationSummary;
        error?: string;
        message?: string;
      };
      if (!response.ok || !data.conversation) {
        throw new Error(data.message ?? "تغییر نام ممکن نشد.");
      }
      const renamed = data.conversation;
      setItems((current) =>
        (current ?? []).map((item) =>
          item.id === renamed.id ? { ...item, title: renamed.title } : item,
        ),
      );
      onRenamed?.(renamed);
      setRenamingId(null);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "تغییر نام ممکن نشد.");
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDeleteConversation(id: string) {
    setBusyId(id);
    try {
      const response = await fetch(`/api/ai/conversations/${id}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("حذف گفتگو ممکن نشد.");
      setItems((current) => (current ?? []).filter((item) => item.id !== id));
      onDeleted?.(id);
      toast.success("گفتگو برای همیشه حذف شد.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "حذف گفتگو ممکن نشد.");
    } finally {
      setDeletingId(null);
      setBusyId(null);
    }
  }

  const isEmbedded = embedded;

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col",
        isEmbedded && "pt-1",
      )}
      aria-label="گفتگوهای اخیر"
    >
      {!isEmbedded ? (
        <div className="flex items-center gap-2 border-b border-border/80 px-3 py-2.5">
          <MessageSquareIcon aria-hidden="true" className="size-4 shrink-0 text-primary" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-foreground">
            گفتگوهای اخیر
          </p>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="بستن گفتگوهای اخیر"
              className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45"
            >
              <XIcon className="size-4" />
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex items-center justify-between px-2 pb-1 pt-1">
          <span className="text-[11px] font-semibold text-muted-foreground">
            گفتگوهای اخیر
          </span>
        </div>
      )}

      <div className={cn("py-1.5", isEmbedded ? "px-1" : "px-2.5 py-2")}>
        <div className="relative">
          <SearchIcon
            aria-hidden="true"
            className="absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="جست‌وجوی گفتگو…"
            aria-label="جست‌وجوی گفتگو"
            className="w-full rounded-lg border border-border/80 bg-card py-1.5 pe-7 ps-8 text-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-amber-400/60 focus-visible:ring-2 focus-visible:ring-amber-500/30"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="پاک کردن جست‌وجو"
              className="absolute end-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          ) : null}
        </div>
      </div>

      <div
        className={cn(
          "ai-chat-scroll min-h-0 flex-1 overflow-y-auto pb-3",
          isEmbedded ? "px-1" : "px-2",
        )}
      >
        {items === null && !error ? (
          <LoadingSkeleton
            rows={4}
            className="px-1 py-2"
            label="در حال خواندن گفتگوها"
          />
        ) : error ? (
          <div
            role="alert"
            className="mx-1 my-2 rounded-xl border border-destructive/35 bg-destructive/10 p-3 text-xs text-destructive"
          >
            <div className="flex items-start gap-2">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-medium leading-5">{error}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void reload()}
                  className="mt-2 h-7 gap-1.5 px-2.5 text-[11px]"
                >
                  <RotateCcwIcon className="size-3" aria-hidden="true" />
                  تلاش مجدد
                </Button>
              </div>
            </div>
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="px-2 py-6 text-center">
            <MessageSquareIcon
              aria-hidden="true"
              className="mx-auto size-7 text-muted-foreground/40"
            />
            <p className="mt-2 whitespace-pre-line text-xs leading-5 text-muted-foreground">
              {query.trim()
                ? "گفتگویی با این عبارت پیدا نشد."
                : "هنوز گفتگویی ثبت نشده است.\nاولین پرسش خود را بپرسید."}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {grouped.map((group) => (
              <div key={group.bucket} className="space-y-0.5">
                <p className="px-2 py-1 text-[10px] font-semibold text-muted-foreground">
                  {group.label}
                </p>
                <ul className="space-y-0.5">
                  {group.items.map((item) => {
                    const active = item.id === activeId;
                    const renaming = renamingId === item.id;
                    const confirmingDelete = deletingId === item.id;
                    return (
                      <li key={item.id}>
                        {renaming ? (
                          <div className="flex items-center gap-1 rounded-lg border border-amber-300/70 bg-amber-50/60 px-1.5 py-1 dark:border-amber-500/30 dark:bg-amber-500/10">
                            <input
                              autoFocus
                              value={renameValue}
                              onChange={(event) => setRenameValue(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void submitRename(item.id);
                                }
                                if (event.key === "Escape") setRenamingId(null);
                              }}
                              aria-label="عنوان جدید گفتگو"
                              className="min-w-0 flex-1 bg-transparent px-1 py-0.5 text-xs outline-none"
                              maxLength={60}
                            />
                            <button
                              type="button"
                              onClick={() => void submitRename(item.id)}
                              disabled={busyId === item.id}
                              aria-label="ذخیرهٔ عنوان"
                              className="grid size-6 shrink-0 place-items-center rounded-md text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-300"
                            >
                              <CheckIcon className="size-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setRenamingId(null)}
                              aria-label="انصراف"
                              className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
                            >
                              <XIcon className="size-3.5" />
                            </button>
                          </div>
                        ) : confirmingDelete ? (
                          <div
                            role="alertdialog"
                            aria-label={`تأیید حذف دائمی «${item.title}»`}
                            className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs"
                          >
                            <p className="font-medium leading-5 text-foreground">
                              حذف همیشگی «{item.title}»؟
                            </p>
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => setDeletingId(null)}
                                disabled={busyId === item.id}
                                className="rounded-md border border-border/80 bg-background px-2 py-1 text-[11px] font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                انصراف
                              </button>
                              <button
                                type="button"
                                onClick={() => void confirmDeleteConversation(item.id)}
                                disabled={busyId === item.id}
                                aria-label={`حذف همیشگی «${item.title}»`}
                                className="rounded-md bg-destructive px-2 py-1 text-[11px] font-semibold text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                حذف همیشگی
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div
                            className={cn(
                              "group/conv flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors",
                              active
                                ? "bg-amber-100 dark:bg-amber-500/20"
                                : "hover:bg-amber-50 dark:hover:bg-amber-500/10",
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => onSelect(item.id)}
                              title={item.title}
                              aria-current={active ? "page" : undefined}
                              className="min-w-0 flex-1 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 rounded"
                            >
                              <span
                                className={cn(
                                  "block truncate text-xs font-medium leading-5",
                                  active
                                    ? "text-amber-700 dark:text-amber-300"
                                    : "text-foreground/85",
                                )}
                              >
                                {item.title}
                              </span>
                              <span className="block truncate text-[10px] leading-4 text-muted-foreground">
                                {formatDateTime(item.lastMessageAt)}
                              </span>
                            </button>

                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  aria-label={`گزینه‌های گفتگو «${item.title}»`}
                                  title="گزینه‌های گفتگو"
                                  className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45"
                                >
                                  <MoreHorizontalIcon className="size-4" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-40 p-1">
                                <DropdownMenuItem
                                  onClick={() => {
                                    setRenamingId(item.id);
                                    setRenameValue(item.title);
                                    setDeletingId(null);
                                  }}
                                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs"
                                >
                                  <PencilIcon className="size-3.5" />
                                  <span>تغییر نام</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => {
                                    setDeletingId(item.id);
                                    setRenamingId(null);
                                  }}
                                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-destructive focus:text-destructive"
                                >
                                  <Trash2Icon className="size-3.5" />
                                  <span>حذف گفتگو</span>
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}

            {hasMore ? (
              <div className="pt-1 text-center">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={loadingMore}
                  onClick={() => void loadOlder()}
                  className="h-8 w-full gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  <ChevronDownIcon className="size-3.5" aria-hidden="true" />
                  {loadingMore ? "در حال خواندن…" : "نمایش گفتگوهای قدیمی‌تر"}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {!isEmbedded ? (
        <p className="border-t border-border/80 px-3 py-2 text-[10px] leading-4 text-muted-foreground">
          گفتگوها فقط برای شما قابل مشاهده‌اند.
        </p>
      ) : null}
    </div>
  );
}
