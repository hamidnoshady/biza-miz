"use client";

/**
 * Everything the printing section reads: the branch's printers, its saved
 * templates, the business header/logo a preview needs, and the local print
 * connector's status. One hook per concern, all of them refetchable, because
 * the section's tabs edit each other's data — pairing a printer changes what
 * the template gallery can print to, uploading a logo changes every preview.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/app/dashboard/ui";
import { allowConnectorRetry, connectorHealth, type ConnectorHealth } from "@/lib/printing/client";
import type { PrinterPurpose, StoredPrinterConnection } from "@/lib/printing/types";
import type { PaperKey, PrintBusinessInfo, PrintTemplate } from "@/lib/print-template";

/**
 * A `printers` row as the settings screens read it. Behaviour (purpose,
 * paper, drawer, defaultness) is relational; `connection` is the hardware
 * target and nothing else.
 */
export interface PrinterRow {
  id: string;
  name: string;
  kind: PrinterPurpose;
  connection: StoredPrinterConnection;
  is_active: boolean;
  printer_class?: "thermal" | "page" | "label" | null;
  paper?: PaperKey | null;
  paper_width_mm?: number | null;
  supports_drawer?: boolean | null;
  supports_cut?: boolean | null;
  is_default?: boolean | null;
}

export interface SavedTemplateRow extends PrintTemplate {
  id: string;
  isDefault: boolean;
  /** Bumped by every write; stamped onto each print job it produced. */
  version: number;
  updatedAt: string;
}

export function usePrinterList() {
  const [printers, setPrinters] = useState<PrinterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    const { ok, data } = await api<{ printers: PrinterRow[]; error?: string }>("/api/settings/printers");
    if (ok) {
      setPrinters(data.printers ?? []);
      setError("");
    } else {
      setError(data.error ?? "unknown");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { printers, loading, error, reload };
}

export function useSavedTemplates() {
  const [templates, setTemplates] = useState<SavedTemplateRow[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const { ok, data } = await api<{ templates: SavedTemplateRow[] }>("/api/settings/print-templates");
    if (ok) setTemplates(data.templates ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { templates, loading, reload };
}

interface BusinessResponse {
  business: { name: string } | null;
  location: { name: string; address: string | null; phone: string | null } | null;
  profile: { legalName?: string; taxId?: string; email?: string; website?: string; receiptFooter?: string } | null;
}

export interface LogoRecord {
  dataUrl: string;
  mimeType: string;
  byteLength: number;
  updatedAt: string;
}

/** The header a preview prints: business identity plus the uploaded logo. */
export function usePrintIdentity() {
  const [business, setBusiness] = useState<PrintBusinessInfo>({ name: "" });
  const [logo, setLogo] = useState<LogoRecord | null>(null);
  const [footer, setFooter] = useState("");
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const [profile, logoRes] = await Promise.all([
      api<BusinessResponse>("/api/settings/business"),
      api<{ logo: LogoRecord | null }>("/api/settings/business/logo"),
    ]);
    if (profile.ok) {
      setBusiness({
        name: profile.data.business?.name ?? "",
        legalName: profile.data.profile?.legalName ?? null,
        address: profile.data.location?.address ?? null,
        phone: profile.data.location?.phone ?? null,
        taxId: profile.data.profile?.taxId ?? null,
        email: profile.data.profile?.email ?? null,
        website: profile.data.profile?.website ?? null,
      });
      setFooter(profile.data.profile?.receiptFooter ?? "");
    }
    if (logoRes.ok) setLogo(logoRes.data.logo ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    business: { ...business, logoDataUrl: logo?.dataUrl ?? null } as PrintBusinessInfo,
    logo,
    footer,
    loading,
    reload,
  };
}

/**
 * Is the local Cafe POS Print Connector installed, running and current? It
 * is the one hardware gateway — Windows queues and network printers both —
 * so its state decides whether hardware printing is possible at all. Checked
 * once on mount and on demand; an explicit recheck clears the client's
 * short backoff so it fires immediately after the operator installs.
 */
export function useConnectorStatus() {
  const [health, setHealth] = useState<ConnectorHealth | null>(null);
  const [checking, setChecking] = useState(true);

  const recheck = useCallback(async (force = true) => {
    setChecking(true);
    if (force) allowConnectorRetry();
    const result = await connectorHealth({ force });
    setHealth(result.ok ? (result.data ?? { ok: true }) : null);
    setChecking(false);
  }, []);

  useEffect(() => {
    void recheck(false);
  }, [recheck]);

  return { health, online: health?.ok === true, checking, recheck };
}
