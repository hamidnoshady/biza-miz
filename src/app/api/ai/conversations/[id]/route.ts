import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  deleteConversation,
  getConversationMessages,
  renameConversation,
} from "@/lib/ai-conversations";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Transcript access policy (Issue #905 §10):
 * - Detail, rename, and delete require active membership and assistant access
 *   (`PERMISSIONS.aiUse` or floor assistant `PERMISSIONS.menuView`) via
 *   `requireAnyPermission()`. Revoking both capabilities or deactivating the
 *   member immediately revokes transcript access (403 Forbidden).
 * - Every query filters by `(id, business_id = session.businessId,
 *   actor_user_id = session.sub)` inside `withTenantScope`, so foreign-member
 *   and foreign-business ids return 404 without leaking existence.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const guard = await requireAnyPermission(
      PERMISSIONS.aiUse,
      PERMISSIONS.menuView,
    );
    if (guard.error) return guard.error;
    const session = guard.session;

    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const result = await getConversationMessages({
      businessId: session.businessId,
      actorUserId: session.sub,
      conversationId: id,
    });
    if (!result) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (guard.membership) {
      const requiredPerm =
        result.conversation.mode === "floor"
          ? PERMISSIONS.menuView
          : PERMISSIONS.aiUse;
      if (!guard.membership.permissions.has(requiredPerm)) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }
    return NextResponse.json(result);
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const guard = await requireAnyPermission(
      PERMISSIONS.aiUse,
      PERMISSIONS.menuView,
    );
    if (guard.error) return guard.error;
    const session = guard.session;

    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    let body: { title?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (typeof body.title !== "string" || !body.title.trim()) {
      return NextResponse.json({ error: "empty_title" }, { status: 400 });
    }

    const updated = await renameConversation({
      businessId: session.businessId,
      actorUserId: session.sub,
      conversationId: id,
      title: body.title,
    });
    if (!updated) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ conversation: updated });
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const guard = await requireAnyPermission(
      PERMISSIONS.aiUse,
      PERMISSIONS.menuView,
    );
    if (guard.error) return guard.error;
    const session = guard.session;

    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const ok = await deleteConversation({
      businessId: session.businessId,
      actorUserId: session.sub,
      conversationId: id,
    });
    if (!ok) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  },
);
