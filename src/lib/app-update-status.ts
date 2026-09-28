/** Pure Desktop SemVer decision logic kept separate from runtime I/O. */
import { classifyDesktopVersion, type DeviceComplianceStatus } from "./desktop-release";

export function computeUpdateStatus(
  currentVersion: string,
  targetVersion: string | null,
  minimumSupportedVersion?: string | null,
): DeviceComplianceStatus {
  return classifyDesktopVersion(currentVersion, targetVersion, minimumSupportedVersion);
}

/** Back-compatible helper for callers that only need the one CTA decision. */
export function computeUpdateAvailable(currentVersion: string, targetVersion: string): boolean {
  return computeUpdateStatus(currentVersion, targetVersion) === "update_available";
}
