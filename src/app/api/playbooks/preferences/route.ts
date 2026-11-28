import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { readPreferences, upsertPreferences } from "@/lib/adaptive-context-service";
import { BUSINESS_SIZES, BUSINESS_GOALS, VIEW_DENSITIES, TOOLS_VIEWS, type UserPreferences } from "@/lib/adaptive-context";

/** Per-member presentation preferences (Simple/Advanced, My Tools, pins, favorites, size/goal overrides). */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireMember();
  if (error) return error;
  const prefs = await readPreferences(session.businessId, session.sub);
  return NextResponse.json({ preferences: prefs });
});

/** Update preferences. NEVER widens authorization; validated; tenant-scoped. */
export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireMember();
  if (error) return error;
  const body = (await request.json().catch(() => ({}))) as Partial<UserPreferences>;

  const patch: Partial<UserPreferences> = {};
  if (body.density === null || (VIEW_DENSITIES as readonly string[]).includes(body.density ?? "")) patch.density = body.density ?? null;
  if (body.toolsView && (TOOLS_VIEWS as readonly string[]).includes(body.toolsView)) patch.toolsView = body.toolsView;
  if (Array.isArray(body.pinnedTools)) patch.pinnedTools = body.pinnedTools.filter((x): x is string => typeof x === "string").slice(0, 50);
  if (Array.isArray(body.favoritePlaybooks)) patch.favoritePlaybooks = body.favoritePlaybooks.filter((x): x is string => typeof x === "string").slice(0, 200);
  if (body.sizeOverride === null || (BUSINESS_SIZES as readonly string[]).includes(body.sizeOverride ?? "")) patch.sizeOverride = body.sizeOverride ?? null;
  if (body.goalsOverride === null) patch.goalsOverride = null;
  else if (Array.isArray(body.goalsOverride)) patch.goalsOverride = body.goalsOverride.filter((g) => (BUSINESS_GOALS as readonly string[]).includes(g));

  await upsertPreferences(session.businessId, session.sub, patch);
  const prefs = await readPreferences(session.businessId, session.sub);
  return NextResponse.json({ preferences: prefs });
});
