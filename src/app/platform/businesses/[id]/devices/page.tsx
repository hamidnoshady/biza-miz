"use client";

/**
 * Devices & installations for one business (issue #755 §15).
 *
 * Separated from «برنامه‌ها و قابلیت‌ها» on purpose: pairing is operational
 * device/install management — a paired laptop, a branch, a credential's
 * lifetime — not an entitlement. The two panels here are the two halves of that
 * story: the installs that exist, and the one-time codes that create them.
 */
import { InfoBox } from "../../../ui";
import { InstallationsPanel } from "../installations-panel";
import { PairingPanel } from "../pairing-panel";

export default function BusinessDevicesPage() {
  return (
    <div className="space-y-4">
      <InfoBox>
        کد اتصال فقط یک بار نمایش داده می‌شود و به همان شعبه گره می‌خورد؛ ساختن کد تازه، کد فعال
        همان شعبه را باطل می‌کند.
      </InfoBox>
      <InstallationsPanel />
      <PairingPanel />
    </div>
  );
}
