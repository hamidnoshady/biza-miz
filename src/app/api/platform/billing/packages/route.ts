import { NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, platformAudit, withPlatformScope } from "@/lib/platform-auth";
import { listCreditPackages, saveCreditPackage } from "@/lib/wallet-service";
import {
  listMessageCreditPackages,
  saveMessageCreditPackage,
} from "@/lib/messaging-billing";
import { parseSafeIntInput } from "@/lib/platform-money";

/**
 * The ONE credit-package catalogue (migration 0176): wallet top-up packages
 * and messaging credit packages are both commercial products, so both are
 * managed from `/platform/billing?tab=usage` — the app consoles
 * (/platform/messaging) only display them read-only.
 *
 *   GET  /api/platform/billing/packages?kind=wallet|messaging (default: both)
 *   POST /api/platform/billing/packages  { kind, id?, name, priceRial,
 *                                          creditRial, isActive, sortOrder }
 */
export const GET = withPlatformScope(async (req: Request) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  const [wallet, messaging] = await Promise.all([
    kind && kind !== "wallet" ? Promise.resolve([]) : listCreditPackages(false),
    kind && kind !== "messaging" ? Promise.resolve([]) : listMessageCreditPackages(false),
  ]);
  return NextResponse.json({ packages: wallet, messagePackages: messaging });
});

/** Create or update a credit package (wallet top-up or messaging credit). */
export const POST = withPlatformScope(async (req: Request) => {
  const guard = await requirePlatformCapability("billing.manage");
  if (guard.error) return guard.error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const kind = body.kind === "messaging" ? "messaging" : "wallet";
  const name = String(body.name ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const priceRial = parseSafeIntInput(body.priceRial, { min: 1 });
  const creditRial = parseSafeIntInput(body.creditRial, { min: 1 });
  if (priceRial === null || creditRial === null) {
    return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
  }

  const id = typeof body.id === "string" && body.id ? body.id : undefined;
  const isActive = body.isActive !== false;
  const sortOrder = Math.floor(Number(body.sortOrder ?? 0)) || 0;

  if (kind === "messaging") {
    const before = id ? (await listMessageCreditPackages(false)).find((p) => p.id === id) ?? null : null;
    const pkg = await saveMessageCreditPackage({
      id,
      name,
      priceRial,
      creditAmountRial: creditRial,
      isActive,
      sortOrder,
    });
    await platformAudit({
      adminId: guard.session.padmin,
      action: "credit_package.changed",
      entity: "message_credit_packages",
      entityId: pkg.id,
      payload: {
        kind,
        before: before ? { name: before.name, priceRial: before.priceRial, creditRial: before.creditAmountRial, isActive: before.isActive } : null,
        after: { name, priceRial, creditRial, isActive },
      },
    });
    return NextResponse.json({ package: pkg, kind });
  }

  const before = id ? (await listCreditPackages(false)).find((p) => p.id === id) ?? null : null;
  const pkg = await saveCreditPackage({
    id,
    name,
    priceRial,
    creditRial,
    isActive,
    sortOrder,
  });
  await platformAudit({
    adminId: guard.session.padmin,
    action: "credit_package.changed",
    entity: "credit_packages",
    entityId: pkg.id,
    payload: {
      kind,
      before: before ? { name: before.name, priceRial: before.priceRial, creditRial: before.creditRial, isActive: before.isActive } : null,
      after: { name, priceRial, creditRial, isActive },
    },
  });
  return NextResponse.json({ package: pkg, kind });
});
