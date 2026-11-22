import { redirect } from "next/navigation";

/**
 * Issue #1367 — the Deep Research platform console is retired.
 *
 * The separate tab is gone from the AI console, so this URL now forwards to the
 * canonical runtime-mode screen where the three live chat modes (Auto, Fast,
 * Thinking) are configured. A bookmarked link lands on working content instead
 * of a 404, and the redirect is temporary (`307`) rather than permanent so a
 * rollback deploy does not leave browsers caching the retirement forever.
 *
 * Historical research *results* are not here: they belong to the tenant that
 * ran them and stay readable in the assistant's read-only history panel
 * (`/dashboard?aiPanel=research`). Platform caps stay readable at
 * `GET /api/platform/ai/research` for audit; no route can change them any more.
 */
export default function PlatformAiResearchPage() {
  redirect("/platform/ai/modes");
}
