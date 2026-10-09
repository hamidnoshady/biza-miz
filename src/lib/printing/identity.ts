/**
 * The business identity a printed document carries, loaded server-side.
 *
 * A receipt, a kitchen ticket and a shelf label all print the same header —
 * trade name, branch address and phone, the receipt footer — and the money
 * unit every amount on them is formatted in. Both used to be assembled by the
 * browser (from whatever the screen happened to have loaded) or by one
 * document's own loader, which is how a preview could show a footer that the
 * paper did not have.
 *
 * There are exactly two callers' worth of identity in this product and they
 * are the same identity, so there is exactly one loader:
 *
 *   - `getRetailInvoicePrintData` (the retail sale's canonical receipt), and
 *   - the print pipeline's own document loaders
 *     (`src/lib/printing/document-loader.ts`), for every other sale and label.
 *
 * The pipeline's per-job `loadPrintBranding` (plan.ts) reads the same settings
 * and additionally carries the logo; this module is the document-facing shape
 * (`ReceiptBusinessInfo`), for documents that are also served without a plan —
 * `?view=print` returns a receipt nobody has routed yet.
 */
import { query } from "../db";
import type { MoneyUnit } from "../money";
import type { ReceiptBusinessInfo } from "../receipt-template";
import { getSetting, SETTING_KEYS } from "../settings";

export interface PrintIdentity {
  /** What the printed header carries; the bridge lets a document's own fields win over the plan's branding. */
  business: ReceiptBusinessInfo;
  /** The business's display unit — the same one every screen formats money in. */
  currencyUnit: MoneyUnit;
}

interface BusinessProfileSetting {
  receiptFooter?: string;
}

interface BusinessPrefsSetting {
  currencyDisplay?: "toman" | "rial";
}

/**
 * `locationId` is the branch the document belongs to — not necessarily the one
 * the viewer is looking at. A reprint of another branch's sale (through
 * `?view=print`, the only path that is not already branch-scoped by its own
 * route) shows that branch's address and phone, never the viewer's.
 *
 * A missing row or an unfilled setting degrades to a blank field rather than
 * refusing to print: the identity is the least important thing on a receipt.
 */
export async function loadPrintIdentity(
  businessId: string,
  locationId: string,
): Promise<PrintIdentity> {
  const [{ rows: businessRows }, { rows: locationRows }, profile, prefs] = await Promise.all([
    query<{ name: string }>("SELECT name FROM businesses WHERE id = $1", [businessId]),
    query<{ address: string | null; phone: string | null }>(
      "SELECT address, phone FROM locations WHERE id = $1",
      [locationId],
    ),
    getSetting<BusinessProfileSetting>(businessId, SETTING_KEYS.businessProfile),
    getSetting<BusinessPrefsSetting>(businessId, SETTING_KEYS.businessPrefs),
  ]);

  return {
    business: {
      name: businessRows[0]?.name ?? "",
      address: locationRows[0]?.address ?? null,
      phone: locationRows[0]?.phone ?? null,
      footerMessage: profile?.receiptFooter ?? null,
    },
    currencyUnit: prefs?.currencyDisplay === "rial" ? "rial" : "toman",
  };
}
