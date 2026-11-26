"use client";

import { useEffect, useState } from "react";
import { api } from "@/app/dashboard/ui";
import type { AecCapabilityKey } from "@/lib/aec";
import { toPersianDigits } from "@/lib/digits";

/**
 * The three pickers every workspace form needs, fetched once per mount of the
 * module body and passed down as a prop.
 *
 * One read rather than one per dialog: a task dialog, a contract dialog and a
 * document dialog all need the same member list, and three copies of it would
 * be three round trips and three chances to be out of date with each other.
 */
export interface WorkspaceLookups {
  members: Array<{ id: string; fullName: string; role: string }>;
  parties: Array<{ id: string; name: string }>;
  /** How many live parties exist, and whether `parties` is only the first page. */
  partiesTotal?: number;
  partiesHasMore?: boolean;
  projects: Array<{ id: string; name: string }>;
  /** Files already in the Media Library — id and name only; see the route. */
  media: Array<{ id: string; fileName: string }>;
  /**
   * Present only for an AEC tenant: the professional roles its operating
   * profile allows a participant to be recorded under. Absent — not empty —
   * for every other industry, so a picker can branch on the list's existence.
   */
  participantRoles?: Array<{ key: string; label: string; group: string }>;
  /**
   * Present only for an AEC tenant: the resolved capabilities, which is what
   * the project cockpit reads to decide which sections exist (#799 §21). The
   * capability keys are the catalogue's, so a component passes this straight
   * to `aecProjectTabs`.
   */
  aecCapabilities?: AecCapabilityKey[];
  /**
   * Present only for an advertising agency (issue #1128 §D): the project page
   * mounts the billing panel — schedule, milestones, change requests — when
   * this is here.
   *
   * Absent rather than `false` for every other trade, for the reason the two
   * AEC entries above give: the flag is what stops a café's project page from
   * calling `/api/agency/**` and rendering an `industry_mismatch` banner for a
   * request it should never have made. A screen that has to ask whether it
   * exists is a screen that has already fetched.
   */
  agencyCommercial?: true;
  /**
   * Issue #907 F10 — a picker has to be able to say «در حال بارگذاری» and «خطا»
   * instead of showing an empty list that looks like "nothing exists". These
   * two travel with the lists because they describe the same read.
   */
  loading?: boolean;
  error?: string;
}

export const EMPTY_LOOKUPS: WorkspaceLookups = {
  members: [], parties: [], projects: [], media: [],
};

