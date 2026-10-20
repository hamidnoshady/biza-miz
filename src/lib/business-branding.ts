/**
 * BusinessDocumentBranding — single trusted server-resolved contract
 * for business identity used across print documents, PDFs, reports,
 * XLSX exports, shipment labels.
 *
 * Phase 1 of #945: unify document branding via one contract.
 */

import { query } from "./db";
import { getSetting, SETTING_KEYS } from "./settings";
import { isStoredLogo, type BusinessLogo } from "./business-logo";

export interface BusinessDocumentBranding {
  /** Business display name */
  businessName: string;
  /** Legal name (optional) */
  legalName?: string | null;
  taxId?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  /** Branch data — independent identity */
  branch?: {
    name: string | null;
    address: string | null;
    phone: string | null;
  } | null;
  /** Optional receipt footer */
  footer?: string | null;
  /** Business-wide logo (single, not per-branch) */
  logo: BusinessLogo | null;
  /** Logo data URL ready for <img> */
  logoDataUrl?: string | null;
}

interface BusinessProfileSetting {
  legalName?: string;
  taxId?: string;
  email?: string;
  website?: string;
  receiptFooter?: string;
}

/**
 * Resolve branding server-side. Used by operational print documents, PDFs,
 * PDF reports, printable invoices/receipts, shipment labels, accounting
 * reports, and human-readable XLSX exports.
 *
 * Binary logo never injected into CSV/JSON/machine-readable exports — caller
 * must check context.
 */
export async function resolveBusinessBranding(
  businessId: string,
  locationId?: string | null,
): Promise<BusinessDocumentBranding> {
  const [{ rows: businessRows }, profile, logoRaw] = await Promise.all([
    query<{ name: string }>("SELECT name FROM businesses WHERE id = $1", [businessId]),
    getSetting<BusinessProfileSetting>(businessId, SETTING_KEYS.businessProfile),
    getSetting<BusinessLogo>(businessId, SETTING_KEYS.businessLogo),
  ]);

  let branch: BusinessDocumentBranding["branch"] = null;
  if (locationId) {
    const { rows } = await query<{ name: string; address: string | null; phone: string | null }>(
      "SELECT name, address, phone FROM locations WHERE id = $1 AND business_id = $2",
      [locationId, businessId],
    );
    if (rows[0]) {
      branch = {
        name: rows[0].name ?? null,
        address: rows[0].address ?? null,
        phone: rows[0].phone ?? null,
      };
    }
  }

  const logo = isStoredLogo(logoRaw) ? logoRaw : null;

  return {
    businessName: businessRows[0]?.name ?? "",
    legalName: profile?.legalName ?? null,
    taxId: profile?.taxId ?? null,
    address: branch?.address ?? null,
    phone: branch?.phone ?? null,
    email: profile?.email ?? null,
    website: profile?.website ?? null,
    branch,
    footer: profile?.receiptFooter ?? null,
    logo,
    logoDataUrl: logo?.dataUrl ?? null,
  };
}

/**
 * Offline-safe: same identity as live preview — business-wide defaults
 * with branch overrides, single logo.
 */
export function brandingToPrintBusinessInfo(branding: BusinessDocumentBranding): {
  name: string;
  branchName?: string | null;
  legalName?: string | null;
  address?: string | null;
  phone?: string | null;
  taxId?: string | null;
  email?: string | null;
  website?: string | null;
  logoDataUrl?: string | null;
} {
  return {
    name: branding.businessName,
    branchName: branding.branch?.name ?? null,
    legalName: branding.legalName,
    address: branding.address,
    phone: branding.phone,
    taxId: branding.taxId,
    email: branding.email,
    website: branding.website,
    logoDataUrl: branding.logoDataUrl,
  };
}
