"use client";

import { useEffect, useState } from "react";
import { api } from "@/app/dashboard/ui";
import type { AecCapabilityKey } from "@/lib/aec";

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
export function useWorkspacePartySearch(term: string, selectedId = ""): WorkspacePartySearch {
  const [result, setResult] = useState<WorkspacePartySearch>(EMPTY_PARTY_SEARCH);
  // Clearing the search box returns to the embedded page; a party chosen from
  // a search result may not be on it, so the names the server has already
  // resolved are kept and the field stays named.
  const [remembered, setRemembered] = useState<Array<{ id: string; name: string }>>([]);
  const needle = term.trim();
  const active = needle.length >= PARTY_SEARCH_MIN_LENGTH;

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
  selectedId: string,
): Array<{ id: string; label: string }> {
  const rows = search.active ? search.parties : base;
  const options = rows.map((row) => ({ id: row.id, label: row.name }));
  if (selectedId && !options.some((option) => option.id === selectedId)) {
    const found =
      search.selected.find((row) => row.id === selectedId) ??
      base.find((row) => row.id === selectedId);
    if (found) options.unshift({ id: found.id, label: found.name });
  }
  return options;
}
