"use client";

/**
 * The AI assistant's canonical chat surface (`/dashboard`, Issue #905 redesign).
 *
 * Owner UX correction (2026-10-17):
 * - Prioritizes the conversation and a clean composer (only text input, `+`
 *   secondary-tools menu on the trailing right side, send/stop anchored at the
 *   physical bottom-left inside the input box, and attachment previews when
 *   attachments exist).
 * - Secondary tools (attachments, assistant/task, focus, response mode, project,
 *   search, and message settings) live inside the `+` menu with current
 *   selection summaries and checkmarks.
 * - Minimal header: assistant/conversation title, on-demand Widgets and
 *   Management sheets, and the minimal History reopen/drawer control. No
 *   exposed task/focus/mode/project chips and no page-header New Chat button.
 * - Collapsible conversation history panel on the physical LEFT of the
 *   assistant window in both RTL and LTR on desktop (~260–288px width,
 *   releasing full width when collapsed), with a left-side `Sheet` drawer on
 *   narrow screens. New Chat lives inside the history panel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import {
  ArrowDownIcon,
  HistoryIcon,
  LayoutGridIcon,
  PanelLeftOpenIcon,
  Settings2Icon,
  SparklesIcon,
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
import { usePersistentTenantAiChat } from "@/components/ai/persistent-tenant-ai";
import { ChatBubble } from "@/components/ai/chat-bubble";
import { animateStaggerIn } from "@/components/ai/chat-animations";
import { useStickyScroll } from "@/components/ai/use-sticky-scroll";
import {
  SUGGESTED_PROMPTS,
  resolveAccessibleFocuses,
  resolveEligibleTasks,
  resolveStarterPrompts,
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

const HISTORY_PANEL_PREFERENCE_KEY = "ai-history-panel-preference";
const DESKTOP_HISTORY_MIN_WIDTH = 1024;

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
  /** Smaller composer/chat shown in the physical-left panel of other app pages. */
  compact?: boolean;
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
  compact = false,
}: AiChatHubProps) {
  const locked = useFeatureLocked();
  const router = useRouter();
  const pathname = usePathname();
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
  const [widgetsSheetOpen, setWidgetsSheetOpen] = useState<boolean>(widgetsFromUrl);

  const [isDesktopViewport, setIsDesktopViewport] = useState<boolean>(true);
  const [historyCollapsed, setHistoryCollapsed] = useState<boolean>(false);
  const [historySheetOpen, setHistorySheetOpen] = useState<boolean>(false);
  const [historyRefresh, setHistoryRefresh] = useState<number>(0);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(HISTORY_PANEL_PREFERENCE_KEY);
      if (stored === "collapsed") {
        setHistoryCollapsed(true);
      } else if (stored === "expanded") {
        setHistoryCollapsed(false);
      }
    } catch {
      // Ignore storage access errors
    }
  }, []);

  useEffect(() => {
    const checkViewport = () => {
      const width = window.innerWidth;
      const desktop = width === 0 || width >= DESKTOP_HISTORY_MIN_WIDTH;
      setIsDesktopViewport(desktop);
      if (desktop) {
        setHistorySheetOpen(false);
      }
    };
    checkViewport();
    window.addEventListener("resize", checkViewport);
    return () => window.removeEventListener("resize", checkViewport);
  }, []);

  const setDesktopHistoryCollapsed = useCallback((collapsed: boolean) => {
    setHistoryCollapsed(collapsed);
    try {
      window.localStorage.setItem(
        HISTORY_PANEL_PREFERENCE_KEY,
        collapsed ? "collapsed" : "expanded",
      );
    } catch {
      // Ignore storage access errors
    }
  }, []);

  const latestSearchRef = useRef(searchParams.toString());
  useEffect(() => {
    latestSearchRef.current = searchParams.toString();
  }, [searchParams]);

  const lastHandledUrlConversationRef = useRef<string | null>(conversationFromUrl);
  const pendingUrlConversationRef = useRef<string | null | undefined>(undefined);

  const replaceParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(latestSearchRef.current);
      mutate(params);
      const nextConv = params.get("conversation")?.trim() || null;
      pendingUrlConversationRef.current = nextConv;
      lastHandledUrlConversationRef.current = nextConv;
      const query = params.toString();
      latestSearchRef.current = query;
      if (!compact) router.replace(query ? `/dashboard?${query}` : "/dashboard", {
        scroll: false,
      });
    },
    [router, compact],
  );

  const localChat = useAiChat({
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

  const sharedChat = usePersistentTenantAiChat();
  const chat = sharedChat ?? localChat;

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

  // A compact assistant follows the actual current application.
  useEffect(() => {
    if (!compact || !sharedChat) return;
    const app = pathname.startsWith("/accounting") ? "accounting"
      : pathname.startsWith("/crm") ? "crm"
      : pathname.startsWith("/growth") ? "growth"
      : pathname.startsWith("/websites") ? "website"
      : pathname.startsWith("/workspace") ? "workspace" : "all";
    const focus = normalizeAiAppFocus(app, effectiveAccessibleFocuses);
    setAppFocus(focus);
    sharedChat.setRequestAppFocus(focus);
    // sharedChat's client setter is ref-based and stable for this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact, pathname, effectiveAccessibleFocuses, Boolean(sharedChat)]);

  const updateAppFocus = useCallback(
    (value: AiAppFocus) => {
      const normalized = normalizeAiAppFocus(value, effectiveAccessibleFocuses);
      setAppFocus(normalized);
      chat.setRequestAppFocus(normalized);
      replaceParams((params) => {
        params.delete("app");
        if (normalized === "all") params.delete("focus");
        else params.set("focus", normalized);
      });
    },
    [effectiveAccessibleFocuses, replaceParams, chat],
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
    allowSessionProposal,
    dismissProposal,
    submitInputRequest,
    dismissInputRequest,
  } = chat;

  // Restore conversation query after returning to full-page chat from a module.
  useEffect(() => {
    if (compact || !sharedChat || !initialized.current) return;
    if (!conversationFromUrl && conversationId) {
      replaceParams((params) => params.set("conversation", conversationId));
    }
  }, [compact, sharedChat, conversationId, conversationFromUrl, replaceParams]);

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
    if (compact) return;
    const nextFocus = normalizeAiAppFocus(
      rawFocusParam,
      effectiveAccessibleFocuses,
    );
    setAppFocus(nextFocus);
    const nextMode = rawModeParam ? resolveValidMode(rawModeParam) : sharedChat ? chat.runtimeMode : "auto";
    setRuntimeMode(nextMode);
    setWidgetsSheetOpen(widgetsFromUrl);
  }, [
    effectiveAccessibleFocuses,
    rawFocusParam,
    rawModeParam,
    resolveValidMode,
    setRuntimeMode,
    widgetsFromUrl,
    compact,
    sharedChat,
    chat.runtimeMode,
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
      chat.setRequestProjectId(nextProjectId);
      // Switching project must not silently discard the unsent composer text.
      startNewConversation(true);
      replaceParams((params) => {
        if (nextProjectId) params.set("project", nextProjectId);
        else params.delete("project");
        params.delete("conversation");
      });
    },
    [activeProjectId, replaceParams, startNewConversation, chat],
  );

  const openFromHistory = useCallback(
    (id: string) => {
      setHistorySheetOpen(false);
      void loadConversation(id).then((meta) => {
        if (!meta) return;
        setActiveProjectId(canSelectProject ? meta.projectId : null);
        if (!compact) replaceParams((params) => params.set("conversation", id));
      });
    },
    [loadConversation, canSelectProject, compact, replaceParams],
  );

  useEffect(() => {
    if (!initialized.current) return;
    scrollToBottom({ force: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Initial mount & browser back/forward `?conversation=` reconciliation.
  useEffect(() => {
    if (compact) {
      if (!initialized.current) {
        initialized.current = true;
        if (messages.length === 0) ensureGreeting();
      }
      return;
    }
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
      } else if (requested && requested !== conversationId) {
        void loadConversation(requested);
      } else if (messages.length === 0) {
        ensureGreeting();
      } else if (conversationId && !requested) {
        replaceParams((params) => params.set("conversation", conversationId));
      }
      return;
    }

    if (pendingUrlConversationRef.current !== undefined) {
      if (conversationFromUrl === pendingUrlConversationRef.current) {
        pendingUrlConversationRef.current = undefined;
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
    compact,
    messages.length,
    replaceParams,
  ]);

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

  const showDesktopHistoryPanel = !compact && isDesktopViewport && !historyCollapsed;

  return (
    <section
      aria-label="محیط گفتگوی دستیار هوشمند"
      className="flex h-full min-h-0 w-full flex-1 flex-row overflow-hidden bg-background text-foreground rtl:flex-row-reverse [&:dir(ltr)]:flex-row [&:dir(rtl)]:flex-row-reverse"
    >
      {/* Physical LEFT collapsible history panel on desktop (~260–288px, releases full width on collapse) */}
      {showDesktopHistoryPanel ? (
        <aside
          aria-label="تاریخچهٔ گفتگوها"
          className="flex h-full w-[clamp(260px,20vw,288px)] shrink-0 flex-col border-r border-border/80 bg-card/60"
        >
          <AiConversationsSidebar
            collapsible
            activeId={conversationId}
            refreshToken={historyRefresh}
            onSelect={openFromHistory}
            onNewConversation={handleNewConversation}
            onClose={() => setDesktopHistoryCollapsed(true)}
            closeLabel="جمع کردن تاریخچهٔ گفتگوها"
            onDeleted={(deletedId) => {
              if (deletedId === conversationId) {
                handleNewConversation();
              }
              setHistoryRefresh((token) => token + 1);
            }}
            onRenamed={(renamed) => {
              if (renamed.id === conversationId) {
                setConversationTitle(renamed.title);
              }
              setHistoryRefresh((token) => token + 1);
            }}
          />
        </aside>
      ) : null}

      {/* Main chat column */}
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Minimal header: assistant/conversation title, on-demand Widgets & Management, and minimal History reopen/drawer control */}
        <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/80 bg-card/85 px-3 py-1.5 backdrop-blur sm:px-4">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <SparklesIcon className="size-4" aria-hidden="true" />
            </span>
            <p className="truncate text-sm font-semibold text-foreground">
              {conversationTitle || "دستیار هوشمند"}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {!compact ? <Button
              type="button"
              variant={widgetsSheetOpen ? "secondary" : "outline"}
              size="sm"
              onClick={() => handleWidgetsOpenChange(true)}
              aria-label="ویجت‌های دستیار"
              title="ویجت‌های دستیار"
              className="gap-1.5 px-2.5 text-foreground"
            >
              <LayoutGridIcon className="size-4 shrink-0" aria-hidden="true" />
              <span className="hidden md:inline">ویجت‌ها</span>
            </Button> : null}

            {!compact && canOpenManagement ? (
              <Button
                type="button"
                variant={panelSection ? "secondary" : "outline"}
                size="sm"
                onClick={() => openPanel(panelSection ?? defaultPanelSection)}
                aria-expanded={panelSection !== null}
                aria-label="مدیریت دستیار"
                title="مدیریت دستیار: حافظه، همکاران، اتوماسیون‌ها، پژوهش و مصرف"
                className="gap-1.5 px-2.5 text-foreground sm:px-3"
              >
                <Settings2Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="hidden sm:inline">مدیریت دستیار</span>
              </Button>
            ) : null}

            {(!isDesktopViewport || compact) ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setHistorySheetOpen(true)}
                aria-expanded={historySheetOpen}
                aria-label="باز کردن تاریخچهٔ گفتگوها"
                title="گفتگوهای اخیر"
                className="gap-1.5 px-2.5 text-foreground"
              >
                <HistoryIcon className="size-4 shrink-0" aria-hidden="true" />
                <span className="hidden sm:inline">گفتگوها</span>
              </Button>
            ) : historyCollapsed ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDesktopHistoryCollapsed(false)}
                aria-expanded={false}
                aria-label="باز کردن تاریخچهٔ گفتگوها"
                title="باز کردن تاریخچهٔ گفتگوها"
                className="gap-1.5 px-2.5 text-foreground"
              >
                <PanelLeftOpenIcon className="size-4 shrink-0" aria-hidden="true" />
                <span className="hidden sm:inline">گفتگوها</span>
              </Button>
            ) : null}
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

        {/* Accessible left-side Sheet for on-demand conversation history on narrow screens */}
        {(!isDesktopViewport || compact) ? (
          <Sheet open={historySheetOpen} onOpenChange={setHistorySheetOpen}>
            <SheetContent
              side="left"
              showCloseButton={false}
              aria-label="تاریخچهٔ گفتگوها"
              className="flex w-[min(18rem,86vw)] flex-col gap-0 p-0 sm:max-w-xs"
            >
              <SheetHeader className="sr-only">
                <SheetTitle>گفتگوهای اخیر</SheetTitle>
                <SheetDescription>
                  ایجاد گفتگوی جدید، جست‌وجو، ادامه، تغییر نام یا حذف گفتگوهای قبلی شما با دستیار هوشمند.
                </SheetDescription>
              </SheetHeader>
              <AiConversationsSidebar
                activeId={conversationId}
                refreshToken={historyRefresh}
                onSelect={openFromHistory}
                onNewConversation={() => {
                  setHistorySheetOpen(false);
                  handleNewConversation();
                }}
                onClose={() => setHistorySheetOpen(false)}
                closeLabel="بستن تاریخچهٔ گفتگوها"
                onDeleted={(deletedId) => {
                  if (deletedId === conversationId) handleNewConversation();
                  setHistoryRefresh((token) => token + 1);
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
        ) : null}

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
                    allowSessionProposal={allowSessionProposal}
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
              workspaceContext={{
                appFocus,
                onAppFocusChange: updateAppFocus,
                accessibleFocuses: effectiveAccessibleFocuses,
                runtimeMode,
                onRuntimeModeChange: updateRuntimeMode,
                deepResearchEnabled,
                projectId: canSelectProject ? activeProjectId : null,
                onProjectChange: changeProject,
                canSelectProject,
              }}
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
      </div>
    </section>
  );
}
