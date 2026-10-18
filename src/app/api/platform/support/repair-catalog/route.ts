import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  getRecipe,
  listActiveCatalog,
  publishRecipe,
  setRecipeActive,
} from "@/lib/support-companion/repair-catalog";
import { clientIpFrom } from "@/lib/rate-limit";

/** The active repair catalog (the propose picker reads this). */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("support.repair.propose");
  if (error) return error;
  const catalog = await listActiveCatalog();
  return NextResponse.json({ catalog });
});

/** Publish a new catalog version, or flip a version's `active` flag.
 * Owner-only + MFA: publishing is the reviewed, signed release step. */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("support.repair.publish");
  if (error) return error;
  if (!session.mfaVerified) return NextResponse.json({ error: "mfa_required" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const auditBase = {
    adminId: session.padmin,
    entity: "support_repair_catalog",
    ipAddress: clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  };

  if (body.action === "set_active") {
    const recipeId = typeof body.recipeId === "string" ? body.recipeId : "";
    const version = typeof body.version === "number" ? body.version : NaN;
    const active = body.active === true;
    if (!recipeId || !Number.isInteger(version)) {
      return NextResponse.json({ error: "recipe_and_version_required" }, { status: 400 });
    }
    const updated = await setRecipeActive(recipeId, version, active);
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const recipe = await getRecipe(recipeId, version);
    await platformAudit({
      ...auditBase,
      action: active ? "support.repair_catalog.activated" : "support.repair_catalog.deactivated",
      entityId: `${recipeId}@${version}`,
      payload: { recipeId, version },
    });
    return NextResponse.json({ recipe });
  }

  const published = await publishRecipe({
    recipeId: typeof body.recipeId === "string" ? body.recipeId : "",
    title: typeof body.title === "string" ? body.title : "",
    description: typeof body.description === "string" ? body.description : "",
    risk: typeof body.risk === "string" ? body.risk : "",
    compatibility:
      body.compatibility && typeof body.compatibility === "object"
        ? (body.compatibility as Record<string, unknown>)
        : {},
    preconditions: Array.isArray(body.preconditions) ? body.preconditions : [],
    effects: Array.isArray(body.effects) ? body.effects : [],
    postchecks: Array.isArray(body.postchecks) ? body.postchecks : [],
    backupPolicy: typeof body.backupPolicy === "string" ? body.backupPolicy : undefined,
    recipe:
      body.recipe && typeof body.recipe === "object"
        ? (body.recipe as Record<string, unknown>)
        : {},
    publisherAdminId: session.padmin,
    active: body.active === true,
  });
  if (!published.ok) {
    return NextResponse.json({ error: published.error }, { status: 400 });
  }
  await platformAudit({
    ...auditBase,
    action: "support.repair_catalog.published",
    entityId: `${published.recipe.recipeId}@${published.recipe.version}`,
    payload: { recipeId: published.recipe.recipeId, version: published.recipe.version },
  });
  return NextResponse.json({ recipe: published.recipe }, { status: 201 });
});
