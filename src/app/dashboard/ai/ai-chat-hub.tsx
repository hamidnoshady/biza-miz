"use client";

/**
 * The AI assistant's canonical chat surface (`/dashboard`, Issue #905 redesign).
 *
 * Architecture:
 * - Single spacious chat canvas with a slim header (assistant/task identity,
 *   conversation title, optional active context chips, New Chat, on-demand
 *   History Sheet, on-demand Widgets Sheet, and Management Sheet).
 * - Contextual conversation history is integrated into the single canonical
 *   workspace sidebar (`DashboardSidebar`) via `assistant-sidebar-bridge.ts`,
 *   with an accessible `Sheet` fallback for mobile and collapsed-rail states.
 * - One shared `ChatComposer` instance stays mounted across Welcome -> Active
 *   Thread transitions so focus and draft text are never lost.
 * - Welcome layout sizes against actual available container height (`mt-auto` /
 *   `mb-auto` inside the flex scroll container, no `min-h-[60vh]`, no decorative
 *   floating orbs or gradient text).
 * - Starter cards fill the composer draft and focus the input rather than
 *   immediately sending a billed request.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowDownIcon,
  FolderKanbanIcon,
  HistoryIcon,
  LayoutGridIcon,
  MessageSquarePlusIcon,
  Settings2Icon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useGSAP } from "@gsap/react";
import { LoadingSkeleton, cardClass } from "../page-chrome";
import { useMoney } from "@/components/money/money-context";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useFeatureLocked } from "@/components/feature-lock";
import { ChatComposer } from "@/components/ai/chat-composer";
import { ChatBubble } from "@/components/ai/chat-bubble";
import { animateStaggerIn } from "@/components/ai/chat-animations";
import { useStickyScroll } from "@/components/ai/use-sticky-scroll";
import {
  SUGGESTED_PROMPTS,
  resolveAccessibleFocuses,
  resolveEligibleTasks,
  resolveStarterPrompts,
  taskById,
  type AiTaskAppFocus,
  type AiTaskId,
} from "@/lib/ai-tasks";
import {
  AI_PANEL_PARAM,
  isAiPanelSectionKey,
  type AiPanelSectionKey,
} from "@/lib/ai-panel";
import {
  normalizeAiAppFocus,
  useAiChat,
  type AiAppFocus,
} from "@/components/ai/use-ai-chat";
import {
  isAiRuntimeModeAvailable,
  normalizeAiRuntimeMode,
  type AiRuntimeMode,
} from "@/lib/ai-runtime-modes-shared";
import { AiManagementSheet } from "./ai-management-sheet";
import { AiConversationsSidebar } from "./ai-conversations-sidebar";
import { AiWorkspaceWidgets } from "./ai-workspace-widgets";
import {
  APP_FOCUS_OPTIONS,
  AiWorkspaceContext,
  RUNTIME_MODE_LABELS,
} from "./ai-workspace-context";
import {
  resetAssistantSidebarBridge,
  setAssistantSidebarBridge,
} from "./assistant-sidebar-bridge";

export interface AiChatHubProps {
  /** Owner/manager or holder of section-specific AI management permissions. */
  canManageAi?: boolean;
  /** Owner only: coworker jobs and automations may apply unattended. */
  canAutoApply?: boolean;
  /** Per-section management permissions resolved on the server. */
  allowedPanelSections?: readonly AiPanelSectionKey[];
  /** Safe server-derived flag indicating whether platform Deep Research is active. */
  deepResearchEnabled?: boolean;
  /** Task IDs eligible for this tenant's industry, modules, features, and permissions. */
  eligibleTaskIds?: readonly AiTaskId[];
  /** Server-resolved starter prompts for the default welcome state. */
  starterPrompts?: readonly string[];
  /** App focuses accessible to this member. */
  accessibleFocuses?: readonly AiAppFocus[];
  /** Tenant's industry key for client-side contextual starter resolution. */
  industry?: string | null;
}

