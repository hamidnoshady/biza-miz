"use client";

import { useEffect, useState } from "react";
import { api } from "@/app/dashboard/ui";

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
  projects: Array<{ id: string; name: string }>;
  /** Files already in the Media Library — id and name only; see the route. */
  media: Array<{ id: string; fileName: string }>;
}

export const EMPTY_LOOKUPS: WorkspaceLookups = {
  members: [], parties: [], projects: [], media: [],
};

/** `enabled: false` skips the read — for a caller that was handed lookups. */
export function useWorkspaceLookups(enabled = true): WorkspaceLookups {
  const [lookups, setLookups] = useState<WorkspaceLookups>(EMPTY_LOOKUPS);
  useEffect(() => {
    if (!enabled) return;
    api<WorkspaceLookups>("/api/workspace/lookups").then(({ ok, data }) => {
      if (ok) setLookups(data);
    });
  }, [enabled]);
  return lookups;
}
