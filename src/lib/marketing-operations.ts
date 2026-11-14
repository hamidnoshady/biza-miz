import { isUuid } from "./uuid";

export const ASSIGNMENT_STATUSES = ["planned", "in_progress", "completed", "canceled"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export const ASSIGNMENT_STATUS_LABELS: Record<AssignmentStatus, string> = { planned: "برنامه‌ریزی‌شده", in_progress: "در حال انجام", completed: "تکمیل‌شده", canceled: "لغوشده" };
export type AssignmentPlanFilter = { status: AssignmentStatus | null; dueFrom: string | null; dueTo: string | null; sort: "newest" | "due_asc" };
export const DEFAULT_ASSIGNMENT_PLAN: AssignmentPlanFilter = { status: null, dueFrom: null, dueTo: null, sort: "newest" };
export const ASSIGNMENT_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type AssignmentPriority = (typeof ASSIGNMENT_PRIORITIES)[number];
export function isAssignmentPriority(value: unknown): value is AssignmentPriority { return typeof value === "string" && ASSIGNMENT_PRIORITIES.includes(value as AssignmentPriority); }
export const ASSIGNMENT_PRIORITY_LABELS: Record<AssignmentPriority, string> = { low: "کم", normal: "عادی", high: "زیاد", urgent: "فوری" };
export type TargetInput = { locationId: string; partyId: string | null; siteLabel: string; city: string; neighborhood: string; reviewToken?: string };
export type AssignmentInput = { locationId: string; targetId: string; agentId: string; title: string; dueDate: string | null; priority?: AssignmentPriority };
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
/** Deadline filters are inclusive civil dates, not visit times. */
export function parseAssignmentPlanFilter(params: URLSearchParams): AssignmentPlanFilter | null {
  for (const key of ["status", "dueFrom", "dueTo", "sort"]) if (params.getAll(key).length > 1) return null;
  const status = params.get("status"), dueFrom = params.get("dueFrom"), dueTo = params.get("dueTo"), sort = params.get("sort") ?? "newest";
  if ((status !== null && !ASSIGNMENT_STATUSES.includes(status as AssignmentStatus)) || (dueFrom !== null && !validDate(dueFrom)) || (dueTo !== null && !validDate(dueTo)) || (dueFrom !== null && dueTo !== null && dueFrom > dueTo) || (sort !== "newest" && sort !== "due_asc")) return null;
  return { status: status as AssignmentStatus | null, dueFrom, dueTo, sort };
}
export function assignmentPlanQuery(plan: AssignmentPlanFilter): string {
  const p = new URLSearchParams();
  if (plan.status) p.set("status", plan.status);
  if (plan.dueFrom) p.set("dueFrom", plan.dueFrom);
  if (plan.dueTo) p.set("dueTo", plan.dueTo);
  if (plan.sort !== "newest") p.set("sort", plan.sort);
  const query = p.toString();
  return query ? `&${query}` : "";
}
export function parseTargetInput(raw: unknown): TargetInput | null {
  const b = record(raw); if (!b || !isUuid(b.locationId)) return null;
  const siteLabel = text(b.siteLabel, 150, true), city = text(b.city ?? "", 100), neighborhood = text(b.neighborhood ?? "", 100);
  if (siteLabel === null || city === null || neighborhood === null || (b.partyId != null && b.partyId !== "" && !isUuid(b.partyId)) || (b.reviewToken !== undefined && (typeof b.reviewToken !== "string" || !/^[a-f0-9]{64}$/.test(b.reviewToken)))) return null;
  return { locationId: b.locationId, partyId: b.partyId ? b.partyId as string : null, siteLabel, city, neighborhood, ...(typeof b.reviewToken === "string" ? { reviewToken: b.reviewToken } : {}) };
}
export function parseAssignmentInput(raw: unknown): AssignmentInput | null {
  const b = record(raw); if (!b || !isUuid(b.locationId) || !isUuid(b.agentId) || !isUuid(b.targetId)) return null;
  const title = text(b.title, 150, true);
  const priority = b.priority === undefined ? "normal" : b.priority;
  if (title === null || (b.dueDate != null && b.dueDate !== "" && !validDate(b.dueDate)) || !isAssignmentPriority(priority)) return null;
  return { locationId: b.locationId, agentId: b.agentId, targetId: b.targetId, title, dueDate: b.dueDate ? b.dueDate as string : null, priority };
}
export type PriorityChange = { action: "priority"; expectedRevision: number; priority: AssignmentPriority };
export function parsePriorityChange(raw: unknown): PriorityChange | null {
  const b = record(raw);
  if (!b || b.action !== "priority" || typeof b.expectedRevision !== "number" || !Number.isSafeInteger(b.expectedRevision) || b.expectedRevision < 0 || b.expectedRevision > 2147483646 || !isAssignmentPriority(b.priority)) return null;
  return { action: "priority", expectedRevision: b.expectedRevision, priority: b.priority };
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
