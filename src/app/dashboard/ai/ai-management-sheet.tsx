"use client";

/**
 * The assistant's management panel, drawn over the chat home itself.
 *
 * The retired `/ai` application kept these in a sidebar of its own — agents,
 * coworkers, automations, activity, knowledge and usage, each a page behind the
 * `ai_assistant` lock and the owner/manager gate. They are the same components
 * here, reached from the dashboard chat's «مدیریت دستیار» control and
 * addressed by the `?aiPanel=<section>` query (`src/lib/ai-panel.ts` is the
 * registry), so there is one assistant experience, not two sidebars managing
 * one assistant.
 *
 * It is a sheet, not a second permanent rail: it opens from the *far* edge of
 * the right-side workspace sidebar, or full-screen on a phone, and closes back
 * to the chat it came from. Escape, outside click, focus handling and the
 * close affordance are the `Sheet` primitive's, like every other overlay in
 * the product.
 */

import {
  ActivityIcon,
  BotIcon,
  LibraryBigIcon,
  SparklesIcon,
  WalletIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AI_PANEL_SECTIONS,
  aiPanelSection,
  type AiPanelIconName,
  type AiPanelSectionKey,
} from "@/lib/ai-panel";
import { FilterChip } from "../filters";
import { AgentsManager } from "@/app/(app)/ai/agents/agents-manager";
import { AutomationsManager } from "@/app/(app)/ai/automations/automations-manager";
import { KnowledgeManager } from "@/app/(app)/ai/knowledge/knowledge-manager";
import { UsageDashboard } from "@/app/(app)/ai/usage/usage-dashboard";
import { AiCoworkerPanel } from "./ai-coworker-panel";
import { AiAutopilotActivity } from "./ai-autopilot-activity";

const ICONS: Record<AiPanelIconName, LucideIcon> = {
  agents: SparklesIcon,
  coworkers: BotIcon,
  automations: ZapIcon,
  activity: ActivityIcon,
  knowledge: LibraryBigIcon,
  usage: WalletIcon,
};

/** The section body — exactly the managers the retired section pages mounted, props included. */
function AiPanelBody({
  section,
  canAutoApply,
}: {
  section: AiPanelSectionKey;
  canAutoApply: boolean;
}) {
  switch (section) {
    case "agents":
      return <AgentsManager />;
    case "coworkers":
      // Only an owner may hand a job the authority to act unattended — the
      // server-side `owner_required` checks mirror this prop.
      return <AiCoworkerPanel canAutoApply={canAutoApply} />;
    case "automations":
      return <AutomationsManager canAutoApply={canAutoApply} />;
    case "activity":
      return <AiAutopilotActivity />;
    case "knowledge":
      return <KnowledgeManager />;
    case "usage":
      return <UsageDashboard />;
  }
}

export function AiManagementSheet({
  section,
  allowedSections,
  canAutoApply,
  onSectionChange,
  onClose,
}: {
  /** The open section, or null when the panel is closed. Driven by `?aiPanel=`. */
  section: AiPanelSectionKey | null;
  /** Server-derived effective capabilities; never infer these from a role in the client. */
  allowedSections: readonly AiPanelSectionKey[];
  /** Owner only: lets coworker jobs and automations apply unattended. */
  canAutoApply: boolean;
  onSectionChange: (key: AiPanelSectionKey) => void;
  onClose: () => void;
}) {
  // While closed, keep an authorized section mounted so the exit slide has
  // content. The parent already rejects unauthorized query-string values.
  const active = aiPanelSection(section ?? allowedSections[0] ?? "agents");

  return (
    <Sheet open={section !== null} onOpenChange={(open) => (open ? null : onClose())}>
      {/*
        Physical left: the workspace rail owns the right edge, so the assistant's
        management arrives from the opposite side and never stacks onto it as a
        second sidebar. Full-screen on a phone; a wide panel from `sm` up.
      */}
      <SheetContent
        side="left"
        aria-label="مدیریت دستیار هوشمند"
        className="w-full max-w-none gap-0 p-0 sm:w-[34rem] sm:max-w-[34rem]"
      >
        <SheetHeader className="shrink-0 border-b border-border/80 px-4 py-3">
          <SheetTitle>مدیریت دستیار هوشمند</SheetTitle>
          <SheetDescription>
            ایجنت‌ها، همکاران، اتوماسیون‌ها و دانش دستیار — همان گفت‌وگو، یک قدم فراتر.
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          <nav
            aria-label="بخش‌های مدیریت دستیار"
            className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-border/80 px-3 py-2 pb-2"
          >
            {AI_PANEL_SECTIONS.filter((item) => allowedSections.includes(item.key)).map((item) => {
              const Icon = ICONS[item.icon];
              return (
                <FilterChip
                  key={item.key}
                  selected={active.key === item.key}
                  onClick={() => onSectionChange(item.key)}
                  title={item.description}
                  className="flex items-center gap-2"
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="whitespace-nowrap">{item.label}</span>
                </FilterChip>
              );
            })}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
            <div className="mb-4">
              <h2 className="text-base font-semibold text-foreground">{active.label}</h2>
              <p className="mt-0.5 text-sm leading-6 text-muted-foreground">{active.description}</p>
            </div>
            <AiPanelBody section={active.key} canAutoApply={canAutoApply} />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
