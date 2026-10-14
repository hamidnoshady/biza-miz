"use client";

import { useEffect, useState } from "react";
import { ChevronDownIcon, FolderKanbanIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { AI_MODE_LABELS, AI_RUNTIME_MODES, type AiRuntimeMode } from "@/lib/ai-runtime-modes-shared";
import type { AiAppFocus } from "@/components/ai/use-ai-chat";
import { Skeleton } from "@/components/ui/skeleton";

interface Project { id: string; name: string; }

export function AiWorkspaceContext({
  appFocus,
  onAppFocusChange,
  runtimeMode,
  onRuntimeModeChange,
  deepResearchEnabled,
  projectId,
  onProjectChange,
}: {
  appFocus: AiAppFocus;
  onAppFocusChange: (value: AiAppFocus) => void;
  runtimeMode: AiRuntimeMode;
  onRuntimeModeChange: (value: AiRuntimeMode) => void;
  /** Issue #812 §6 — whether Superadmin has Deep Research switched on. */
  deepResearchEnabled: boolean;
  projectId: string | null;
  onProjectChange: (value: string | null) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void fetch("/api/ai/projects?limit=40")
      .then((response) => response.ok ? response.json() : null)
      .then((data: { projects?: Project[] } | null) => { if (active) setProjects(data?.projects ?? []); })
      .catch(() => {})
      .finally(() => { if (active) setProjectsLoading(false); });
    return () => { active = false; };
  }, []);
  const selectClass = "min-h-10 max-w-full appearance-none rounded-xl border border-border bg-background px-3 pe-8 text-xs font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border/60 bg-background/70 px-3 py-2.5 backdrop-blur-sm sm:px-5" dir="rtl">
      <label className="relative flex min-w-0 items-center gap-2" title="تمرکز بخشی فقط زمینه را محدود می‌کند و مجوز جدید نمی‌سازد">
        <span className="sr-only">تمرکز دستیار</span>
        <select value={appFocus} onChange={(event) => onAppFocusChange(event.target.value as AiAppFocus)} className={selectClass} aria-label="تمرکز دستیار">
          <option value="all">همهٔ بخش‌ها</option><option value="accounting">حسابداری</option><option value="growth">رشد</option><option value="crm">CRM</option><option value="website">وب‌سایت</option><option value="workspace">فضای کاری</option>
        </select><ChevronDownIcon className="pointer-events-none absolute end-2 size-3.5 text-muted-foreground" />
      </label>
      <label className="relative flex min-w-0 items-center gap-2">
        <span className="sr-only">حالت پاسخ‌گویی</span>
        {/* Issue #812 §7 — exactly the three user-facing modes. «پژوهش عمیق»
            is offered when Superadmin has switched the platform flag on, and it
            is not offered otherwise: a disabled option that still looks
            selectable is a lie the UI should not tell. */}
        <select value={runtimeMode} onChange={(event) => onRuntimeModeChange(event.target.value as AiRuntimeMode)} className={selectClass} aria-label="حالت پاسخ‌گویی">
          {AI_RUNTIME_MODES.filter((mode) => mode !== "deep_research" || deepResearchEnabled).map((mode) => <option key={mode} value={mode}>{AI_MODE_LABELS[mode]}</option>)}
        </select><ChevronDownIcon className="pointer-events-none absolute end-2 size-3.5 text-muted-foreground" />
      </label>
      {projectsLoading ? <Skeleton className="h-10 w-40 rounded-xl" aria-label="در حال خواندن پروژه‌ها" /> : <label className="relative flex min-w-0 flex-1 items-center gap-2 sm:flex-none">
        <FolderKanbanIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="sr-only">پروژه</span>
        <select value={projectId ?? ""} onChange={(event) => onProjectChange(event.target.value || null)} className={cn(selectClass, "w-full sm:max-w-52")} aria-label="پروژه">
          <option value="">بدون پروژه</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select><ChevronDownIcon className="pointer-events-none absolute end-2 size-3.5 text-muted-foreground" />
      </label>}
    </div>
  );
}
