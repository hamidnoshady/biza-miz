import { NextRequest, NextResponse } from "next/server";
import {
  requireAnyPermission,
  requireFloorAssistant,
  requirePermission,
  withTenantScope,
} from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import type { AgentMode } from "@/lib/ai";
import {
  deleteConversation,
  getConversationMessages,
  getConversationMode,
  renameConversation,
} from "@/lib/ai-conversations";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES: readonly AgentMode[] = ["wizard", "dashboard", "floor"];

/**
 * Canonical conversation-mode authorization policy (Issue #905 §10):
 * - `floor` conversations require `requireFloorAssistant()` (active
 *   cashier/waiter membership with `PERMISSIONS.menuView`).
 * - `dashboard` and `wizard` conversations require `requirePermission(PERMISSIONS.aiUse)`.
 * - Every lookup is scoped by `(id, business_id = session.businessId,
 *   actor_user_id = session.sub)` inside `withTenantScope`, so foreign-member
 *   and foreign-business ids return 404 without leaking existence, while
 *   revoking the mode's permission immediately blocks detail, rename, and
 *   delete with 403 Forbidden.
 */
async function requireConversationModeAccess(mode: AgentMode) {
  return mode === "floor"
    ? requireFloorAssistant()
    : requirePermission(PERMISSIONS.aiUse);
}

async function authorizeConversationById(id: string) {
  const baseGuard = await requireAnyPermission(
    PERMISSIONS.aiUse,
    PERMISSIONS.menuView,
  );
  if (baseGuard.error) {
    return { error: baseGuard.error, session: null, mode: null };
  }
  const session = baseGuard.session;

  if (!UUID_RE.test(id)) {
    return {
      error: NextResponse.json({ error: "not_found" }, { status: 404 }),
      session: null,
      mode: null,
    };
  }

  const savedMode = await getConversationMode({
    businessId: session.businessId,
    actorUserId: session.sub,
    conversationId: id,
  });
  if (!savedMode) {
    return {
      error: NextResponse.json({ error: "not_found" }, { status: 404 }),
      session: null,
      mode: null,
    };
  }

  const modeGuard = await requireConversationModeAccess(savedMode);
  if (modeGuard.error) {
    return { error: modeGuard.error, session: null, mode: null };
  }

  return { error: null, session: modeGuard.session, mode: savedMode };
}

export const GET = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const auth = await authorizeConversationById(id);
    if (auth.error) return auth.error;
    const session = auth.session;

    const rawMode = new URL(request.url).searchParams.get("mode");
    const requestedMode =
      rawMode && (MODES as readonly string[]).includes(rawMode)
        ? (rawMode as AgentMode)
        : null;
    if (requestedMode && requestedMode !== auth.mode) {
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
    return NextResponse.json(result);
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const auth = await authorizeConversationById(id);
    if (auth.error) return auth.error;
    const session = auth.session;

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
    const { id } = await context.params;
    const auth = await authorizeConversationById(id);
    if (auth.error) return auth.error;
    const session = auth.session;

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
