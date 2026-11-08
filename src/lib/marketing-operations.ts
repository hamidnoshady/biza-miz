import { isUuid } from "./uuid";

export const ASSIGNMENT_STATUSES = ["planned", "in_progress", "completed", "canceled"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export type TargetInput = { locationId: string; partyId: string | null; siteLabel: string; city: string; neighborhood: string };
export type AssignmentInput = { locationId: string; targetId: string; agentId: string; title: string; dueDate: string | null };
function record(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}
function text(raw: unknown, max: number, required = false): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.length <= max && (!required || value.length > 0) ? value : null;
}
function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value && value >= "1900-01-01" && value <= "9999-12-31";
}
export function parseTargetInput(raw: unknown): TargetInput | null {
  const b = record(raw); if (!b || !isUuid(b.locationId)) return null;
  const siteLabel = text(b.siteLabel, 150, true), city = text(b.city ?? "", 100), neighborhood = text(b.neighborhood ?? "", 100);
  if (siteLabel === null || city === null || neighborhood === null || (b.partyId != null && b.partyId !== "" && !isUuid(b.partyId))) return null;
  return { locationId: b.locationId, partyId: b.partyId ? b.partyId as string : null, siteLabel, city, neighborhood };
}
export function parseAssignmentInput(raw: unknown): AssignmentInput | null {
  const b = record(raw); if (!b || !isUuid(b.locationId) || !isUuid(b.agentId) || !isUuid(b.targetId)) return null;
  const title = text(b.title, 150, true);
  if (title === null || (b.dueDate != null && b.dueDate !== "" && !validDate(b.dueDate))) return null;
  return { locationId: b.locationId, agentId: b.agentId, targetId: b.targetId, title, dueDate: b.dueDate ? b.dueDate as string : null };
}
export function parseTransition(raw: unknown): { expected: AssignmentStatus; next: AssignmentStatus } | null {
  const b = record(raw); if (!b || typeof b.expected !== "string" || typeof b.next !== "string") return null;
  const allowed: Record<string, readonly string[]> = { planned: ["in_progress", "completed", "canceled"], in_progress: ["completed", "canceled"] };
  if (!allowed[b.expected]?.includes(b.next)) return null;
  return { expected: b.expected as AssignmentStatus, next: b.next as AssignmentStatus };
}

export type TargetStatus = "active" | "archived";
export type TargetChange =
  | { action: "edit"; expectedRevision: number; siteLabel: string; city: string; neighborhood: string }
  | { action: "archive" | "restore"; expectedRevision: number };
export function parseTargetChange(raw: unknown): TargetChange | null {
  const b = record(raw);
  if (!b || typeof b.expectedRevision !== "number" || !Number.isSafeInteger(b.expectedRevision) || b.expectedRevision < 0 || b.expectedRevision > 2147483646) return null;
  if (b.action === "archive" || b.action === "restore") return { action: b.action, expectedRevision: b.expectedRevision };
  if (b.action !== "edit") return null;
  const siteLabel = text(b.siteLabel, 150, true), city = text(b.city, 100), neighborhood = text(b.neighborhood, 100);
  if (siteLabel === null || city === null || neighborhood === null) return null;
  return { action: "edit", expectedRevision: b.expectedRevision, siteLabel, city, neighborhood };
}
