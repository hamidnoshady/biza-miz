/** GH #1567 6C — shared HTTP plumbing for the size-pack routes. */
import { NextResponse } from "next/server";
import { z } from "zod";
import type { requirePermissions } from "./auth";
import { SizePackError, type SizePackActor } from "./fashion-size-pack-service";
import { getBusinessIndustry } from "./industry-guard";
import { resolveActiveLocation } from "./setup-state";

type GuardResult = Awaited<ReturnType<typeof requirePermissions>>;

export async function sizePackScope(guard: GuardResult):
  Promise<{ error: NextResponse; actor?: never; locationId?: never } | { error: null; actor: SizePackActor; locationId: string }> {
  if (guard.error || !guard.session) return { error: guard.error ?? NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  const session = guard.session;
  if (await getBusinessIndustry(session.businessId) !== "fashion_apparel") {
    return { error: NextResponse.json({ error: "industry_mismatch" }, { status: 403 }) };
  }
  const location = await resolveActiveLocation(session);
  if (!location) return { error: NextResponse.json({ error: "location_required" }, { status: 409 }) };
  return { error: null, locationId: location.id, actor: { businessId: session.businessId, userId: session.sub ?? null } };
}

export function sizePackFailure(error: unknown): NextResponse {
  if (error instanceof SizePackError) {
    return NextResponse.json({ error: error.code, ...(error.detail ? { detail: error.detail } : {}) }, { status: error.status });
  }
  throw error;
}

export const uuid = z.string().uuid();

export const packBody = z.object({
  name: z.string().trim().min(1).max(200),
  barcode: z.string().trim().max(64).nullable().optional(),
  components: z.array(z.object({
    itemId: uuid,
    quantity: z.number().int().min(1).max(10_000),
    unitPriceRial: z.number().int().min(0).max(1e13),
  }).strict()).min(1).max(60),
}).strict();
