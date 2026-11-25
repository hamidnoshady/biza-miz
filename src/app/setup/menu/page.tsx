/**
 * Backward-compatible link for old bookmarks and saved onboarding URLs.
 * #1580 consolidates menu entry into the single /setup/import wizard step;
 * existing API routes remain responsible for legacy domain writes.
 */
import { redirect } from "next/navigation";

export default function LegacyMenuStep() {
  redirect("/setup/import?source=manual&section=menu");
}
