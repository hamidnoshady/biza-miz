"use client";

/**
 * One fetch for the whole business workspace.
 *
 * The workspace is split into sections (overview, settings, plan, features,
 * support, danger), but every section needs the same business summary — and
 * the settings panels need `rootDomain`, the alias list, and the industry
 * counts to warn about. Fetching once in the layout and handing it down
 * through context means tab changes are instant, no section races another
 * section's write, and a save in one panel refreshes the header everywhere.
 *
 * A deleted / not-found business lives here as `notFound` so every section can
 * render the same empty state instead of six divergent error paths.
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { type Industry } from "@/lib/industries";
import type { BusinessLifecycleStatus } from "@/lib/platform-business-lifecycle";
import { api, errorMessage } from "../../ui";

export interface Business {
  id: string;
  name: string;
  slug: string;
  subdomain: string;
  /** The lifecycle state; the transition policy needs the union, not a string. */
  status: BusinessLifecycleStatus;
  plan: string;
  timezone: string;
  industry: Industry;
  createdAt: string;
  suspendedAt: string | null;
  archivedAt: string | null;
  locationCount: number;
  memberCount: number;
  orderCount: number;
  lastActivityAt: string | null;
}

export interface Alias {
  alias: string;
  createdAt: string;
}

/** What a type change would leave behind, counted server-side (platform-service.ts). */
export interface IndustryCounts {
  menuItems: number;
  industryItems: number;
  orders: number;
  journalEntries: number;
}

interface BusinessData {
  id: string;
  business: Business | null;
  rootDomain: string;
  aliases: Alias[];
  industryCounts: IndustryCounts | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  setNotice: (s: string | null) => void;
  reload: () => Promise<void>;
  changeStatus: (status: string, label: string) => Promise<void>;
  /** Bumped after every successful write/reset — panels fetch their own
   * side-data (features, grants, pairing codes) and refetch on it. */
  version: number;
}

const Ctx = createContext<BusinessData | null>(null);

export function useBusiness(): BusinessData {
  const value = useContext(Ctx);
  if (!value) throw new Error("useBusiness must be used inside BusinessDataProvider");
  return value;
}

export function BusinessDataProvider({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [business, setBusiness] = useState<Business | null>(null);
  const [rootDomain, setRootDomain] = useState("");
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [industryCounts, setIndustryCounts] = useState<IndustryCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const reload = useCallback(async () => {
    const { ok, data } = await api<{
      business: Business;
      rootDomain?: string;
      aliases?: Alias[];
      industryCounts?: IndustryCounts;
      error?: string;
    }>(`/api/platform/businesses/${id}`);
    if (ok) {
      setBusiness(data.business);
      setRootDomain(data.rootDomain ?? "");
      setAliases(data.aliases ?? []);
      setIndustryCounts(data.industryCounts ?? null);
      setError(null);
      setVersion((v) => v + 1);
    } else {
      setError(errorMessage(data.error));
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  const changeStatus = useCallback(
    async (status: string, label: string) => {
      if (!window.confirm(`«${business?.name}» به وضعیت ${label} تغییر کند؟`)) return;
      setError(null);
      setNotice(null);
      const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      if (ok) {
        setNotice(`وضعیت به «${label}» تغییر کرد.`);
        await reload();
      } else {
        setError(errorMessage(data.error));
      }
    },
    [business?.name, id, reload],
  );

  return (
    <Ctx.Provider
      value={{
        id,
        business,
        rootDomain,
        aliases,
        industryCounts,
        loading,
        error,
        notice,
        setNotice,
        reload,
        changeStatus,
        version,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
