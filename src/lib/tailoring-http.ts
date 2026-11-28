/**
 * GH #1567 Phase 6A — shared HTTP boundary for the tailoring routes: the
 * permission gate (all listed keys), the industry gate and the error mapping.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import type { requirePermissions } from "./auth";
import { getBusinessIndustry } from "./industry-guard";
import { TailoringError, type TailoringActor } from "./tailoring-service";

type GuardResult = Awaited<ReturnType<typeof requirePermissions>>;

/**
 * Industry gate + actor, applied to the result of the route's own
 * `requirePermissions(...)` call (kept in each route so the guard scanner and a
 * reviewer see exactly which keys the route demands).
 */
export async function tailoringScope(guard: GuardResult):
  Promise<{ error: NextResponse; actor?: never; session?: never } | {
    error: null; actor: TailoringActor; session: NonNullable<GuardResult["session"]>;
  }> {
  if (guard.error || !guard.session) return { error: guard.error ?? NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  const session = guard.session;
  if (await getBusinessIndustry(session.businessId) !== "fashion_apparel") {
    return { error: NextResponse.json({ error: "industry_mismatch" }, { status: 403 }) };
  }
  return {
    error: null,
    session,
    actor: { businessId: session.businessId, userId: session.sub ?? null, name: session.fullName ?? session.role ?? "—" },
  };
}

export function tailoringFailure(error: unknown): NextResponse {
  if (error instanceof TailoringError) return NextResponse.json({ error: error.code }, { status: error.status });
  throw error;
}

export const uuidSchema = z.string().uuid();
