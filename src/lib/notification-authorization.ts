import { isUuid } from "./uuid";
import { loadAecProjectCockpit } from "./aec-service";
import type { AecCapabilityKey } from "./aec";
import { hasModule } from "./industry-profile";
/** Preferences are never grants. Every disclosure, including recovered work
 * and inbox reads, is checked against the current canonical membership. */
import { loadMembership } from "./authorize";
import type { SessionPayload } from "./auth-edge";
import { query } from "./db";
import { NOTIFICATION_EVENTS, isNotificationEventKey } from "./notifications";
import type { Permission } from "./permissions";
import { effectiveAppAvailability } from "./app-availability-service";
import { getBusinessIndustry } from "./industry-guard";

export const NOTIFICATION_PERMISSIONS: Record<string, Permission[]> = {
  "shift.opened": ["reports.view"],
  "shift.closed": ["reports.view", "ledger.view"],
  "shift.cash_variance": ["reports.view", "ledger.view"],
  "business_day.closed": ["reports.view", "ledger.view"],
  "order.voided": ["orders.view"],
  "payment.refunded": ["payments.refund", "ledger.view"],
  "inventory.low_stock": ["inventory.view"],
  "backup.failed": ["backup.manage"],
  "sync.operational_blocked": ["settings.manage"],
  "ai.coworker.pending": ["ai.manage"],
  "ai.coworker.reported": ["ai.manage"],
  "ai.coworker.failed": ["ai.manage"],
  "ai.automation.pending": ["ai.automations.manage"],
  "ai.automation.failed": ["ai.automations.manage"],
};

export async function canReceiveNotification(
  businessId: string,
  userId: string,
  event: {
    event_key: string;
    location_id?: string | null;
    payload?: Record<string, unknown>;
  },
  catalogueOnly = false,
): Promise<boolean> {
  if (!isNotificationEventKey(event.event_key) || event.event_key === "system.test") return false;
  const member = await loadMembership({
    sub: userId,
    businessId,
    fullName: "",
    locationId: null,
  } as SessionPayload);
  if (!member?.isActive || member.businessStatus !== "active") return false;
  const aec = event.event_key.startsWith("aec.");
  const financial = /payment|guarantee|insurance/.test(event.event_key);
  const required: Permission[] = aec
    ? ["workspace.view", ...(financial ? ["ledger.view" as const] : [])]
    : (NOTIFICATION_PERMISSIONS[event.event_key] ?? []);
  if (!required.length || required.some((key) => !member.permissions.has(key))) return false;
  const group = NOTIFICATION_EVENTS[event.event_key].group;
  // AI summaries may embed arbitrary tool/source facts. Until producers carry
  // a typed source ACL, only the business owner may receive their rendered text.
  if (group === "ai" && member.role !== "owner") return false;
  let projectId = event.payload?.projectId;
  if (!catalogueOnly && group === "ai") {
    const coworker = event.event_key.startsWith("ai.coworker.");
    const sourceId = coworker ? event.payload?.jobId : event.payload?.automationId;
    if (!isUuid(sourceId)) return false;
    const { rows } = await query<{ project_id: string | null }>(
      coworker
        ? `SELECT project_id FROM ai_coworker_jobs WHERE business_id=$1 AND id=$2`
        : `SELECT project_id FROM ai_automations WHERE business_id=$1 AND id=$2`,
      [businessId, sourceId],
    );
    if (!rows[0]) return false;
    projectId = rows[0].project_id;
  }
  if (!catalogueOnly && (aec || projectId)) {
    if (!isUuid(projectId)) return false;
    // Conservative membership requirement also applies to business owners.
    const { rows } = await query(
      `SELECT 1 FROM workspace_members m JOIN ai_projects p ON p.id=m.project_id
      WHERE p.business_id=$1 AND p.id=$2 AND m.user_id=$3`,
      [businessId, projectId, userId],
    );
    if (!rows.length) return false;
  }
  if (aec) {
    if ((await getBusinessIndustry(businessId)) !== "architecture_construction") return false;
    const requiredCapability: Record<string, AecCapabilityKey> = {
      "aec.rfi_overdue": "document_control",
      "aec.submittal_overdue": "approvals",
      "aec.inspection_due": "qa_qc",
      "aec.snag_overdue": "snagging",
      "aec.payment_certificate_pending": "progress_claims",
      "aec.client_payment_overdue": "progress_claims",
      "aec.guarantee_expiring": "financials",
      "aec.insurance_expiring": "financials",
      "aec.procurement_delivery_delay": "procurement",
    };
    const cockpit = await loadAecProjectCockpit(businessId);
    if (!cockpit.capabilities.includes(requiredCapability[event.event_key])) return false;
  } else if (["money", "operations", "inventory"].includes(group)) {
    if (!(await effectiveAppAvailability(businessId)).accounting.usable) return false;
    const industry = await getBusinessIndustry(businessId);
    if (group === "inventory" && (!industry || !hasModule(industry, "inventory"))) return false;
  }
  if (event.location_id) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM locations WHERE business_id = $1 AND id = $2 AND is_active`,
      [businessId, event.location_id],
    );
    if (!rows.length) return false;
    if (member.role !== "owner" && member.locationScope === "none") return false;
    if (
      member.role !== "owner" &&
      member.locationScope === "home" &&
      member.homeLocationId !== event.location_id
    )
      return false;
    if (
      member.role !== "owner" &&
      member.locationScope === "selected" &&
      !(await member.assignedLocationIds()).includes(event.location_id)
    )
      return false;
  } else if (!aec && group === "money" && !member.permissions.has("reports.business_wide"))
    return false;
  return true;
}

/** Job/request-local only. Never cache a grant across a retry, tick or inbox
 * request. Equivalent facts in a digest share an ACL, not individual DB reads. */
export function notificationAuthorizationCache() {
  const decisions = new Map<string, Promise<boolean>>();
  return (
    businessId: string,
    userId: string,
    event: Parameters<typeof canReceiveNotification>[2],
  ) => {
    const key = JSON.stringify([
      businessId,
      userId,
      event.event_key,
      event.location_id,
      event.payload?.projectId,
      event.payload?.jobId,
      event.payload?.automationId,
    ]);
    let decision = decisions.get(key);
    if (!decision) {
      decision = canReceiveNotification(businessId, userId, event);
      decisions.set(key, decision);
    }
    return decision;
  };
}
