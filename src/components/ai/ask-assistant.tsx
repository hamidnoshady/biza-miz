"use client";

/**
 * Phase 35 Wave 2 — the thin "ask the assistant" link.
 *
 * Mounted in a page's `PageHeader` actions. It carries the page's context to
 * the workspace chat home (`/dashboard`) as a `?ctx=` param, where the hub
 * prefills the composer with it (see ai-chat-hub.tsx). It is deliberately a
 * plain link, not the floating bubble: with the workspace shell on, the bubble
 * is gone from dashboard pages, and a page that wants assistant help offers this
 * instead, next to its own controls.
 */
import { createContext, useContext, type ReactNode } from "react";
import Link from "next/link";
import { SparklesIcon } from "lucide-react";

/**
 * Whether this business may use the assistant here. The shell sets it from the
 * `ai_assistant` switch (and off on a Hybrid desktop, where the assistant is a
 * cloud screen). The default is off: a link must never invite a member into a
 * surface the super-admin console switched off.
 */
const AssistantLinkContext = createContext(false);

export function AssistantLinkProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <AssistantLinkContext.Provider value={enabled}>{children}</AssistantLinkContext.Provider>;
}

export function AskAssistant({
  context,
  app,
  label = "از دستیار بپرس",
}: {
  /** Pre-filled prompt carried to the chat home. */
  context: string;
  /** Optional app context (e.g. "growth") carried as `?app=`. */
  app?: string;
  label?: string;
}) {
  if (!useContext(AssistantLinkContext)) return null;
  const params = new URLSearchParams();
  if (context) params.set("ctx", context);
  if (app) params.set("app", app);
  const href = `/dashboard${params.toString() ? `?${params.toString()}` : ""}`;

  return (
    <Link
      href={href}
      // The padding is not decoration: a bare text link is ~20px tall, well
      // under any touch-target minimum, and this sits in every page header.
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:hover:text-amber-300 dark:focus-visible:ring-amber-400/45"
    >
      <SparklesIcon className="size-4 shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </Link>
  );
}
