"use client";

/**
 * Feature flags and per-business app states — everything "what is this tenant
 * entitled to?".
 *
 * Desktop pairing used to live here too, which made a credential's lifetime
 * read as another capability switch; it is its own section now
 * («دستگاه‌ها و نصب‌ها», issue #755 §15).
 */
import { FeaturesPanel } from "../panels";
import { BusinessAppAvailabilityPanel } from "../app-availability-panel";

export default function BusinessFeaturesPage() {
  return (
    <div className="space-y-4">
      <FeaturesPanel />
      {/* The second, orthogonal switch: a flag says whether this business is
          entitled to a capability, this says whether the app is released and
          working for them — «به‌زودی»، «در حال تعمیر»، «نسخهٔ آزمایشی». */}
      <BusinessAppAvailabilityPanel />
    </div>
  );
}
