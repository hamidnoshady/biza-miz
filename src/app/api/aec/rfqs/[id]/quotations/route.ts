import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { recordQuotation, rfqProjectId } from "@/lib/aec-procurement-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * A supplier's answer to an RFQ (§18) — the "supplier quotation" the flow needs
 * before anything can be compared.
 *
 * One offer per supplier per tender: a supplier that revises its price does so in
 * a new round, so the comparison sheet always shows one honest figure per
 * supplier, and the service says `quotation_exists` rather than letting the
 * database's unique index be the first thing the caller hears about it.
 *
 * Recording what a supplier quoted is ordinary register work
 * (`workspace.manage`); *choosing* the winner is the award, and the award is
 * approved on `workspace.approve`.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await rfqProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      const quotation = await recordQuotation(owner, id, await readBody(request));
      return NextResponse.json({ quotation }, { status: 201 });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
