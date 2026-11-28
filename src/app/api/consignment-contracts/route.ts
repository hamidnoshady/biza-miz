import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createConsignorRecord, createContract, listConsignors, listContracts } from "@/lib/fashion-consignment-service";
import { consignmentFailure, consignmentScope, consignorBody, contractBody } from "@/lib/fashion-consignment-http";

/**
 * GH #1567 6D — the branch's consignment (امانی) contracts with on-hand and the
 * owner payable. `?view=consignors` addresses the goods owners
 * (تأمین‌کنندگان امانی) the shop holds stock for: `GET` lists them, `POST`
 * creates one. A view here rather than its own route, because each route adds
 * ~0.15 MiB to the desktop runtime.
 */
function parseView(request: Request): "contracts" | "consignors" | null {
  const view = new URL(request.url).searchParams.get("view");
  if (view === null) return "contracts";
  return view === "consignors" ? "consignors" : null;
}

export const GET = withTenantScope(async (request: Request) => {
  const view = parseView(request);
  if (!view) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const scope = await consignmentScope(await requirePermissions(PERMISSIONS.inventoryView));
  if (scope.error) return scope.error;
  try {
    if (view === "consignors") return NextResponse.json({ consignors: await listConsignors(scope.actor) });
    return NextResponse.json({ contracts: await listContracts(scope.actor, scope.locationId) });
  } catch (error) {
    return consignmentFailure(error);
  }
});

export const POST = withTenantScope(async (request: Request) => {
  const view = parseView(request);
  if (!view) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const scope = await consignmentScope(await requirePermissions(PERMISSIONS.inventoryAdjust));
  if (scope.error) return scope.error;
  const raw = await request.json().catch(() => null);
  try {
    if (view === "consignors") {
      const body = consignorBody.safeParse(raw);
      if (!body.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
      return NextResponse.json({ consignor: await createConsignorRecord(scope.actor, scope.locationId, body.data) }, { status: 201 });
    }
    const body = contractBody.safeParse(raw);
    if (!body.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    return NextResponse.json({ contract: await createContract(scope.actor, scope.locationId, body.data) }, { status: 201 });
  } catch (error) {
    return consignmentFailure(error);
  }
});
