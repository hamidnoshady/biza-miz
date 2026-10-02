"use client";

/**
 * The Workspace command bar (#761 §5, §19): search, contextual «+ ایجاد»,
 * the assistant, and what is waiting on me — one compact row above every
 * Workspace page, plus the Ctrl/Cmd+K palette.
 *
 * Nothing here holds data of its own. Search goes through
 * `/api/workspace/search` (the scoped list functions), the attention count is
 * the approvals list's own server total, and every create action is a link
 * into the section that owns the dialog — so the bar cannot disagree with
 * the pages, or show a name the member could not open.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BellIcon,
  BotIcon,
  BriefcaseIcon,
  CheckSquareIcon,
  FileTextIcon,
  FileSignatureIcon,
  PlusIcon,
  SearchIcon,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { api, inputClass } from "@/app/dashboard/ui";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";
import { workspaceSectionHref } from "@/lib/app-routes";
import { cn } from "@/lib/utils";
import { WORKSPACE_SECTION_META, visibleWorkspaceSections, workspaceCreateActions } from "./workspace-routes";
import {
  WorkspaceEntityDrawer,
  type WorkspaceEntityKind,
  type WorkspaceEntityRef,
} from "./workspace-entity-drawer";

interface SearchResult {
  kind: WorkspaceEntityKind;
  id: string;
  title: string;
  subtitle: string | null;
}

const KIND_META: Record<WorkspaceEntityKind, { label: string; icon: LucideIcon }> = {
  project: { label: "پروژه", icon: BriefcaseIcon },
  task: { label: "وظیفه", icon: CheckSquareIcon },
  document: { label: "سند", icon: FileTextIcon },
  contract: { label: "قرارداد", icon: FileSignatureIcon },
};

/** The assistant is the platform home (`/dashboard`), not a Workspace page. */
const ASSISTANT_HREF = "/dashboard";

