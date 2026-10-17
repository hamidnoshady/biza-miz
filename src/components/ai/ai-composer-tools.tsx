"use client";

/**
 * AI Hub composer message-level tools (Issue #145 & Issue #905):
 * - Search restricted to this business's own reports and the caller's own past
 *   conversations.
 * - Per-message "allow action" toggle (`actionsAllowed`).
 *
 * Issue #905 (2026-10-17 owner UX correction): these tools are hosted inside
 * the composer's consolidated `+` menu rather than as standalone search/gear
 * icon buttons on the composer bar.
 */
import { useCallback, useEffect, useState } from "react";
import {
  BarChart3Icon,
  MessageSquareIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AssistantMode } from "./use-ai-chat";

export interface SearchResponse {
  conversations?: { id: string; title: string }[];
  reports?: { key: string; label: string }[];
}

export function useAiComposerSearch(enabled: boolean) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setResults(null);
      setSearching(false);
      return;
    }
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      fetch(`/api/ai/search?q=${encodeURIComponent(q)}`)
        .then((response) => response.json())
        .then((data: SearchResponse) => setResults(data))
        .catch(() => setResults({ conversations: [], reports: [] }))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [enabled, query]);

  const resetSearch = useCallback(() => {
    setQuery("");
    setResults(null);
    setSearching(false);
  }, []);

  const noResults = Boolean(
    !searching &&
      query.trim() &&
      results &&
      !results.conversations?.length &&
      !results.reports?.length,
  );

  return {
    query,
    setQuery,
    results,
    searching,
    noResults,
    resetSearch,
  };
}

export function AiComposerTools({
  mode,
  canPropose,
  disabled,
  actionsAllowed,
  onActionsAllowedChange,
  onSelectConversation,
  onSelectReportPrompt,
}: {
  mode: AssistantMode;
  canPropose: boolean;
  disabled?: boolean;
  actionsAllowed: boolean;
  onActionsAllowedChange: (allowed: boolean) => void;
  onSelectConversation: (id: string) => void;
  onSelectReportPrompt: (prompt: string) => void;
}) {
  const { query, setQuery, results, searching, noResults, resetSearch } =
    useAiComposerSearch(canPropose);

  if (!canPropose && mode !== "dashboard") return null;

  return (
    <div className="flex items-center gap-0.5">
      {canPropose ? (
        <DropdownMenu
          onOpenChange={(open) => {
            if (!open) resetSearch();
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={disabled}
              aria-label="جست‌وجو در گزارش‌ها و گفتگوهای قبلی"
              title="جست‌وجو در گزارش‌ها و گفتگوهای قبلی همین کسب‌وکار"
              className="rounded-full text-muted-foreground hover:text-foreground"
            >
              <SearchIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-72 p-2">
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.stopPropagation()}
              placeholder="جست‌وجو در گزارش‌ها و گفتگوهای قبلی…"
              className="mb-2 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-xs outline-none focus-visible:border-ring"
            />
            {searching ? (
              <div
                role="status"
                aria-live="polite"
                aria-busy="true"
                aria-label="در حال جست‌وجو"
                className="space-y-1.5 px-1 py-1"
              >
                <Skeleton aria-hidden="true" className="h-5 w-full rounded-md" />
                <Skeleton aria-hidden="true" className="h-5 w-4/5 rounded-md" />
              </div>
            ) : null}
            {noResults ? (
              <p className="px-1 py-1 text-[11px] text-muted-foreground">
                نتیجه‌ای یافت نشد.
              </p>
            ) : null}
            {results?.reports?.length ? (
              <div className="mb-1.5">
                <p className="px-1 pb-1 text-[10px] font-medium text-muted-foreground">
                  گزارش‌ها
                </p>
                {results.reports.map((report) => (
                  <button
                    key={report.key}
                    type="button"
                    onClick={() =>
                      onSelectReportPrompt(
                        `گزارش «${report.label}» را اجرا و خلاصه کن.`,
                      )
                    }
                    className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-right text-xs hover:bg-muted outline-none focus-visible:ring focus-visible:ring-ring/50"
                  >
                    <BarChart3Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{report.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {results?.conversations?.length ? (
              <div>
                <p className="px-1 pb-1 text-[10px] font-medium text-muted-foreground">
                  گفتگوهای قبلی
                </p>
                {results.conversations.map((conversation) => (
                  <button
                    key={conversation.id}
                    type="button"
                    onClick={() => onSelectConversation(conversation.id)}
                    className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-right text-xs hover:bg-muted outline-none focus-visible:ring focus-visible:ring-ring/50"
                  >
                    <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{conversation.title}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {canPropose ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={disabled}
              aria-label="تنظیمات این پیام"
              title="تنظیمات این پیام"
              className="rounded-full text-muted-foreground hover:text-foreground"
            >
              <SettingsIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-64 p-2.5">
            <label className="flex items-center justify-between gap-2 text-xs">
              <span className="leading-5">
                اجازهٔ اقدام در این پیام
                <span className="block text-[10px] text-muted-foreground">
                  خاموش‌کردن یعنی دستیار فقط پاسخ می‌دهد و در این پیام هیچ
                  پیشنهاد تغییری نمی‌سازد.
                </span>
              </span>
              <Switch
                checked={actionsAllowed}
                onCheckedChange={onActionsAllowedChange}
              />
            </label>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
