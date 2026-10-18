import { PlatformStatusBadge } from "@/components/platform";
import {
  freshnessOf,
  SUPPORT_FRESHNESS_LABELS,
  type SupportFreshness,
} from "@/lib/support-companion/types";

const FRESHNESS_TONE: Record<SupportFreshness, "success" | "info" | "warning" | "muted"> = {
  live: "success",
  captured: "info",
  stale: "warning",
  unavailable: "muted",
};

/** Freshness chip: live vs captured vs stale vs unavailable, never colour alone. */
export function FreshnessBadge({ at }: { at: string | null }) {
  const freshness = freshnessOf(at);
  return (
    <PlatformStatusBadge
      tone={FRESHNESS_TONE[freshness]}
      label={SUPPORT_FRESHNESS_LABELS[freshness]}
      title={at ?? "بدون زمان مشاهده"}
    />
  );
}
