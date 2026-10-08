"use client";

import { useEffect, useState } from "react";
import { api } from "./ui";
import type { PrinterPurpose } from "@/lib/printing/types";

/**
 * The operational printer row POS/order screens work with. Callers never see
 * hardware targets — they pass this id to the print client, and the server
 * resolves it against the caller's branch.
 */
export interface PrinterRow {
  id: string;
  name: string;
  kind: PrinterPurpose;
  isDefault: boolean;
  /** A legacy pairing the new architecture cannot use; printing through it is refused. */
  needsReconnect: boolean;
  /** The printer has a cash drawer attached. Opening it is a payment event, not a print. */
  supportsDrawer?: boolean;
}

/** Active printers for the location, defaults first — used to pick a target for printing. */
export function usePrinters(): PrinterRow[] {
  const [printers, setPrinters] = useState<PrinterRow[]>([]);
  useEffect(() => {
    api<{ printers: PrinterRow[] }>("/api/printers").then(({ ok, data }) => {
      if (ok) setPrinters(data.printers);
    });
  }, []);
  return printers;
}

export function firstPrinter(printers: PrinterRow[], kind: "receipt" | "kitchen"): PrinterRow | null {
  return printers.find((p) => p.kind === kind && !p.needsReconnect) ?? null;
}

export interface BusinessInfo {
  name: string;
  address: string | null;
  phone: string | null;
  receiptFooter?: string | null;
  /**
   * The business's effective feature flags, so selling screens can align
   * their offer with what the domain layer will accept (a POS with
   * `delivery: false` never shows the delivery tab). Absent while loading or
   * on an older server — callers treat "unknown" as "allowed" and let the
   * server's refusal be the last word.
   */
  features?: Record<string, boolean>;
  /** The first request finished; absent feature flags then mean a legacy/unknown response. */
  loaded: boolean;
}

/** Business/location name + contact info for the printed receipt header. */
export function useBusinessInfo(): BusinessInfo {
  const [info, setInfo] = useState<BusinessInfo>({
    name: "",
    address: null,
    phone: null,
    loaded: false,
  });
  useEffect(() => {
    api<BusinessInfo>("/api/business-info")
      .then(({ ok, data }) => {
        setInfo((current) => (ok ? { ...data, loaded: true } : { ...current, loaded: true }));
      })
      .catch(() => setInfo((current) => ({ ...current, loaded: true })));
  }, []);
  return info;
}
