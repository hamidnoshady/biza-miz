import { isCrmSource, type CrmSource } from "./crm-sources";
import { isUuid } from "./uuid";
import { PERMISSIONS } from "./permissions";
export const TOUCH_CHANNELS = ["in_person", "phone", "online", "referral", "event", "other"] as const;
export type TouchChannel = (typeof TOUCH_CHANNELS)[number];
export const TOUCH_CHANNEL_LABELS: Record<TouchChannel, string> = { in_person: "حضوری", phone: "تلفنی", online: "آنلاین", referral: "معرفی", event: "رویداد", other: "دیگر" };
export type TouchInput = { assignmentId: string; leadId: string; channel: TouchChannel; source: CrmSource; idempotencyKey: string };
export function parseTouchInput(raw: unknown): TouchInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (!isUuid(b.assignmentId) || !isUuid(b.leadId) || !isUuid(b.idempotencyKey) || typeof b.channel !== "string" || !TOUCH_CHANNELS.includes(b.channel as TouchChannel) || !isCrmSource(b.source)) return null;
  return { assignmentId: b.assignmentId, leadId: b.leadId, idempotencyKey: b.idempotencyKey, channel: b.channel as TouchChannel, source: b.source };
}

/** CRM lead details are never exposed by attribution access alone. */
export function canRevealMarketingLead(permissions: ReadonlySet<string>): boolean {
  return permissions.has(PERMISSIONS.crmView) && permissions.has(PERMISSIONS.crmManage);
}
