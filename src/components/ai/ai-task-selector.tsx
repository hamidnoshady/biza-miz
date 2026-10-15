"use client";

/**
 * The composer's task dropdown (Phase 36c) — ChatGPT's model picker, but for
 * *what the assistant should be doing*: each entry is a task lens (sales
 * analysis, inventory, accounting, …) that rides into the system prompt for
 * the next turns, plus a custom entry where the owner types any job
 * description they want.
 */
import { useState } from "react";
import {
  BikeIcon,
  CalculatorIcon,
  CalendarClockIcon,
  ChevronsUpDownIcon,
  HeartIcon,
  MegaphoneIcon,
  PackageIcon,
  PenLineIcon,
  ReceiptTextIcon,
  SparklesIcon,
  TrendingUpIcon,
  UtensilsCrossedIcon,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { AI_TASKS, taskById, type AiTaskId } from "@/lib/ai-tasks";
import type { AssistantMode } from "./use-ai-chat";
import { cn } from "@/lib/utils";

const TASK_ICONS: Record<AiTaskId, LucideIcon> = {
  general: SparklesIcon,
  sales: TrendingUpIcon,
  inventory: PackageIcon,
  accounting: ReceiptTextIcon,
  menu: UtensilsCrossedIcon,
  customers: HeartIcon,
  marketing: MegaphoneIcon,
  operations: CalendarClockIcon,
  delivery: BikeIcon,
  split: CalculatorIcon,
  custom: PenLineIcon,
};

function TaskIcon({
  id,
  className,
}: {
  id: AiTaskId;
  className?: string;
}) {
  const Icon = TASK_ICONS[id] ?? SparklesIcon;
  return <Icon className={className} />;
}

interface AiTaskSelectorProps {
  mode: AssistantMode;
  task: AiTaskId;
  customTask: string;
  disabled?: boolean;
  eligibleTaskIds?: readonly AiTaskId[];
  onSelectTask: (id: AiTaskId) => void;
  onCustomTask: (text: string) => void;
}

export function AiTaskSelector({
  mode,
  task,
  customTask,
  disabled,
  eligibleTaskIds,
  onSelectTask,
  onCustomTask,
}: AiTaskSelectorProps) {
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState("");

  // The wizard is already one specific task — offering another lens there
  // would just confuse the setup flow.
  if (mode === "wizard") return null;

  const eligibleSet =
    eligibleTaskIds && eligibleTaskIds.length > 0
      ? new Set(eligibleTaskIds)
      : null;
  // Filter out "custom" from the preset list so the custom task entry is only
  // rendered once in its dedicated editor row below the separator.
  const available = AI_TASKS.filter(
    (item) =>
      item.id !== "custom" &&
      item.modes.includes(mode) &&
      (!eligibleSet || item.id === "general" || eligibleSet.has(item.id)),
  );
  const current =
    task === "custom" && customTask
      ? {
          id: "custom" as AiTaskId,
          label: "وظیفهٔ سفارشی",
          description: customTask,
        }
      : (taskById(task) ?? taskById("general")!);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) {
          setCustomOpen(false);
          setDraft("");
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`وظیفهٔ دستیار: ${current.label}`}
          title={current.description}
          className="flex max-w-44 items-center gap-1.5 rounded-full border border-border/80 bg-background px-2.5 py-1.5 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-60 outline-none focus-visible:ring focus-visible:ring-ring/50"
        >
          <TaskIcon
            id={current.id}
            className="size-3.5 shrink-0 text-primary"
          />
          <span className="truncate">{current.label}</span>
          <ChevronsUpDownIcon className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-80 p-1.5">
        <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold text-muted-foreground">
          دستیار در این گفتگو چه کاری انجام دهد؟
        </p>
        <div className="max-h-72 overflow-y-auto">
          {available.map((item) => (
            <DropdownMenuItem
              key={item.id}
              onClick={() => {
                onSelectTask(item.id);
                if (customTask) {
                  onCustomTask("");
                }
                setCustomOpen(false);
              }}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2",
                task === item.id && "bg-primary/5",
              )}
            >
              <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <TaskIcon id={item.id} className="size-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-semibold leading-5 text-foreground">
                  {item.label}
                </span>
                <span className="block text-[10px] leading-4 text-muted-foreground">
                  {item.description}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </div>

        <DropdownMenuSeparator className="my-1" />

        {customOpen ? (
          <div className="p-2">
            <textarea
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => event.stopPropagation()}
              rows={3}
              placeholder="مثلاً: پاسخ‌ها را کوتاه و در قالب جدول مقایسه‌ای بنویس…"
              className="w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-xs leading-5 outline-none focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => {
                  setCustomOpen(false);
                  setDraft("");
                }}
                className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
              >
                انصراف
              </button>
              <Button
                size="sm"
                disabled={!draft.trim()}
                onClick={() => {
                  onCustomTask(draft.trim());
                  onSelectTask("custom");
                  setCustomOpen(false);
                  setDraft("");
                }}
              >
                اعمال وظیفه
              </Button>
            </div>
          </div>
        ) : (
          <DropdownMenuItem
            onClick={() => {
              setCustomOpen(true);
              setDraft(customTask);
            }}
            className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
              <PenLineIcon className="size-3.5" />
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-semibold leading-5 text-foreground">
                سفارشی…
              </span>
              <span className="block text-[10px] leading-4 text-muted-foreground">
                هر وظیفه‌ای که می‌خواهید، به زبان خودتان
              </span>
            </span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
