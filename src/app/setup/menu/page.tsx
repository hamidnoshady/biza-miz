import { redirect } from "next/navigation";
import { SETUP_MENU_IMPORT_HREF } from "@/lib/wizard-steps";

/**
 * Legacy `/setup/menu` → the unified «ورود اطلاعات» step (GitHub #1580).
 *
 * The duplicate restaurant menu step is gone from the visible wizard, but old
 * bookmarks, desktop deep links and stored `x-pathname` guidance may still name
 * it. A permanent server redirect is the compatibility contract:
 *
 *  - it lands on the manual section of the one import step, where the F&B
 *    category/item editor now lives (and where the canonical Data Transfer
 *    file path is one mode away);
 *  - the setup layout still owns session, permission and "already complete"
 *    handling, so a completed business is sent to `/settings` exactly as every
 *    other `/setup/*` URL is — no loop, no second importer;
 *  - historical `menu` progress markers are untouched: `computeSetupState`
 *    keeps reconciling them against the branch's sellable items, which remains
 *    the POS readiness prerequisite.
 */
export default function LegacyMenuStepPage() {
  redirect(SETUP_MENU_IMPORT_HREF);
}
