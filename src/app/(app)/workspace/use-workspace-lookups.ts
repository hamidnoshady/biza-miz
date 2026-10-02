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
  /**
   * Present only for an AEC tenant: the professional roles its operating
   * profile allows a participant to be recorded under. Absent — not empty —
   * for every other industry, so a picker can branch on the list's existence.
   */
  participantRoles?: Array<{ key: string; label: string; group: string }>;
}

export const EMPTY_LOOKUPS: WorkspaceLookups = {
  members: [], parties: [], projects: [], media: [],
};

export function useWorkspaceLookups(): WorkspaceLookups {
  const [lookups, setLookups] = useState<WorkspaceLookups>(EMPTY_LOOKUPS);
  useEffect(() => {
    api<WorkspaceLookups>("/api/workspace/lookups").then(({ ok, data }) => {
      if (ok) setLookups(data);
    });
  }, []);
  return lookups;
}
