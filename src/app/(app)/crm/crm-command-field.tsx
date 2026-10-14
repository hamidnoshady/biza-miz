"use client";

/**
 * «جست‌وجو یا بپرس…» — the CRM's command field.
 *
 * ## What it is for
 *
 * The app has twelve destinations, thirteen queues and a directory of
 * thousands. A person who has learned the app still arrives with a *question*,
 * not a menu path: «چه چیزی عقب افتاده؟», «معامله‌های راکد», «مریم». This field
 * answers all three from one box, which is why it sits in the app shell rather
 * than inside any one screen.
 *
 * ## What it can and cannot do
 *
 * Every answer is one of three shapes, and the field can produce nothing else:
 *
 * 1. a **destination** — a section the member may open;
 * 2. a **queue** — a named list of records, linked to the screen that owns it;
 * 3. a **person search** — the query, handed to the directory as `?q=`.
 *
 * The vocabulary is the grammar (`crm-commands.ts`), so there is no statement
 * a phrase could produce. Nothing typed here is ever sent to a database: the
 * worst a wrong match can do is offer the wrong *screen*, and the screen decides
 * what the member sees. That property is structural — the interpreter returns
 * keys, not queries — and it is what lets this field stay useful without a model
 * in the middle.
 *
 * ## Why it shows its work
 *
 * Under the box the field prints what it understood («فهمیدم: معامله‌های راکد →
 * صف معامله‌های راکد») before anything is opened. A search box that silently
 * guesses is one people stop trusting; one that says which of the two meanings
 * of «امروز» it picked is one they can correct by typing two more letters.
 *
 * ## Keyboard
 *
 * `Ctrl/⌘ + K` focuses the field from anywhere in the app — the platform's own
 * shortcut, so the muscle memory carries between Growth, Accounting and here.
 * `↑`/`↓` choose among the answers, `Enter` opens the highlighted one (or the
 * first), `Escape` clears. Every answer is also a link, so this is an
 * enhancement over a working list rather than the only way through it — and the
 * whole thing is a `combobox` for anyone on a screen reader.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CornerDownLeftIcon, SearchIcon } from "lucide-react";
import { inputClass } from "@/app/dashboard/ui";
import { popoverPanelClass } from "@/app/dashboard/page-chrome";
import { canViewCrmSection, type CrmSectionKey } from "@/lib/crm-permissions";
import { CRM_QUEUE_PRESENTATION, type CrmQueueKey } from "@/lib/crm-shared";
import type { Permission } from "@/lib/permissions";
import { availableCrmCommands, interpretCrmCommand } from "@/lib/crm-commands";
import { CRM_NAV_ITEMS } from "./crm-nav";

/**
 * Labels for the sections the menu does not list.
 *
 * `persons` is a real destination — one customer's 360° file — but it is
 * reached from the directory rather than sitting in the sidebar, so the nav
 * list has no entry to borrow a label from.
 */
const OFF_MENU_LABELS: Partial<Record<CrmSectionKey, string>> = {
  persons: "پروندهٔ مشتری",
};

export function crmSectionLabel(key: CrmSectionKey): string {
  return CRM_NAV_ITEMS.find((item) => item.key === key)?.label ?? OFF_MENU_LABELS[key] ?? key;
}

function queueLabel(key: string): string {
  return CRM_QUEUE_PRESENTATION[key as CrmQueueKey]?.label ?? key;
}

interface CommandOption {
  id: string;
  /** The line the reader chooses between. */
  label: string;
  /** Where it goes and what will be there — the second line. */
  detail: string;
  href: string;
}

