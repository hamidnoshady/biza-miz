import { NextRequest, NextResponse } from "next/server";
import { getSetting, markStepDone, setSetting, SETTING_KEYS } from "@/lib/settings";
import {
  costingLocked,
  requireManager,
  requireSetupStepForIndustry,
  type CostingSetting,
} from "@/lib/setup-state";
import { withTenantScope } from "@/lib/auth";

/** F&B only — inventory system (دائمی/ادواری) + costing method (FIFO/LIFO/میانگین). See wizard-steps.ts. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireManager();
  if (error) return error;
  const stepError = await requireSetupStepForIndustry(session.businessId, "costing");
  if (stepError) return stepError;

  const costing = await getSetting<CostingSetting>(session.businessId, SETTING_KEYS.costing);
  const locked = await costingLocked(session.businessId);
  return NextResponse.json({ costing, locked });
});

/**
 * Saves the method. Once the first inventory transaction exists the choice is
 * locked — changing it then requires a formal revaluation process (later phase),
 * not this endpoint.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;
  const stepError = await requireSetupStepForIndustry(session.businessId, "costing");
  if (stepError) return stepError;

  let body: { method?: string; system?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.method !== "fifo" && body.method !== "lifo" && body.method !== "weighted_average") {
    return NextResponse.json({ error: "invalid_method" }, { status: 400 });
  }
  // Omitted system means perpetual — the only behaviour before ادواری existed,
  // and what every pre-existing caller (e.g. the AI setup executor) sends.
  const system = body.system ?? "perpetual";
  if (system !== "perpetual" && system !== "periodic") {
    return NextResponse.json({ error: "invalid_system" }, { status: 400 });
  }

  if (await costingLocked(session.businessId)) {
    return NextResponse.json({ error: "costing_locked" }, { status: 409 });
  }

  const setting: CostingSetting = { method: body.method, system, lockedAt: null };
  await setSetting(session.businessId, SETTING_KEYS.costing, setting);
  const progress = await markStepDone(session.businessId, "costing");
  return NextResponse.json({ ok: true, progress });
});
