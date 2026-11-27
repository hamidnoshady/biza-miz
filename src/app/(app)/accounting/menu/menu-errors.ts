/**
 * GH #1567 A2 — the menu feature's own reading of an API error code.
 *
 * The shared dashboard vocabulary (`errorMessage` in dashboard/ui.tsx, which
 * is protected) has no sentence for `embedded_media`, so a refused menu text
 * fell through to «خطای غیرمنتظره». This local helper puts the approved
 * sentence in front of the shared map for the menu screens only; every other
 * code reads exactly as before.
 */
import { errorMessage } from "@/app/dashboard/ui";
import { EMBEDDED_MEDIA_DESCRIPTION_MESSAGE } from "@/lib/embedded-media-guard";

const MENU_ERROR_MESSAGES: Record<string, string> = {
  embedded_media: EMBEDDED_MEDIA_DESCRIPTION_MESSAGE,
};

/** The Persian sentence for a menu API error code. */
export function menuErrorMessage(code: string | undefined): string {
  return MENU_ERROR_MESSAGES[code ?? ""] ?? errorMessage(code);
}

/**
 * A form error as the sheet receives it — usually already a sentence, but a
 * raw `embedded_media` code is never shown as-is.
 */
export function menuFormError(error: string | undefined): string {
  if (!error) return "";
  return MENU_ERROR_MESSAGES[error] ?? error;
}
