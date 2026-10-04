import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createCommitment, listProjectCommitments } from "@/lib/aec-procurement-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * A project's commitment register (issue #799 §18): the purchase orders and
 * subcontracts that put money on the table.
 *
 * GET  — every award on the project, newest first, with its kind, its supplier,
 *        its value, when it is expected, where it stands, the request/RFQ/
 *        quotation/contract it came from and whether it is late (§22's delay
 *        warning, computed against the Shamsi business day).
 * POST — raise one. It is numbered `PO-001` for a purchase or `SC-001` for a
 *        subcontract per project; a subcontract additionally needs the
 *        `subcontractors` capability, which is why §18 names the two switched
 *        separately.
 *
 * Two boundaries §18 draws are enforced by the shape of this table rather than by
 * a promise in a comment: the supplier is a `parties` row (no second supplier
 * model), and nothing here is an invoice, an AP entry or a payment — Accounting
 * remains the source of truth for posted cost, and this register only says what
 * has been *promised*.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "view");
      return NextResponse.json({ commitments: await listProjectCommitments(owner.businessId, id) });
    } catch (err) {
      return handleAecError(err);
    }
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "manage");
      const commitment = await createCommitment(owner, id, await readBody(request));
      return NextResponse.json({ commitment }, { status: 201 });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