export function WorkspaceCommandBar({
  permissions,
  projectId,
}: {
  permissions: readonly string[];
  /** Inside a project page: create actions preselect it. */
  projectId?: string;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawer, setDrawer] = useState<WorkspaceEntityRef | null>(null);
  const [waiting, setWaiting] = useState<number | null>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const createActions = useMemo(
    () => workspaceCreateActions(permissions, projectId),
    [permissions, projectId],
  );

  // Ctrl/Cmd+K anywhere in the Workspace.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // «منتظر تصمیم من» — the approvals list's own server total.
  useEffect(() => {
    const abort = new AbortController();
    api<{ page?: { total: number } }>("/api/workspace/approvals?mine=true&status=pending&limit=1", {
      signal: abort.signal,
    }).then(({ ok, data, aborted }) => {
      if (!aborted && ok) setWaiting(data.page?.total ?? 0);
    });
    return () => abort.abort();
  }, []);

  return (
    <div
      role="toolbar"
      aria-label="نوار فرمان میز کار"
      className="flex flex-wrap items-center gap-2"
    >
      <button
        ref={searchButton}
        type="button"
        onClick={() => setPaletteOpen(true)}
        className={cn(
          inputClass,
          "flex min-w-0 flex-1 items-center gap-2 text-start text-muted-foreground sm:max-w-sm",
        )}
        aria-keyshortcuts="Control+K Meta+K"
      >
        <SearchIcon className="size-4 shrink-0" aria-hidden />
        <span className="truncate">جست‌وجو در پروژه‌ها، وظایف، اسناد و قراردادها…</span>
        <kbd className="ms-auto hidden rounded border border-border/80 px-1.5 text-xs sm:inline" dir="ltr">
          Ctrl K
        </kbd>
      </button>

      {createActions.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button">
              <PlusIcon className="size-4" aria-hidden />
              ایجاد
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {createActions.map((action) => (
              <DropdownMenuItem key={action.key} asChild>
                <Link href={action.href}>{action.label}</Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <Button variant="outline" asChild>
        <Link href={ASSISTANT_HREF}>
          <BotIcon className="size-4" aria-hidden />
          پرسش از دستیار
        </Link>
      </Button>

      <Button variant="outline" asChild>
        <Link
          href={`${workspaceSectionHref("approvals")}`}
          aria-label={
            waiting ? `${toPersianDigits(String(waiting))} مورد منتظر تصمیم شما` : "تأییدهای منتظر تصمیم شما"
          }
        >
          <BellIcon className="size-4" aria-hidden />
          {waiting ? (
            <span className="tabular-nums">{toPersianDigits(String(waiting))}</span>
          ) : null}
        </Link>
      </Button>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        permissions={permissions}
        projectId={projectId}
        returnFocusTo={searchButton}
        onOpenEntity={(entity) => {
          setPaletteOpen(false);
          setDrawer(entity);
        }}
      />
      <WorkspaceEntityDrawer
        entity={drawer}
        onClose={() => setDrawer(null)}
        returnFocusTo={searchButton}
      />
    </div>
  );
}

interface PaletteItem {
  id: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  run: () => void;
}

function CommandPalette({
  open,
  onOpenChange,
  permissions,
  projectId,
  returnFocusTo,
  onOpenEntity,
}: {
  returnFocusTo: React.RefObject<HTMLButtonElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  permissions: readonly string[];
  projectId?: string;
  onOpenEntity: (entity: WorkspaceEntityRef) => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setActive(0);
    }
  }, [open]);

  // Debounced, and cancelled when the query changes: a slow answer to an old
  // query must never replace the answer to the new one.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    const abort = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      api<{ results: SearchResult[] }>(`/api/workspace/search?q=${encodeURIComponent(q)}`, {
        signal: abort.signal,
      }).then(({ ok, data, aborted }) => {
        if (aborted) return;
        setResults(ok ? data.results : []);
        setSearching(false);
        setActive(0);
      });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [query]);

  const go = useCallback(
    (href: string) => {
      onOpenChange(false);
      router.push(href);
    },
    [onOpenChange, router],
  );

  const items: PaletteItem[] = useMemo(() => {
    const q = query.trim();
    const commands: PaletteItem[] = [
      ...workspaceCreateActions(permissions, projectId).map((action) => ({
        id: `create:${action.key}`,
        label: action.label,
        hint: "فرمان",
        icon: PlusIcon,
        run: () => go(action.href),
      })),
      ...visibleWorkspaceSections(permissions).map((section) => ({
        id: `go:${section.key}`,
        label: `رفتن به ${section.label}`,
        hint: "بخش",
        icon: WORKSPACE_SECTION_META[section.key].icon,
        run: () => go(workspaceSectionHref(section.key)),
      })),
      {
        id: "go:mine",
        label: "وظایف واگذارشده به من",
        hint: "فرمان",
        icon: CheckSquareIcon,
        run: () => go(`${workspaceSectionHref("tasks")}?mine=true`),
      },
      {
        id: "ask",
        label: "پرسش از دستیار",
        hint: "فرمان",
        icon: BotIcon,
        run: () => go(ASSISTANT_HREF),
      },
    ].filter((command) => !q || command.label.includes(q));
    const found: PaletteItem[] = results.map((result) => ({
      id: `${result.kind}:${result.id}`,
      label: result.title,
      hint: [KIND_META[result.kind].label, result.subtitle].filter(Boolean).join(" · "),
      icon: KIND_META[result.kind].icon,
      run: () => onOpenEntity({ kind: result.kind, id: result.id }),
    }));
    return [...found, ...commands];
  }, [query, results, permissions, projectId, go, onOpenEntity]);

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.max(0, Math.min(index + 1, items.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      items[active]?.run();
    }
  }

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const activeId = items[active] ? `palette-${items[active].id}` : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          // Opened from the keyboard there is no trigger to return to; the
          // search button is the palette's visible home.
          event.preventDefault();
          returnFocusTo.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">جست‌وجو و فرمان</DialogTitle>
        <DialogDescription className="sr-only">
          نام پروژه، وظیفه، سند یا قرارداد را بنویسید، یا فرمانی را انتخاب کنید.
        </DialogDescription>
        <div className="flex items-center gap-2 border-b border-border/80 p-3">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="workspace-palette-list"
            aria-activedescendant={activeId}
            aria-label="جست‌وجو یا فرمان"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            placeholder="جست‌وجو یا فرمان…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <ul
          id="workspace-palette-list"
          ref={listRef}
          role="listbox"
          aria-label="نتیجه‌ها"
          className="max-h-[60vh] overflow-y-auto p-2"
        >
          {searching && results.length === 0 ? (
            <li>
              <LoadingSkeleton rows={3} label="در حال جست‌وجو" />
            </li>
          ) : items.length === 0 ? (
            <li className="p-4 text-center text-sm text-muted-foreground">چیزی پیدا نشد.</li>
          ) : (
            items.map((item, index) => {
              const Icon = item.icon;
              return (
                <li
                  key={item.id}
                  id={`palette-${item.id}`}
                  data-index={index}
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={item.run}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm",
                    index === active && "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-200",
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{item.hint}</span>
                </li>
              );
            })
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
