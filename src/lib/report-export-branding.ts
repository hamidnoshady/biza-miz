/**
 * Server-only half of the report export: the business/branch branding contract
 * that human-facing XLSX worksheets carry (#945 phase 1).
 *
 * It lives apart from `report-export.ts` on purpose. The export codecs are
 * imported by client components (the reports screen builds the same tables it
 * downloads), so a static `business-branding` import there would pull
 * `./db` into the browser bundle — `client-bundle-boundary.test.ts` fails on
 * exactly that. Only route handlers call this.
 */
import { resolveBusinessBranding } from "./business-branding";

/** Resolve the same business/branch branding contract for a human-facing XLSX worksheet. */
export async function businessXlsxBranding(businessId: string, locationId?: string | null) {
  try {
    const branding = await resolveBusinessBranding(businessId, locationId);
    return {
      businessName: branding.businessName,
      legalName: branding.legalName,
      footer: branding.footer,
      logoDataUrl: branding.logoDataUrl,
    };
  } catch {
    // Branding is decorative; an offline/export-only path still downloads the
    // underlying report without changing its numeric/table data.
    return undefined;
  }
}
