/** GH #1567 6D — shared HTTP plumbing for the fashion consignment routes. */
import { NextResponse } from "next/server";
import { z } from "zod";
import type { requirePermissions } from "./auth";
import { ConsignmentError, type ConsignmentActor } from "./fashion-consignment-service";
import { getBusinessIndustry } from "./industry-guard";
import { resolveActiveLocation } from "./setup-state";

type GuardResult = Awaited<ReturnType<typeof requirePermissions>>;

export async function consignmentScope(guard: GuardResult):
  Promise<{ error: NextResponse; actor?: never; locationId?: never } | { error: null; actor: ConsignmentActor; locationId: string }> {
  if (guard.error || !guard.session) return { error: guard.error ?? NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  const session = guard.session;
  if (await getBusinessIndustry(session.businessId) !== "fashion_apparel") {
    return { error: NextResponse.json({ error: "industry_mismatch" }, { status: 403 }) };
  }
  const location = await resolveActiveLocation(session);
  if (!location) return { error: NextResponse.json({ error: "location_required" }, { status: 409 }) };
  return { error: null, locationId: location.id, actor: { businessId: session.businessId, userId: session.sub ?? null } };
}

export function consignmentFailure(error: unknown): NextResponse {
  if (error instanceof ConsignmentError) {
    return NextResponse.json(
      { error: error.code, message: error.message, ...(error.detail ? { detail: error.detail } : {}) },
      { status: error.status },
    );
  }
  throw error;
}

export const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const note = z.string().trim().max(500).nullable().optional().transform((v) => v || null);
const key = z.string().trim().min(8).max(128);

export const consignorBody = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(40).nullable().optional().transform((v) => v || null),
  notes: note,
}).strict();

export const contractBody = z.object({
  reference: z.string().trim().min(1).max(60),
  consignorId: uuid,
  startsOn: isoDate,
  expiresOn: isoDate.nullable(),
  notes: note,
  lines: z.array(z.object({
    itemId: uuid,
    terms: z.enum(["owner_price", "commission"]),
    ownerUnitPriceRial: z.number().int().min(0).max(1e13).nullable(),
    commissionBp: z.number().int().min(0).max(10_000).nullable(),
    retailPriceRial: z.number().int().min(0).max(1e13).nullable(),
  }).strict()).min(1).max(200),
}).strict();

const quantities = z.array(z.object({ lineId: uuid, quantity: z.number().int().min(1).max(100_000) }).strict()).min(1).max(200);

/** One POST per contract action, so the whole workflow is three route files. */
export const contractActionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("receive"), idempotencyKey: key, expectedVersion: z.number().int().min(1), note, lines: quantities }).strict(),
  z.object({ action: z.literal("return_to_owner"), idempotencyKey: key, expectedVersion: z.number().int().min(1), note, lines: quantities }).strict(),
  z.object({
    action: z.literal("settle"),
    idempotencyKey: key,
    amountRial: z.number().int().min(1).max(1e13),
    method: z.enum(["cash", "bank"]),
    note,
  }).strict(),
  z.object({ action: z.literal("close"), expectedVersion: z.number().int().min(1) }).strict(),
]);
