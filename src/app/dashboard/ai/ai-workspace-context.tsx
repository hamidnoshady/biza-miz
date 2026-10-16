"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircleIcon,
  FolderKanbanIcon,
  LayersIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import type { AiAppFocus } from "@/components/ai/use-ai-chat";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AI_RUNTIME_MODES,
  isAiRuntimeModeAvailable,
  type AiRuntimeMode,
} from "@/lib/ai-runtime-modes-shared";
import { cn } from "@/lib/utils";

interface Project {
  id: string;
  name: string;
}

export const APP_FOCUS_OPTIONS: ReadonlyArray<{ value: AiAppFocus; label: string }> = [
  { value: "all", label: "همهٔ بخش‌ها" },
  { value: "workspace", label: "میز کار من" },
  { value: "accounting", label: "حسابداری و فروش" },
  { value: "crm", label: "مشتریان (CRM)" },
  { value: "growth", label: "رشد و بازاریابی" },
  { value: "website", label: "وب‌سایت" },
];

export const RUNTIME_MODE_LABELS: Record<AiRuntimeMode, string> = {
  auto: "خودکار",
  instant: "سریع",
  deep_research: "پژوهش عمیق",
};

const selectClass =
  "h-7 rounded-full border border-border/80 bg-background px-2.5 text-[11px] font-medium text-foreground/85 outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60";

export function AiWorkspaceContext({
  appFocus,
  onAppFocusChange,
  accessibleFocuses,
  runtimeMode,
  onRuntimeModeChange,
  deepResearchEnabled = false,
  projectId,
  onProjectChange,
  onProjectNameChange,
  canSelectProject = true,
  disabled = false,
  compact = false,
}: {
  appFocus: AiAppFocus;
  onAppFocusChange: (value: AiAppFocus) => void;
  accessibleFocuses?: readonly AiAppFocus[];
  runtimeMode: AiRuntimeMode;
  onRuntimeModeChange: (value: AiRuntimeMode) => void;
  deepResearchEnabled?: boolean;
  projectId: string | null;
  onProjectChange: (projectId: string | null) => void;
  onProjectNameChange?: (name: string | null) => void;
  canSelectProject?: boolean;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(canSelectProject);
  const [projectsError, setProjectsError] = useState(false);

  const loadProjects = useCallback(async () => {
    if (!canSelectProject) {
      setProjects([]);
      setProjectsLoading(false);
      setProjectsError(false);
      return;
    }
    setProjectsLoading(true);
    setProjectsError(false);
    try {
      const response = await fetch("/api/ai/projects?limit=40");
      if (!response.ok) {
        throw new Error(`projects_fetch_${response.status}`);
      }
      const data = (await response.json()) as { projects?: Project[] };
      setProjects(Array.isArray(data?.projects) ? data.projects : []);
    } catch {
      setProjectsError(true);
    } finally {
      setProjectsLoading(false);
    }
  }, [canSelectProject]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!onProjectNameChange) return;
    if (!projectId) {
      onProjectNameChange(null);
      return;
    }
    const match = projects.find((item) => item.id === projectId);
    onProjectNameChange(match?.name ?? null);
  }, [onProjectNameChange, projectId, projects]);

  const focusOptions =
    accessibleFocuses && accessibleFocuses.length > 0
      ? APP_FOCUS_OPTIONS.filter(
          (item) => item.value === "all" || accessibleFocuses.includes(item.value),
        )
      : APP_FOCUS_OPTIONS;

  const selectedProject = projectId
    ? projects.find((item) => item.id === projectId) ?? null
    : null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5 text-xs",
        !compact && "gap-2",
      )}
      aria-label="زمینهٔ کاری دستیار"
    >
      <label className="inline-flex items-center gap-1 text-muted-foreground">
        <LayersIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="sr-only">تمرکز دستیار</span>
        <select
          aria-label="تمرکز دستیار"
          value={appFocus}
          disabled={disabled}
          onChange={(event) => onAppFocusChange(event.target.value as AiAppFocus)}
          className={cn(
            selectClass,
            appFocus !== "all" && "border-primary/40 bg-primary/10 text-primary",
          )}
        >
          {focusOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.value === "all" ? "تمرکز: همهٔ بخش‌ها" : `تمرکز: ${option.label}`}
            </option>
          ))}
        </select>
      </label>

      <label className="inline-flex items-center gap-1 text-muted-foreground">
        <SlidersHorizontalIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="sr-only">حالت پاسخ‌گویی</span>
        <select
          aria-label="حالت پاسخ‌گویی"
          value={runtimeMode}
          disabled={disabled}
          onChange={(event) => onRuntimeModeChange(event.target.value as AiRuntimeMode)}
          className={cn(
            selectClass,
            runtimeMode !== "auto" && "border-primary/40 bg-primary/10 text-primary",
          )}
        >
          {AI_RUNTIME_MODES.filter((mode) =>
            isAiRuntimeModeAvailable(mode, deepResearchEnabled),
          ).map((mode) => (
            <option key={mode} value={mode}>
              {`حالت: ${RUNTIME_MODE_LABELS[mode]}`}
            </option>
          ))}
        </select>
      </label>

      {canSelectProject ? (
        <div className="inline-flex items-center gap-1 text-muted-foreground">
          <FolderKanbanIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {projectsLoading ? (
            <Skeleton
              className="h-7 w-28 rounded-full"
              aria-label="در حال خواندن پروژه‌ها"
            />
          ) : projectsError ? (
            <div
              role="status"
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-2.5 text-[11px] font-medium text-destructive"
            >
              <AlertCircleIcon className="size-3 shrink-0" aria-hidden="true" />
              <span>خطا در خواندن پروژه‌ها</span>
              <button
                type="button"
                onClick={() => void loadProjects()}
                className="inline-flex items-center gap-1 rounded-full bg-background/80 px-1.5 py-0.5 text-[10px] font-semibold text-foreground hover:bg-background outline-none focus-visible:ring focus-visible:ring-ring/50"
              >
                <RotateCcwIcon className="size-2.5" aria-hidden="true" />
                تلاش مجدد
              </button>
            </div>
          ) : (
            <div className="inline-flex items-center gap-1">
              <select
                aria-label="پروژه"
                value={projectId ?? ""}
                disabled={disabled}
                onChange={(event) => onProjectChange(event.target.value || null)}
                className={cn(
                  selectClass,
                  "max-w-44",
                  projectId && "border-primary/40 bg-primary/10 text-primary",
                )}
              >
                <option value="">
                  {projects.length === 0
                    ? "پروژه: پروژه‌ای ثبت نشده"
                    : "پروژه: بدون پروژه"}
                </option>
                {projects &&
                  projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {`پروژه: ${project.name}`}
                    </option>
                  ))}
              </select>
              {projectId ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onProjectChange(null)}
                  aria-label={
                    selectedProject
                      ? `لغو انتخاب پروژه ${selectedProject.name}`
                      : "لغو انتخاب پروژه"
                  }
                  title="لغو انتخاب پروژه"
                  className="inline-flex size-6 items-center justify-center rounded-full border border-border/70 bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
                >
                  <XIcon className="size-3" />
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
