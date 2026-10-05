"use client";

/**
 * The AI assistant's chat surface — a ChatGPT-style column (Phase 36b
 * revision, redesigned again in Phase 36c with the shared bubble/composer
 * components), and now the one canonical assistant experience: it IS the
 * dashboard. The retired `/ai` application forwarded here.
 *
 * A slim header (new chat + the owner/manager «مدیریت دستیار» control that
 * opens the `?aiPanel=` management drawer), a scrollable bubble thread, and
 * the shared composer pinned to the bottom of the column. The welcome state
 * is a hero with floating gradient orbs and task-aware starter cards.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowDownIcon,
  HistoryIcon,
  MessageSquarePlusIcon,
  PanelLeftIcon,
  Settings2Icon,
  SparklesIcon,
} from "lucide-react";
import { LoadingSkeleton } from "../page-chrome";
import { useGSAP } from "@gsap/react";
import { useMoney } from "@/components/money/money-context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useFeatureLocked } from "@/components/feature-lock";
import { ChatComposer } from "@/components/ai/chat-composer";
import { ChatBubble } from "@/components/ai/chat-bubble";
import { animateFloat, animateStaggerIn } from "@/components/ai/chat-animations";
import { useStickyScroll } from "@/components/ai/use-sticky-scroll";
import { SUGGESTED_PROMPTS, taskById, taskSuggestions } from "@/lib/ai-tasks";
import {
  AI_PANEL_PARAM,
  isAiPanelSectionKey,
  type AiPanelSectionKey,
} from "@/lib/ai-panel";
import { useAiChat, type AiAppFocus } from "@/components/ai/use-ai-chat";
import { AI_REASONING_MODES, AI_MODE_LABELS, isAiReasoningMode, type AiReasoningMode } from "@/lib/ai-reasoning";
import { AiManagementSheet } from "./ai-management-sheet";
import { AiConversationsSidebar } from "./ai-conversations-sidebar";
import { AiWorkspaceWidgets } from "./ai-workspace-widgets";
import { AiWorkspaceContext } from "./ai-workspace-context";
import { cardClass, overlayPanelClass } from "../page-chrome";

export function AiChatHub({
  canManageAi = false,
  canAutoApply = false,
}: {
  /** Owner/manager: shows the «مدیریت دستیار» control and honours `?aiPanel=`. */
  canManageAi?: boolean;
  /** Owner only: coworker jobs and automations may apply unattended. */
  canAutoApply?: boolean;
}) {
  const locked = useFeatureLocked();
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusFromUrl = searchParams.get("focus");
  const reasoningFromUrl = searchParams.get("reasoning");
  const [appFocus, setAppFocus] = useState<AiAppFocus>(() =>
    ["all", "accounting", "growth", "crm", "website", "workspace"].includes(focusFromUrl ?? "")
      ? (focusFromUrl as AiAppFocus)
      : "all",
  );
  // Phase F — `?project=<id>` starts new conversations inside that project's
  // workspace, so their turns are shaped by the project's instruction, notes
  // and memory.
  const chat = useAiChat({
    mode: "dashboard",
    projectId: searchParams.get("project"),
    appFocus,
    reasoningMode: isAiReasoningMode(reasoningFromUrl) && reasoningFromUrl !== "deep_research" ? reasoningFromUrl : "auto",
    onConversationIdChange: (id) => {
      const params = new URLSearchParams(searchParams.toString());
      if (id) params.set("conversation", id);
      else params.delete("conversation");
      const query = params.toString();
      router.replace(query ? `/dashboard?${query}` : "/dashboard", { scroll: false });
    },
  });

  // The management panel is addressed by the URL (`/dashboard?aiPanel=
  // <section>`, the same address `aiPanelHref` and the legacy `/ai/<section>`
  // redirects produce), so it survives bookmarks and the back button without a
  // second state tree of its own. A member who may not manage the assistant
  // simply never has a panel, whatever the URL says.
  const panelParam = searchParams.get(AI_PANEL_PARAM);
  const panelSection: AiPanelSectionKey | null =
    canManageAi && isAiPanelSectionKey(panelParam) ? panelParam : null;

  const replaceParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      const query = params.toString();
      router.replace(query ? `/dashboard?${query}` : "/dashboard", { scroll: false });
    },
    [router, searchParams],
  );
  const openPanel = useCallback(
    (key: AiPanelSectionKey) => replaceParams((params) => params.set(AI_PANEL_PARAM, key)),
    [replaceParams],
  );
  const closePanel = useCallback(
    () => replaceParams((params) => params.delete(AI_PANEL_PARAM)),
    [replaceParams],
  );
  const updateAppFocus = useCallback((value: AiAppFocus) => {
    setAppFocus(value);
    replaceParams((params) => {
      if (value === "all") params.delete("focus");
      else params.set("focus", value);
    });
  }, [replaceParams]);
  const money = useMoney();
  // Issue #812 §18 — sticky scrolling: the thread follows new content only
  // while the reader is already at the bottom, and never yanks them down while
  // they are reading an earlier answer.
  const { containerRef: scrollRef, atBottom: atThreadBottom, scrollToBottom, jumpToLatest, onScroll: onThreadScroll } =
    useStickyScroll();
  const heroRef = useRef<HTMLDivElement>(null);
  const orbLeftRef = useRef<HTMLDivElement>(null);
  const orbRightRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  // «گفتگوهای اخیر» — the history sidebar on the chat page's end (left in
  // RTL) side. Phones get it as a modal sheet (the toggle lives in the same
  // header as «گفت‌وگوی جدید»); desktops get an inline, collapsible column.
  // The workspace rail carries no chat history any more.
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [historySheetOpen, setHistorySheetOpen] = useState(false);
  const [historyRefresh, setHistoryRefresh] = useState(0);

  const {
    canPropose,
    messages,
    input,
    setInput,
    busy,
    applyingId,
    conversationId,
    loadingConversation,
    attachments,
    attachFiles,
    clearAttachment,
    actionsAllowed,
    setActionsAllowed,
    task,
    setTask,
    customTask,
    setCustomTask,
    reasoningMode,
    setReasoningMode,
    agentId,
    setAgentId,
    ensureGreeting,
    startNewConversation,
    loadConversation,
    sendMessage,
    cancelGeneration,
    askAgain,
    applyProposal,
    dismissProposal,
    submitInputRequest,
    dismissInputRequest,
  } = chat;

  const updateReasoningMode = useCallback((value: AiReasoningMode) => {
    setReasoningMode(value);
    replaceParams((params) => {
      if (value === "auto") params.delete("reasoning");
      else params.set("reasoning", value);
    });
  }, [replaceParams, setReasoningMode]);

  useEffect(() => {
    if (["all", "accounting", "growth", "crm", "website", "workspace"].includes(focusFromUrl ?? "")) {
      setAppFocus(focusFromUrl as AiAppFocus);
    }
    if (isAiReasoningMode(reasoningFromUrl) && reasoningFromUrl !== "deep_research") {
      setReasoningMode(reasoningFromUrl);
    }
  }, [focusFromUrl, reasoningFromUrl, setReasoningMode]);

  const changeProject = useCallback((nextProjectId: string | null) => {
    if (nextProjectId === searchParams.get("project")) return;
    startNewConversation();
    replaceParams((params) => {
      if (nextProjectId) params.set("project", nextProjectId);
      else params.delete("project");
      params.delete("conversation");
    });
  }, [replaceParams, searchParams, startNewConversation]);

  useEffect(() => {
    if (!initialized.current) return;
    // Switching threads (or starting a new one) is an explicit jump, so the
    // newest message is shown regardless of where the reader had scrolled to.
    scrollToBottom({ force: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const requested = locked ? null : searchParams.get("conversation");
    const ctx = searchParams.get("ctx");
    if (ctx) {
      setInput(ctx);
      ensureGreeting();
    } else if (requested) {
      void loadConversation(requested);
    } else {
      ensureGreeting();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // §18 — follow new content only when the reader is already pinned to the
  // bottom. A conversation switch forces the jump (that IS the new content).
  useEffect(() => {
    scrollToBottom({ smooth: true });
  }, [messages, scrollToBottom]);

  // The history list re-reads when a conversation becomes active (a new thread
  // was just created) and when a turn finishes on one (its thread jumped to
  // the top). Skipping the first run keeps the mount-time double fetch away.
  const lastConversationId = useRef<string | null>(null);
  const wasBusy = useRef(false);
  useEffect(() => {
    const conversationChanged = lastConversationId.current !== conversationId;
    const turnFinished = wasBusy.current && !busy;
    lastConversationId.current = conversationId;
    wasBusy.current = busy;
    if (conversationChanged || turnFinished) setHistoryRefresh((token) => token + 1);
  }, [conversationId, busy]);

  const isWelcome =
    messages.length === 1 && messages[0]?.role === "assistant" && !busy && !loadingConversation;

  // Hero choreography: cards stagger up while two gradient orbs drift.
  useGSAP(
    () => {
      if (!isWelcome) return;
      if (heroRef.current) animateStaggerIn(heroRef.current, "[data-hero]");
      if (orbLeftRef.current) animateFloat(orbLeftRef.current, { x: 24, y: -18 }, 7);
      if (orbRightRef.current) animateFloat(orbRightRef.current, { x: -30, y: 22 }, 9);
    },
    { scope: heroRef, dependencies: [isWelcome] },
  );

  const suggestions = taskSuggestions(task, "dashboard", SUGGESTED_PROMPTS.dashboard);
  const taskLabel = task === "custom" && customTask ? "وظیفهٔ سفارشی" : taskById(task)?.label;

  /** Continue a thread from the history sidebar. */
  const openFromHistory = useCallback(
    (id: string) => {
      setHistorySheetOpen(false);
      void loadConversation(id);
    },
    [loadConversation],
  );

  /** The history sidebar body — shared by the desktop column and the phone sheet. */
  const historyPanel = (onClose?: () => void) => (
    <AiConversationsSidebar
      activeId={conversationId}
      refreshToken={historyRefresh}
      onSelect={openFromHistory}
      onClose={onClose}
      onDeleted={(id) => {
        if (id === conversationId) startNewConversation();
      }}
      onRenamed={() => setHistoryRefresh((token) => token + 1)}
    />
  );

  return (
    <section className="grid h-full min-h-0 w-full grid-cols-1 grid-rows-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_18rem] lg:grid-rows-[minmax(0,1fr)_auto]">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-h-12 items-center gap-2 border-b border-border/80 bg-card/80 px-2 py-1.5 backdrop-blur sm:px-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">دستیار هوشمند</p>
          {taskLabel ? (
            <p className="truncate text-[10px] text-muted-foreground">وظیفهٔ فعلی: {taskLabel}</p>
          ) : null}
        </div>
        {/* History lives in the LEFT sidebar; its doors are here in the header,
            beside the one «گفت‌وگوی جدید» control. The rail no longer offers
            either. */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setHistorySheetOpen(true)}
          aria-label="گفتگوهای اخیر"
          title="گفتگوهای اخیر"
          className="gap-1.5 px-2.5 lg:hidden"
        >
          <HistoryIcon className="size-4 shrink-0" aria-hidden="true" />
        </Button>
        <Button
          variant={historyCollapsed ? "outline" : "secondary"}
          size="sm"
          onClick={() => setHistoryCollapsed((collapsed) => !collapsed)}
          aria-expanded={!historyCollapsed}
          aria-label={historyCollapsed ? "نمایش گفتگوهای اخیر" : "پنهان‌کردن گفتگوهای اخیر"}
          title={historyCollapsed ? "نمایش گفتگوهای اخیر" : "پنهان‌کردن گفتگوهای اخیر"}
          className="hidden gap-1.5 px-2.5 lg:inline-flex"
        >
          <PanelLeftIcon className="size-4 shrink-0" aria-hidden="true" />
        </Button>
        {canManageAi ? (
          <Button
            variant={panelSection ? "secondary" : "outline"}
            size="sm"
            onClick={() => openPanel(panelSection ?? "agents")}
            aria-expanded={panelSection !== null}
            aria-label="مدیریت دستیار"
            title="مدیریت دستیار: ایجنت‌ها، همکاران، اتوماسیون‌ها، دانش و مصرف"
            className="gap-1.5 px-2.5 sm:px-3"
          >
            <Settings2Icon className="size-4 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">مدیریت دستیار</span>
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          onClick={startNewConversation}
          className="gap-1.5 px-2.5 sm:px-3"
        >
          <MessageSquarePlusIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline">گفت‌وگوی جدید</span>
        </Button>
      </header>
      <AiWorkspaceContext
        appFocus={appFocus}
        onAppFocusChange={updateAppFocus}
        reasoningMode={reasoningMode}
        onReasoningModeChange={updateReasoningMode}
        projectId={searchParams.get("project")}
        onProjectChange={changeProject}
      />

      <AiManagementSheet
        section={panelSection}
        canAutoApply={canAutoApply}
        onSectionChange={openPanel}
        onClose={closePanel}
      />

      <div
        ref={scrollRef}
        onScroll={onThreadScroll}
        className="ai-chat-scroll relative min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-4 sm:px-6"
      >
        {loadingConversation ? (
          <LoadingSkeleton
            rows={6}
            className="mx-auto w-full max-w-3xl py-6"
            label="در حال بازکردن مکالمه"
          />
        ) : isWelcome ? (
          <div ref={heroRef} className="relative mx-auto flex min-h-[60vh] max-w-3xl flex-col items-center justify-center overflow-hidden text-center">
            {/* Drifting gradient orbs — pure decoration. */}
            <div
              ref={orbLeftRef}
              aria-hidden="true"
              className="pointer-events-none absolute -top-10 right-[12%] size-56 rounded-full bg-primary/15 blur-3xl"
            />
            <div
              ref={orbRightRef}
              aria-hidden="true"
              className="pointer-events-none absolute bottom-0 left-[8%] size-44 rounded-full bg-amber-300/20 dark:bg-amber-500/35 blur-3xl"
            />

            <div
              data-hero
              className="grid size-16 place-items-center rounded-3xl bg-gradient-to-br from-primary to-primary/70 text-primary-foreground shadow-[0_1px_2px_rgb(41_37_36/0.035)]"
            >
              <SparklesIcon className="size-8" aria-hidden />
            </div>
            <h1
              data-hero
              className="mt-6 bg-gradient-to-b from-foreground to-foreground/60 bg-clip-text text-2xl font-bold tracking-tight text-transparent sm:text-[1.8rem]"
            >
              امروز چطور می‌توانم کمکتان کنم؟
            </h1>
            <p data-hero className="mt-2 text-sm leading-6 text-muted-foreground">
              درباره فروش، موجودی، هزینه‌ها و عملکرد کسب‌وکارتان سؤال کنید — یا
              وظیفهٔ دستیار را از کادر پایین عوض کنید.
            </p>
            <div data-hero className="mt-8 grid w-full gap-3 sm:grid-cols-3">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void sendMessage(suggestion)}
                  className={cn(
                    cardClass,
                    "min-h-24 p-4 text-start text-sm leading-6 text-foreground/80 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40",
                  )}
                >
                  <span className="mb-3 grid size-8 place-items-center rounded-xl bg-amber-100/70 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300">
                    <SparklesIcon className="size-4" aria-hidden />
                  </span>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-5">
            {messages.map((message, index) => {
              if (index === 0 && message.role === "assistant") return null;
              return (
                <ChatBubble
                  key={message.id}
                  message={message}
                  busy={busy && index === messages.length - 1}
                  canPropose={canPropose}
                  applyingId={applyingId}
                  formatCost={(rial) => money.format(rial)}
                  applyProposal={applyProposal}
                  dismissProposal={dismissProposal}
                  submitInputRequest={submitInputRequest}
                  dismissInputRequest={dismissInputRequest}
                  onAskAgain={
                    message.cacheNotice
                      ? () => {
                          const question = messages
                            .slice(0, Math.max(0, index))
                            .reverse()
                            .find((item) => item.role === "user")?.content;
                          if (question) void askAgain(question);
                        }
                      : undefined
                  }
                />
              );
            })}
          </div>
        )}

        {/* Issue #812 §18 — «برو به آخرین پیام». Shown only once the reader has
            scrolled up past the sticky threshold, so the thread stops fighting
            them without losing the way back. */}
        {!atThreadBottom && messages.length > 1 ? (
          <div className="pointer-events-none sticky bottom-2 z-10 flex justify-center">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={jumpToLatest}
              className="pointer-events-auto gap-1.5 rounded-full border-border bg-card/95 shadow-[0_1px_2px_rgb(41_37_36/0.035)] backdrop-blur"
            >
              <ArrowDownIcon className="size-3.5" aria-hidden />
              برو به آخرین پیام
            </Button>
          </div>
        ) : null}
      </div>

      <div className="border-t border-border/80 bg-card/80 px-2 py-2 backdrop-blur sm:px-4 sm:py-3">
        <div className="mx-auto max-w-3xl">
          <ChatComposer
            mode="dashboard"
            input={input}
            setInput={setInput}
            busy={busy || loadingConversation}
            canPropose={canPropose}
            attachments={attachments}
            onAttachFiles={(files) => void attachFiles(files)}
            onClearAttachment={clearAttachment}
            task={task}
            onTaskChange={setTask}
            customTask={customTask}
            onCustomTaskChange={setCustomTask}
            agentId={agentId}
            onAgentChange={setAgentId}
            actionsAllowed={actionsAllowed}
            setActionsAllowed={setActionsAllowed}
            loadConversation={loadConversation}
            sendMessage={sendMessage}
            onCancelGeneration={cancelGeneration}
            cancellable={busy}
            footer={
              <p className="mt-2 text-center text-[11px] text-muted-foreground">
                پاسخ‌ها بر اساس داده‌های ثبت‌شده کسب‌وکار شما ارائه می‌شوند.
              </p>
            }
          />
        </div>
      </div>
      </div>

      {/* Desktop — the history column on the chat's end (left in RTL) side. */}
      {historyCollapsed ? null : (
        <aside
          aria-label="گفتگوهای اخیر"
          className="hidden w-72 shrink-0 border-s border-border/80 bg-card/70 backdrop-blur lg:flex lg:flex-col"
        >
          {historyPanel()}
        </aside>
      )}

      <AiWorkspaceWidgets />

      {/* Phone — the same list as a modal sheet over the chat. */}
      {historySheetOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="گفتگوهای اخیر">
          <div
            aria-hidden="true"
            onClick={() => setHistorySheetOpen(false)}
            className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
          />
          <div
            className={cn(
              "absolute inset-y-0 start-0 flex w-[min(20rem,85vw)] flex-col rounded-none rounded-e-2xl",
              overlayPanelClass,
            )}
          >
            {historyPanel(() => setHistorySheetOpen(false))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
