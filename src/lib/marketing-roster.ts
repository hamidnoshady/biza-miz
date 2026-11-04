import { isUuid } from "./uuid";

export const MARKETER_KINDS = ["employee", "contractor", "affiliate", "agency"] as const;
export type MarketerKind = (typeof MARKETER_KINDS)[number];
export type RosterInput = { locationId: string; kind: MarketerKind; userId: string | null; name: string | null };

export function parseRosterInput(raw: unknown): RosterInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.locationId !== "string" || !isUuid(body.locationId)) return null;
  if (typeof body.kind !== "string" || !MARKETER_KINDS.includes(body.kind as MarketerKind)) return null;
  if (body.kind === "employee") {
    if (typeof body.userId !== "string" || !isUuid(body.userId) || (body.name != null && body.name !== "")) return null;
    return { locationId: body.locationId, kind: "employee", userId: body.userId, name: null };
  }
  if (body.userId != null && body.userId !== "") return null;
  if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 150) return null;
  return { locationId: body.locationId, kind: body.kind as MarketerKind, userId: null, name: body.name.trim() };
}