export function CrmCommandField({ permissions }: { permissions?: readonly string[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const held = useMemo(() => new Set(permissions ?? []) as ReadonlySet<Permission>, [permissions]);
  const canOpen = useCallback((section: CrmSectionKey) => canViewCrmSection(held, section), [held]);

  const interpretation = useMemo(() => interpretCrmCommand(text), [text]);

  /**
   * The answers, permissions already applied.
   *
   * A destination the member may not open is not offered at all — not greyed
   * out, not shown with a lock: the menu does not show it, so neither does the
   * field. Filtering here rather than at render time is deliberate: the same
   * function that decides is the one the answer list is built from, so there is
   * no second place for the two to disagree.
   */
  const options = useMemo<CommandOption[]>(() => {
    const matches = availableCrmCommands(interpretation.matches, canOpen);
    const optionList: CommandOption[] = matches.map((match) =>
      match.kind === "queue"
        ? {
            id: `queue:${match.key}`,
            label: queueLabel(match.key),
            detail: `صف در «${crmSectionLabel(match.section)}»`,
            // The anchor opens the owning screen *at* the queue rather than at
            // its top — the screen already draws it, and the id is on the card.
            href: `${match.href}#crm-queue-${match.key}`,
          }
        : {
            id: `section:${match.key}`,
            label: crmSectionLabel(match.section),
            detail: "بخش",
            href: match.href,
          },
    );

    const query = text.trim();
    if (interpretation.searchPeople && query.length >= 2 && canOpen("directory")) {
      optionList.push({
        id: "person-search",
        label: `جست‌وجو در مشتریان برای «${query}»`,
        detail: "نام، شمارهٔ تماس یا کد اقتصادی",
        href: `/crm/directory?q=${encodeURIComponent(query)}`,
      });
    }
    return optionList;
  }, [interpretation, canOpen, text]);

  // Keep the highlight inside the list when the list changes under it.
  useEffect(() => {
    setActiveIndex((index) => (index < options.length ? index : 0));
  }, [options.length]);

  /** `Ctrl/⌘+K`, the platform's shortcut, wherever the focus happens to be. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /** Clicking away closes the list without clearing the text. */
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const go = (option: CommandOption | undefined) => {
    if (!option) return;
    setOpen(false);
    router.push(option.href);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setText("");
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      setOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index + step + options.length) % options.length);
      return;
    }
    if (event.key === "Enter") {
      if (!open || options.length === 0) return;
      event.preventDefault();
      go(options[activeIndex] ?? options[0]);
    }
  };

  const showResults = open && text.trim().length >= 2;
  const active = options[activeIndex];

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
        />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={showResults && options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active && showResults ? `${listId}-${active.id}` : undefined}
          aria-label="جست‌وجو یا پرسش در ارتباط با مشتری"
          placeholder="جست‌وجو یا بپرس… مثلاً «پیگیری‌های عقب‌افتاده» یا نام مشتری"
          autoComplete="off"
          className={`${inputClass} ps-9 pe-16`}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {/* The hint is a real element rather than placeholder text: a
            placeholder disappears exactly when the reader needs the reminder. */}
        <kbd
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 end-2 my-auto hidden h-6 items-center rounded-md border border-border/80 bg-muted px-1.5 text-[11px] font-medium text-muted-foreground sm:flex"
        >
          Ctrl K
        </kbd>
      </div>

      {/* The shared floating-panel skin, composed rather than restated — see
          `docs/design-system.md` §Floating surfaces. */}
      {showResults && options.length > 0 ? (
        <div className={`absolute inset-x-0 top-full z-30 mt-1.5 p-1.5 ${popoverPanelClass}`}>
          {/* What was understood, in the reader's own words — visible before
              anything opens, so a wrong guess is correctable rather than
              mysterious. */}
          <p className="px-2 py-1.5 text-xs leading-5 text-muted-foreground">
            فهمیدم: «{interpretation.normalized}»
          </p>
          <ul id={listId} role="listbox" aria-label="پیشنهادها" className="max-h-80 overflow-y-auto">
            {options.map((option, index) => (
              <li key={option.id}>
                <Link
                  id={`${listId}-${option.id}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  href={option.href}
                  onClick={() => setOpen(false)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`flex items-center justify-between gap-3 rounded-xl px-2 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 ${
                    index === activeIndex ? "bg-muted" : ""
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-foreground">{option.label}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {option.detail}
                    </span>
                  </span>
                  {index === activeIndex ? (
                    <CornerDownLeftIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