/** `enabled: false` skips the read — for a caller that was handed lookups. */
export function useWorkspaceLookups(enabled = true): WorkspaceLookups {
  const [lookups, setLookups] = useState<WorkspaceLookups>(EMPTY_LOOKUPS);
  useEffect(() => {
    if (!enabled) return;
    setLookups((prev) => ({ ...prev, loading: true, error: undefined }));
    let live = true;
    api<WorkspaceLookups>("/api/workspace/lookups").then(({ ok, data }) => {
      if (!live) return;
      if (ok) setLookups({ ...data, loading: false });
      else setLookups((prev) => ({ ...prev, loading: false, error: "خطا در بارگذاری فهرست‌های انتخابی" }));
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return lookups;
}

/** A term shorter than this is not sent to the server; the embedded page stands. */
export const PARTY_SEARCH_MIN_LENGTH = 2;

export interface WorkspacePartySearch {
  /** The rows the server matched, in name order. */
  parties: Array<{ id: string; name: string }>;
  /** The row the form already holds, resolved by id rather than by the term. */
  selected: Array<{ id: string; name: string }>;
  total: number;
  hasMore: boolean;
  loading: boolean;
  /** The term was long enough to search, so `parties` is the server's answer. */
  active: boolean;
  error?: string;
}

const EMPTY_PARTY_SEARCH: WorkspacePartySearch = {
  parties: [], selected: [], total: 0, hasMore: false, loading: false, active: false,
};

/**
 * Issue #907 F10 — the search half of the party picker.
 *
 * Debounced, aborted by generation (the same rule the calendar and member
 * reads follow): a slow response for an old term can never replace the list
 * for the term on screen. Below `PARTY_SEARCH_MIN_LENGTH` nothing is sent and
 * the picker keeps the page the shared lookups read already returned, so a
 * form opening costs no extra request.
 */
export function useWorkspacePartySearch(
  term: string,
  selectedId = "",
  base: ReadonlyArray<{ id: string; name: string }> = [],
): WorkspacePartySearch {
  const [result, setResult] = useState<WorkspacePartySearch>(EMPTY_PARTY_SEARCH);
  // Clearing the search box returns to the embedded page; a party chosen from
  // a search result may not be on it, so the names the server has already
  // resolved are kept and the field stays named.
  const [remembered, setRemembered] = useState<Array<{ id: string; name: string }>>([]);
  const needle = term.trim();
  const active = needle.length >= PARTY_SEARCH_MIN_LENGTH;
  // The embedded page is a page, not the directory. A form opened on a record
  // whose party falls outside it must still name that party, so the selection
  // the page does not carry is resolved by id before any term is typed.
  const selectedIds = selectedId ? selectedId.split(",").filter(Boolean) : [];
  const known = new Set([...base.map((row) => row.id), ...remembered.map((row) => row.id)]);
  const unresolved = selectedIds.filter((id) => !known.has(id)).join(",");

  useEffect(() => {
    if (active || !unresolved) return;
    let live = true;
    const params = new URLSearchParams({ ids: unresolved, pageSize: "1" });
    api<{ selected?: Array<{ id: string; name: string }> }>(
      `/api/workspace/lookups/parties?${params.toString()}`,
    ).then(({ ok, data, aborted }) => {
      if (!live || aborted || !ok || !data.selected?.length) return;
      setRemembered((previous) => {
        const byId = new Map(previous.map((row) => [row.id, row]));
        for (const row of data.selected ?? []) byId.set(row.id, row);
        return [...byId.values()];
      });
    });
    return () => {
      live = false;
    };
  }, [active, unresolved]);

  useEffect(() => {
    if (!active) {
      setResult(EMPTY_PARTY_SEARCH);
      return;
    }
    let live = true;
    setResult((prev) => ({ ...prev, loading: true, active: true, error: undefined }));
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: needle, pageSize: "25" });
      // The selection travels with the search so the picker can still name it
      // when it does not match the term.
      if (selectedId) params.set("ids", selectedId);
      api<Omit<WorkspacePartySearch, "loading" | "active" | "error">>(
        `/api/workspace/lookups/parties?${params.toString()}`,
      ).then(({ ok, data, aborted }) => {
        if (!live || aborted) return;
        if (ok) {
          if (data.selected?.length) {
            setRemembered((previous) => {
              const byId = new Map(previous.map((row) => [row.id, row]));
              for (const row of data.selected) byId.set(row.id, row);
              return [...byId.values()];
            });
          }
          setResult({
            parties: data.parties ?? [],
            selected: data.selected ?? [],
            total: data.total ?? 0,
            hasMore: data.hasMore === true,
            loading: false,
            active: true,
          });
        } else {
          setResult({
            ...EMPTY_PARTY_SEARCH,
            active: true,
            error: "خطا در جست‌وجوی طرف حساب",
          });
        }
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [active, needle, selectedId]);

  return active ? result : { ...EMPTY_PARTY_SEARCH, selected: remembered };
}

/**
 * The options one party picker shows: the server's matches once a term is
 * active, otherwise the page that came with the lookups — and always the row
 * the form already holds, so opening an edit panel never blanks its field.
 */
export function partyPickerOptions(
  base: ReadonlyArray<{ id: string; name: string }>,
  search: WorkspacePartySearch,
  selectedIds: string | ReadonlyArray<string>,
): Array<{ id: string; label: string }> {
  const rows = search.active ? search.parties : base;
  const options = rows.map((row) => ({ id: row.id, label: row.name }));
  const ids = (Array.isArray(selectedIds) ? selectedIds : [selectedIds]).filter(Boolean);
  const missing: Array<{ id: string; label: string }> = [];
  for (const selectedId of ids) {
    if (options.some((option) => option.id === selectedId)) continue;
    const found =
      search.selected.find((row) => row.id === selectedId) ??
      base.find((row) => row.id === selectedId);
    if (found) missing.push({ id: found.id, label: found.name });
  }
  options.unshift(...missing);
  return options;
}

/**
 * The size of the page that travelled with the lookups read.
 *
 * `base` is a page, not the directory, so a picker that shows it without a
 * word of explanation looks like the whole truth: a member types nothing, sees
 * twenty-five names and concludes the party they need does not exist. These
 * two numbers are what let the picker say otherwise before anything is typed.
 */
export interface PartyPage {
  total?: number;
  hasMore?: boolean;
}

/** The embedded page's own size, from the shared lookups read. */
export function partyPageFrom(
  lookups: Pick<WorkspaceLookups, "parties" | "partiesTotal" | "partiesHasMore"> | null | undefined,
): PartyPage {
  return { total: lookups?.partiesTotal, hasMore: lookups?.partiesHasMore };
}

function partyPickerNote(
  search: WorkspacePartySearch,
  baseCount: number,
  page: PartyPage,
): string | undefined {
  if (search.error) return search.error;
  if (search.active) {
    if (!search.hasMore) return undefined;
    return `${toPersianDigits(String(search.parties.length))} مورد از ${toPersianDigits(String(search.total))} مورد نمایش داده شد؛ نام را دقیق‌تر کنید.`;
  }
  // Before a term is typed the picker shows the embedded page. When that page
  // is not the whole directory, say so and say what reaches the rest, so the
  // short list never reads as "no such party".
  if (!page.hasMore) return undefined;
  const total = page.total ?? 0;
  if (total <= baseCount) return undefined;
  return `${toPersianDigits(String(baseCount))} مورد از ${toPersianDigits(String(total))} مورد نمایش داده شد؛ برای دیدن بقیه جست‌وجو کنید.`;
}

export interface PartyPicker {
  /** Feed the box's text in; the hook owns the debounce and the request. */
  setTerm: (term: string) => void;
  /** What the picker's `options` prop takes — matches, page fallback, selection. */
  options: Array<{ id: string; label: string }>;
  searching: boolean;
  /** Why the list is partial or missing — error first, then the truncation note. */
  note?: string;
}

/**
 * One party picker for every form that has a «طرف حساب» field.
 *
 * Contracts, documents and projects had each written the same three pieces —
 * the term state, the debounced search, and the note that explains a truncated
 * page — so a fix to one rule reached only one form. They live here now, and a
 * picker added later gets the debounce, the stale-response drop and the
 * remembered selection for free.
 */
export function usePartyPicker(
  base: ReadonlyArray<{ id: string; name: string }>,
  selectedId: string,
  page: PartyPage = {},
): PartyPicker {
  const [term, setTerm] = useState("");
  const search = useWorkspacePartySearch(term, selectedId, base);
  return {
    setTerm,
    options: partyPickerOptions(base, search, selectedId),
    searching: search.loading,
    note: partyPickerNote(search, base.length, page),
  };
}

export interface PartyPickerList {
  /** The box's current text, for a controlled search input. */
  term: string;
  /** Feed the list's search box in; the hook owns the debounce and the request. */
  setTerm: (term: string) => void;
  /** Matches, page fallback, and every chosen row even when it does not match. */
  options: Array<{ id: string; label: string }>;
  searching: boolean;
  /** Why the list is partial or missing — error first, then the truncation note. */
  note?: string;
}

/**
 * The multi-select cousin of `usePartyPicker`: an invitation list or a
 * recipient list asks the same server search and keeps every chosen row in it,
 * so the embedded page can stay small there too.
 */
export function usePartyPickerList(
  base: ReadonlyArray<{ id: string; name: string }>,
  selectedIds: ReadonlyArray<string>,
  page: PartyPage = {},
): PartyPickerList {
  const [term, setTerm] = useState("");
  const joined = selectedIds.join(",");
  const search = useWorkspacePartySearch(term, joined, base);
  return {
    term,
    setTerm,
    options: partyPickerOptions(base, search, selectedIds),
    searching: search.loading,
    note: partyPickerNote(search, base.length, page),
  };
}
