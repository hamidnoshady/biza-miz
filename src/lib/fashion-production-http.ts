/**
 * GH #1567 Phase 6B — shared HTTP boundary for the fashion production routes:
 * the industry gate, the active branch, the actor (with whether it may write
 * residual WIP off) and the error mapping. Each route keeps its own literal
 * `requirePermissions(...)` call so the guard scanner sees the exact keys.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import type { requirePermissions } from "./auth";
import { FashionProductionError, type ProductionActor } from "./fashion-production-service";
import { getBusinessIndustry } from "./industry-guard";
import { PERMISSIONS } from "./permissions";
import { resolveActiveLocation } from "./setup-state";

type GuardResult = Awaited<ReturnType<typeof requirePermissions>>;

export async function productionScope(guard: GuardResult):
  Promise<{ error: NextResponse; actor?: never; locationId?: never } | { error: null; actor: ProductionActor; locationId: string }> {
  if (guard.error || !guard.session) return { error: guard.error ?? NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  const session = guard.session;
  if (await getBusinessIndustry(session.businessId) !== "fashion_apparel") {
    return { error: NextResponse.json({ error: "industry_mismatch" }, { status: 403 }) };
  }
  const location = await resolveActiveLocation(session);
  if (!location) return { error: NextResponse.json({ error: "location_required" }, { status: 409 }) };
  const permissions = (guard.membership as { permissions?: Set<string> } | undefined)?.permissions;
  return {
    error: null,
    locationId: location.id,
    actor: {
      businessId: session.businessId,
      userId: session.sub ?? null,
      canWriteOff: Boolean(permissions?.has(PERMISSIONS.ledgerApprove)),
    },
  };
}

export function productionFailure(error: unknown): NextResponse {
  if (error instanceof FashionProductionError) {
    return NextResponse.json({ error: error.code, ...(error.detail ? { detail: error.detail } : {}) }, { status: error.status });
  }
  throw error;
}

export const uuid = z.string().uuid();
export const quantity = z.union([z.string().trim().regex(/^\d+(\.\d{1,9})?$/), z.number().positive()]).transform(String);
export const idempotencyKey = z.string().trim().min(8).max(200);
export const stageCode = z.string().trim().regex(/^[a-z][a-z0-9_]{0,29}$/);

export const bomBody = z.object({
  name: z.string().trim().min(1).max(200),
  outputItemId: uuid,
  conversionCostPerUnitRial: z.number().int().min(0).max(1e13).default(0),
  lines: z.array(z.object({ materialItemId: uuid, quantityPerUnit: quantity }).strict()).min(1).max(60),
}).strict();