export function AiChatHub({
  canManageAi = false,
  canAutoApply = false,
  allowedPanelSections,
  deepResearchEnabled = false,
  eligibleTaskIds,
  starterPrompts,
  accessibleFocuses,
  industry = null,
}: AiChatHubProps) {
  const locked = useFeatureLocked();
  const router = useRouter();
  const searchParams = useSearchParams();
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);

  const rawFocusParam = searchParams.get("focus") ?? searchParams.get("app");
  const rawModeParam = searchParams.get("mode") ?? searchParams.get("reasoning");
  const projectFromUrl = searchParams.get("project")?.trim() || null;
  const conversationFromUrl = searchParams.get("conversation")?.trim() || null;
  const widgetsFromUrl = searchParams.get("widgets") === "1";

  const resolveValidMode = useCallback(
    (raw: string | null): AiRuntimeMode => {
      const normalized = normalizeAiRuntimeMode(raw);
      return isAiRuntimeModeAvailable(normalized, deepResearchEnabled)
        ? normalized
        : "auto";
    },
    [deepResearchEnabled],
  );

  const effectiveAccessibleFocuses = useMemo<
    readonly AiAppFocus[] | undefined
  >(() => {
    if (accessibleFocuses) {
      return accessibleFocuses;
    }
    if (eligibleTaskIds !== undefined) {
      return resolveAccessibleFocuses({
        mode: "dashboard",
        industry,
        eligibleTaskIds,
      }) as readonly AiAppFocus[];
    }
    return undefined;
  }, [accessibleFocuses, eligibleTaskIds, industry]);

  const canSelectProject =
    !effectiveAccessibleFocuses ||
    effectiveAccessibleFocuses.includes("workspace");

  const [appFocus, setAppFocus] = useState<AiAppFocus>(() =>
    normalizeAiAppFocus(rawFocusParam, effectiveAccessibleFocuses),
  );
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() =>
    canSelectProject ? projectFromUrl : null,
  );
  const [activeProjectName, setActiveProjectName] = useState<string | null>(null);
  const [widgetsSheetOpen, setWidgetsSheetOpen] = useState<boolean>(widgetsFromUrl);

  const latestSearchRef = useRef(searchParams.toString());
  useEffect(() => {
    latestSearchRef.current = searchParams.toString();
  }, [searchParams]);

  const replaceParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(latestSearchRef.current);
      mutate(params);
      const query = params.toString();
      latestSearchRef.current = query;
      router.replace(query ? `/dashboard?${query}` : "/dashboard", {
        scroll: false,
      });
    },
    [router],
  );

  const chat = useAiChat({
    mode: "dashboard",
    projectId: canSelectProject ? activeProjectId : null,
    appFocus,
    runtimeMode: resolveValidMode(rawModeParam),
    onConversationIdChange: (id) => {
      replaceParams((params) => {
        if (id) params.set("conversation", id);
        else params.delete("conversation");
      });
    },
    onConversationLoaded: (meta) => {
      setActiveProjectId(canSelectProject ? meta.projectId : null);
    },
  });

  const canOpenManagement =
    allowedPanelSections !== undefined
      ? allowedPanelSections.length > 0
      : canManageAi;
  const defaultPanelSection: AiPanelSectionKey =
    allowedPanelSections && allowedPanelSections.length > 0
      ? allowedPanelSections[0]!
      : "memory";

  const panelParam = searchParams.get(AI_PANEL_PARAM);
  const resolvePanelFromParam = useCallback(
    (raw: string | null): AiPanelSectionKey | null => {
      if (!canOpenManagement || !isAiPanelSectionKey(raw)) return null;
      if (
        allowedPanelSections &&
        allowedPanelSections.length > 0 &&
        !allowedPanelSections.includes(raw)
      ) {
        return allowedPanelSections[0]!;
      }
      return raw;
    },
    [allowedPanelSections, canOpenManagement],
  );

  const [panelSection, setPanelSection] = useState<AiPanelSectionKey | null>(
    () => resolvePanelFromParam(panelParam),
  );

  useEffect(() => {
    setPanelSection(resolvePanelFromParam(panelParam));
  }, [panelParam, resolvePanelFromParam]);

  const openPanel = useCallback(
    (key: AiPanelSectionKey) => {
      const resolved = resolvePanelFromParam(key);
      setPanelSection(resolved);
      if (resolved) {
        replaceParams((params) => params.set(AI_PANEL_PARAM, resolved));
      }
    },
    [replaceParams, resolvePanelFromParam],
  );
  const closePanel = useCallback(() => {
    setPanelSection(null);
    replaceParams((params) => params.delete(AI_PANEL_PARAM));
  }, [replaceParams]);

  const handleWidgetsOpenChange = useCallback(
    (open: boolean) => {
      setWidgetsSheetOpen(open);
      replaceParams((params) => {
        if (open) params.set("widgets", "1");
        else params.delete("widgets");
      });
    },
    [replaceParams],
  );

  const updateAppFocus = useCallback(
    (value: AiAppFocus) => {
      const normalized = normalizeAiAppFocus(value, effectiveAccessibleFocuses);
      setAppFocus(normalized);
      replaceParams((params) => {
        params.delete("app");
        if (normalized === "all") params.delete("focus");
        else params.set("focus", normalized);
      });
    },
    [effectiveAccessibleFocuses, replaceParams],
  );

  const money = useMoney();
  const {
    containerRef: scrollRef,
    atBottom: atThreadBottom,
    scrollToBottom,
    jumpToLatest,
    onScroll: onThreadScroll,
  } = useStickyScroll();
  const heroRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

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
    conversationTitle,
    setConversationTitle,
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
    runtimeMode,
    setRuntimeMode,
    ensureGreeting,
    startNewConversation,
    loadConversation,
    sendMessage,
    cancelGeneration,
    applyProposal,
    dismissProposal,
    submitInputRequest,
    dismissInputRequest,
  } = chat;

  const updateRuntimeMode = useCallback(
    (value: AiRuntimeMode) => {
      const valid = resolveValidMode(value);
      setRuntimeMode(valid);
      replaceParams((params) => {
        params.delete("reasoning");
        if (valid === "auto") params.delete("mode");
        else params.set("mode", valid);
      });
    },
    [replaceParams, resolveValidMode, setRuntimeMode],
  );

  // Normalize and sync URL parameters (`focus`, `mode`, `widgets`) when URL changes.
  useEffect(() => {
    const nextFocus = normalizeAiAppFocus(
      rawFocusParam,
      effectiveAccessibleFocuses,
    );
    setAppFocus(nextFocus);
    const nextMode = resolveValidMode(rawModeParam);
    setRuntimeMode(nextMode);
    setWidgetsSheetOpen(widgetsFromUrl);
  }, [
    effectiveAccessibleFocuses,
    rawFocusParam,
    rawModeParam,
    resolveValidMode,
    setRuntimeMode,
    widgetsFromUrl,
  ]);

  const handleNewConversation = useCallback(() => {
    startNewConversation();
    setActiveProjectId(canSelectProject ? projectFromUrl : null);
    replaceParams((params) => {
      params.delete("conversation");
      params.delete("ctx");
    });
    window.requestAnimationFrame(() => {
      composerInputRef.current?.focus();
    });
  }, [canSelectProject, projectFromUrl, replaceParams, startNewConversation]);

  const changeProject = useCallback(
    (nextProjectId: string | null) => {
      if (nextProjectId === activeProjectId) return;
      setActiveProjectId(nextProjectId);
      startNewConversation();
      replaceParams((params) => {
        if (nextProjectId) params.set("project", nextProjectId);
        else params.delete("project");
        params.delete("conversation");
      });
    },
    [activeProjectId, replaceParams, startNewConversation],
  );

  const openFromHistory = useCallback(
    (id: string) => {
      setHistorySheetOpen(false);
      void loadConversation(id);
    },
    [loadConversation],
  );

  // Sync with the canonical contextual sidebar (`DashboardSidebar`) on `/dashboard`.
  useEffect(() => {
    setAssistantSidebarBridge({
      activeConversationId: conversationId,
      refreshToken: historyRefresh,
      onSelectConversation: openFromHistory,
      onNewConversation: handleNewConversation,
      onDeleteConversation: (deletedId) => {
        if (deletedId === conversationId) {
          handleNewConversation();
        }
        setHistoryRefresh((token) => token + 1);
      },
      onRenameConversation: (renamed) => {
        if (renamed.id === conversationId) {
          setConversationTitle(renamed.title);
        }
        setHistoryRefresh((token) => token + 1);
      },
    });
  }, [
    conversationId,
    handleNewConversation,
    historyRefresh,
    openFromHistory,
    setConversationTitle,
  ]);

  useEffect(() => {
    return () => {
      resetAssistantSidebarBridge();
    };
  }, []);

  useEffect(() => {
    if (!initialized.current) return;
    scrollToBottom({ force: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Initial mount & browser back/forward `?conversation=` reconciliation.
  const lastHandledUrlConversationRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      lastHandledUrlConversationRef.current = conversationFromUrl;
      const requested = locked ? null : conversationFromUrl;
      const ctx = searchParams.get("ctx");
      if (ctx) {
        setInput(ctx);
        ensureGreeting();
        window.requestAnimationFrame(() => {
          composerInputRef.current?.focus();
        });
      } else if (requested) {
        void loadConversation(requested);
      } else {
        ensureGreeting();
      }
      return;
    }

    // Reconcile external/popstate changes to `?conversation=` without loops.
    if (conversationFromUrl === lastHandledUrlConversationRef.current) return;
    lastHandledUrlConversationRef.current = conversationFromUrl;
    if (conversationFromUrl && conversationFromUrl !== conversationId && !locked) {
      void loadConversation(conversationFromUrl);
    } else if (!conversationFromUrl && conversationId) {
      startNewConversation();
    }
  }, [
    conversationFromUrl,
    conversationId,
    ensureGreeting,
    loadConversation,
    locked,
    searchParams,
    setInput,
    startNewConversation,
  ]);

  useEffect(() => {
    lastHandledUrlConversationRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    scrollToBottom({ smooth: true });
  }, [messages, scrollToBottom]);

  const lastConversationId = useRef<string | null>(null);
  const wasBusy = useRef(false);
  useEffect(() => {
    const conversationChanged = lastConversationId.current !== conversationId;
    const turnFinished = wasBusy.current && !busy;
    lastConversationId.current = conversationId;
    wasBusy.current = busy;
    if (conversationChanged || turnFinished) {
      setHistoryRefresh((token) => token + 1);
    }
  }, [conversationId, busy]);

  const isWelcome =
    messages.length <= 1 &&
    (messages.length === 0 || messages[0]?.role === "assistant") &&
    !busy &&
    !loadingConversation &&
    !conversationId;

  useGSAP(
    () => {
      if (!isWelcome) return;
      if (heroRef.current) animateStaggerIn(heroRef.current, "[data-hero]");
    },
    { scope: heroRef, dependencies: [isWelcome] },
  );

  const taskFocus: AiTaskAppFocus = appFocus;

  const focusScopedEligibleTaskIds = useMemo(() => {
    if (eligibleTaskIds === undefined && !industry && taskFocus === "all") {
      return undefined;
    }
    return resolveEligibleTasks(
      {
        mode: "dashboard",
        industry,
        eligibleTaskIds,
        accessibleFocuses: effectiveAccessibleFocuses as
          | readonly AiTaskAppFocus[]
          | undefined,
        appFocus: taskFocus,
      },
      { includeCustom: false, respectAppFocus: true },
    ).map((item) => item.id);
  }, [effectiveAccessibleFocuses, eligibleTaskIds, industry, taskFocus]);

  useEffect(() => {
    if (
      focusScopedEligibleTaskIds &&
      task !== "general" &&
      task !== "custom" &&
      !focusScopedEligibleTaskIds.includes(task)
    ) {
      setTask("general");
    }
  }, [focusScopedEligibleTaskIds, setTask, task]);

  const suggestions = useMemo(() => {
    if (
      task === "general" &&
      taskFocus === "all" &&
      (!activeProjectId || !canSelectProject) &&
      starterPrompts &&
      starterPrompts.length > 0
    ) {
      return starterPrompts.slice(0, 3);
    }
    return resolveStarterPrompts({
      mode: "dashboard",
      industry,
      appFocus: taskFocus,
      projectId: canSelectProject ? activeProjectId : null,
      task,
      eligibleTaskIds,
      accessibleFocuses: effectiveAccessibleFocuses as
        | readonly AiTaskAppFocus[]
        | undefined,
      fallback: starterPrompts ?? SUGGESTED_PROMPTS.dashboard,
      count: 3,
    });
  }, [
    activeProjectId,
    canSelectProject,
    effectiveAccessibleFocuses,
    eligibleTaskIds,
    industry,
    starterPrompts,
    task,
    taskFocus,
  ]);

  const taskLabel =
    task === "custom" && customTask
      ? "وظیفهٔ سفارشی"
      : task !== "general"
        ? taskById(task)?.label
        : null;

  const focusLabel =
    appFocus !== "all"
      ? APP_FOCUS_OPTIONS.find((item) => item.value === appFocus)?.label ?? null
      : null;

  const modeLabel =
    runtimeMode !== "auto" ? RUNTIME_MODE_LABELS[runtimeMode] : null;

  const handleStarterSelect = useCallback(
    (prompt: string) => {
      setInput(prompt);
      window.requestAnimationFrame(() => {
        const el = composerInputRef.current;
        if (el) {
          el.focus();
          const len = prompt.length;
          try {
            el.setSelectionRange(len, len);
          } catch {
            // Ignore selection range errors on unsupported inputs
          }
        }
      });
    },
    [setInput],
  );

  return (
    <section
      aria-label="محیط گفتگوی دستیار هوشمند"
      className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-background"
    >
      {/* Slim header: assistant/task identity, active conversation title, optional context chips, and on-demand actions */}
      <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/80 bg-card/85 px-3 py-1.5 backdrop-blur sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <SparklesIcon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold text-foreground">
                {conversationTitle || "دستیار هوشمند"}
              </p>
              {taskLabel ? (
                <span className=" hidden shrink-0 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary sm:inline-flex">
                  {taskLabel}
                </span>
              ) : null}
              {activeProjectId ? (
                <span className="inline-flex max-w-44 items-center gap-1 rounded-full border border-amber-300/70 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:border-amber-500/35 dark:bg-amber-500/15 dark:text-amber-200">
                  <FolderKanbanIcon className="size-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">
                    {activeProjectName ? `پروژه: ${activeProjectName}` : "پروژهٔ فعال"}
                  </span>
                  <button
                    type="button"
                    onClick={() => changeProject(null)}
                    aria-label="حذف فیلتر پروژه"
                    className="rounded-full p-0.5 hover:bg-amber-200/60 dark:hover:bg-amber-500/30"
                  >
                    <XIcon className="size-2.5" aria-hidden="true" />
                  </button>
                </span>
              ) : null}
              {focusLabel ? (
                <span className="hidden shrink-0 items-center gap-1 rounded-full border border-border/80 bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-foreground/80 md:inline-flex">
                  <span>{`تمرکز: ${focusLabel}`}</span>
                  <button
                    type="button"
                    onClick={() => updateAppFocus("all")}
                    aria-label="بازنشانی تمرکز دستیار"
                    className="rounded-full p-0.5 hover:bg-background"
                  >
                    <XIcon className="size-2.5" aria-hidden="true" />
                  </button>
                </span>
              ) : null}
              {modeLabel ? (
                <span className="hidden shrink-0 items-center gap-1 rounded-full border border-border/80 bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-foreground/80 md:inline-flex">
                  <span>{`حالت: ${modeLabel}`}</span>
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setHistorySheetOpen(true)}
            aria-label="گفتگوهای اخیر"
            title="گفتگوهای اخیر"
            className="gap-1.5 px-2.5 xl:hidden"
          >
            <HistoryIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">گفتگوها</span>
          </Button>

          <Button
            type="button"
            variant={widgetsSheetOpen ? "secondary" : "outline"}
            size="sm"
            onClick={() => handleWidgetsOpenChange(true)}
            aria-label="ویجت‌های دستیار"
            title="ویجت‌های دستیار"
            className="gap-1.5 px-2.5"
          >
            <LayoutGridIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="hidden md:inline">ویجت‌ها</span>
          </Button>

          {canOpenManagement ? (
            <Button
              type="button"
              variant={panelSection ? "secondary" : "outline"}
              size="sm"
              onClick={() => openPanel(panelSection ?? defaultPanelSection)}
              aria-expanded={panelSection !== null}
              aria-label="مدیریت دستیار"
              title="مدیریت دستیار: حافظه، همکاران، اتوماسیون‌ها، پژوهش و مصرف"
              className="gap-1.5 px-2.5 sm:px-3"
            >
              <Settings2Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="hidden sm:inline">مدیریت دستیار</span>
            </Button>
          ) : null}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleNewConversation}
            aria-label="گفت‌وگوی جدید"
            className="gap-1.5 px-2.5 sm:px-3"
          >
            <MessageSquarePlusIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">گفت‌وگوی جدید</span>
          </Button>
        </div>
      </header>

      <AiManagementSheet
        section={panelSection}
        canAutoApply={canAutoApply}
        allowedSections={allowedPanelSections}
        deepResearchEnabled={deepResearchEnabled}
        onSectionChange={openPanel}
        onClose={closePanel}
      />

      {/* Accessible Sheet for on-demand conversation history on mobile/tablet/collapsed rail */}
      <Sheet open={historySheetOpen} onOpenChange={setHistorySheetOpen}>
        <SheetContent
          side="right"
          aria-label="گفتگوهای اخیر"
          className="flex w-[min(22rem,88vw)] flex-col gap-0 p-0 sm:max-w-sm"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>گفتگوهای اخیر</SheetTitle>
            <SheetDescription>
              جست‌وجو، ادامه، تغییر نام یا حذف گفتگوهای قبلی شما با دستیار هوشمند.
            </SheetDescription>
          </SheetHeader>
          <AiConversationsSidebar
            activeId={conversationId}
            refreshToken={historyRefresh}
            onSelect={openFromHistory}
            onClose={() => setHistorySheetOpen(false)}
            onDeleted={(deletedId) => {
              if (deletedId === conversationId) handleNewConversation();
            }}
            onRenamed={(renamed) => {
              if (renamed.id === conversationId) {
                setConversationTitle(renamed.title);
              }
              setHistoryRefresh((token) => token + 1);
            }}
          />
        </SheetContent>
      </Sheet>

      {/* On-demand Sheet for assistant widgets (outside default chat height calculation; never auto-runs on chat open) */}
      <Sheet open={widgetsSheetOpen} onOpenChange={handleWidgetsOpenChange}>
        <SheetContent
          side="left"
          aria-label="ویجت‌های دستیار"
          className="w-full max-w-none gap-0 overflow-y-auto p-4 sm:w-[36rem] sm:max-w-[36rem]"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>ویجت‌های دستیار</SheetTitle>
            <SheetDescription>
              خلاصه‌های هوشمند و کارت‌های خواندنی کسب‌وکار شما.
            </SheetDescription>
          </SheetHeader>
          {widgetsSheetOpen ? <AiWorkspaceWidgets /> : null}
        </SheetContent>
      </Sheet>

      {/* Main conversation / welcome scroll area with one persistent ChatComposer */}
      <div
        ref={scrollRef}
        onScroll={onThreadScroll}
        className={cn(
          "ai-chat-scroll relative flex min-h-0 flex-1 flex-col overflow-y-auto px-3 sm:px-6",
          isWelcome ? "py-3 sm:py-5" : "pt-4 pb-2",
        )}
      >
        {loadingConversation ? (
          <LoadingSkeleton
            rows={6}
            className="mx-auto w-full max-w-3xl py-6"
            label="در حال بازکردن مکالمه"
          />
        ) : isWelcome ? (
          <div
            ref={heroRef}
            className="mx-auto mt-auto flex w-full max-w-3xl flex-col items-center text-center"
          >
            <div
              data-hero
              className="grid size-11 place-items-center rounded-2xl bg-primary/10 text-primary"
            >
              <SparklesIcon className="size-5" aria-hidden="true" />
            </div>
            <h1
              data-hero
              className="mt-3 text-xl font-bold tracking-tight text-foreground sm:text-2xl"
            >
              امروز چطور می‌توانم کمکتان کنم؟
            </h1>
            <p
              data-hero
              className="mt-1.5 max-w-xl text-xs leading-6 text-muted-foreground sm:text-sm"
            >
              پرسش خود را بنویسید، تصویر یا سند PDF پیوست کنید، یا یکی از پیشنهادهای زیر را انتخاب کنید.
            </p>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl flex-1 space-y-5 pb-4">
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
                />
              );
            })}
          </div>
        )}

        {!atThreadBottom && !isWelcome && messages.length > 1 ? (
          <div className="pointer-events-none sticky bottom-20 z-10 flex justify-center">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={jumpToLatest}
              className="pointer-events-auto gap-1.5 rounded-full border-border bg-card/95 shadow-[0_1px_2px_rgb(41_37_36/0.035)] backdrop-blur"
            >
              <ArrowDownIcon className="size-3.5" aria-hidden="true" />
              برو به آخرین پیام
            </Button>
          </div>
        ) : null}

        {/* Single shared ChatComposer: centered in Welcome flow, pinned at bottom of active thread */}
        <div
          className={cn(
            "mx-auto w-full max-w-3xl shrink-0",
            isWelcome
              ? "mt-4 sm:mt-5"
              : "sticky bottom-0 z-10 mt-auto border-t border-border/70 bg-background/95 pb-2 pt-2.5 backdrop-blur",
          )}
        >
          <ChatComposer
            mode="dashboard"
            inputRef={composerInputRef}
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
            eligibleTaskIds={focusScopedEligibleTaskIds}
            contextControls={
              <AiWorkspaceContext
                compact
                appFocus={appFocus}
                onAppFocusChange={updateAppFocus}
                accessibleFocuses={effectiveAccessibleFocuses}
                runtimeMode={runtimeMode}
                onRuntimeModeChange={updateRuntimeMode}
                deepResearchEnabled={deepResearchEnabled}
                projectId={canSelectProject ? activeProjectId : null}
                onProjectChange={changeProject}
                onProjectNameChange={setActiveProjectName}
                canSelectProject={canSelectProject}
                disabled={busy || loadingConversation}
              />
            }
            actionsAllowed={actionsAllowed}
            setActionsAllowed={setActionsAllowed}
            loadConversation={loadConversation}
            sendMessage={sendMessage}
            onCancelGeneration={cancelGeneration}
            cancellable={busy}
            footer={
              !isWelcome ? (
                <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
                  پاسخ‌ها بر اساس داده‌های ثبت‌شده کسب‌وکار شما ارائه می‌شوند.
                </p>
              ) : null
            }
          />
        </div>

        {/* Starter cards + quiet note in Welcome state */}
        {isWelcome && !loadingConversation ? (
          <div
            aria-label="پیشنهادهای شروع گفتگو"
            className="mx-auto mb-auto mt-3 w-full max-w-3xl shrink-0 sm:mt-4"
          >
            <div className="grid w-full gap-2.5 sm:grid-cols-3">
              {suggestions.slice(0, 3).map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => handleStarterSelect(suggestion)}
                  className={cn(
                    cardClass,
                    "flex min-h-16 items-start gap-2.5 p-3 text-start text-xs leading-5 text-foreground/85 transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-[13px]",
                  )}
                >
                  <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg bg-amber-100/80 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
                    <SparklesIcon className="size-3.5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">{suggestion}</span>
                </button>
              ))}
            </div>
            <p className="mt-3 text-center text-[11px] leading-5 text-muted-foreground">
              پاسخ‌ها بر اساس داده‌های ثبت‌شده کسب‌وکار شما ارائه می‌شوند و هر تغییر فقط با تأیید شما اعمال خواهد شد.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
