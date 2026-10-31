import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import {
  deleteAgencyBrief,
  loadAgencyBrief,
  updateAgencyBrief,
} from "@/lib/agency-brief-service";
import { briefActor, briefErrorResponse, readBriefBody } from "../../brief-guard";

/**
 * One client brief (issue #1128 §A): whose requirement it records, what it asks
 * for, what the client said they intend to spend, when it runs, who on the client
 * side approves it, and the acts it can take from where it is.
 *
 * `actions` is derived from the brief's own status by the same function the panel
 * renders its buttons from, so the member-facing side can never offer an act this
 * route would refuse.
 *
 * PATCH edits what is still editable. From `confirmed` on, what the client agreed
 * is frozen — here and again by migration 0271's trigger — and the way forward is
 * `…/status`'s `supersede`, which leaves the confirmed brief intact as the record
 * of what was agreed. The pointers to the opportunity and the project are *not*
 * frozen, because the project normally arrives after confirmation and blocking it
 * would break the handoff into §B.
 *
 * DELETE is a draft-only escape hatch for a brief written by mistake. A brief the
 * client has seen is withdrawn, not deleted: the withdrawal is the record that a
 * conversation happened.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmView);
    if (error) return error;

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "brief_not_found" }, { status: 404 });

    try {
      return NextResponse.json({ brief: await loadAgencyBrief(session.businessId, id) });
    } catch (err) {
      const response = briefErrorResponse(err);
      if (response) return response;
      throw err;
    }
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmManage);
    if (error) return error;

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "brief_not_found" }, { status: 404 });

    const body = await readBriefBody(request);
    if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

    try {
      const brief = await updateAgencyBrief(session.businessId, id, briefActor(session), body);
      return NextResponse.json({ brief });
    } catch (err) {
      const response = briefErrorResponse(err);
      if (response) return response;
      throw err;
    }
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    // Owner-level, unlike the rest of this surface: a brief is the record of what
    // a client asked for, and making it never have existed is not the same work as
    // editing one.
    const { session, error } = await requirePermission(PERMISSIONS.crmDelete);
    if (error) return error;

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "brief_not_found" }, { status: 404 });

    try {
      const deleted = await deleteAgencyBrief(session.businessId, id);
      if (!deleted) return NextResponse.json({ error: "brief_not_found" }, { status: 404 });
      return NextResponse.json({ result: "deleted" });
    } catch (err) {
      const response = briefErrorResponse(err);
      if (response) return response;
      throw err;
    }
  },
);
