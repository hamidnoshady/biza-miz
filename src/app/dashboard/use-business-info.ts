"use client";

/**
 * The business header the selling screens need — name and contact details,
 * nothing about printers. The POS no longer picks a printer at all: it names a
 * document type and the server's print plan decides (see docs/printing.md).
 */
import { useEffect, useState } from "react";
import { api } from "./ui";

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
}

/** Business/location name + contact info for the printed receipt header. */
export function useBusinessInfo(): BusinessInfo {
  const [info, setInfo] = useState<BusinessInfo>({ name: "", address: null, phone: null });
  useEffect(() => {
    api<BusinessInfo>("/api/business-info").then(({ ok, data }) => ok && setInfo(data));
  }, []);
  return info;
}
