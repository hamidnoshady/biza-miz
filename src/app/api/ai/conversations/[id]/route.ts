import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import {
  deleteConversation,
  getConversationMessages,
  renameConversation,
} from "@/lib/ai-conversations";

/** One conversation's messages. Ownership (not role) is the access control — see ai-conversations.ts. */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await context.params;
    const requestedMode = _request.nextUrl.searchParams.get("mode");

    const result = await getConversationMessages({
      businessId: session.businessId,
      actorUserId: session.sub,
      conversationId: id,
    });
    if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (requestedMode && requestedMode !== result.conversation.mode) {
      return NextResponse.json({ error: "conversation_mode_mismatch" }, { status: 409 });
    }
    return NextResponse.json(result);
  },
);

/**
 * Rename one conversation (the history sidebar's inline editor). Ownership is
 * enforced the same way as GET/DELETE: an unknown or foreign id is a 404, and
 * a title that is empty after normalisation is a 400 — never a silent no-op.
 */
export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await context.params;

    let body: { title?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const title = typeof body.title === "string" ? body.title : "";
    if (!title.replace(/\s+/g, " ").trim()) {
      return NextResponse.json(
        { error: "missing_title", message: "عنوان گفتگو نمی‌تواند خالی باشد." },
        { status: 400 },
      );
    }

    const renamed = await renameConversation({
      businessId: session.businessId,
      actorUserId: session.sub,
      conversationId: id,
      title,
    });
    if (!renamed) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ conversation: renamed });
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await context.params;

    const deleted = await deleteConversation({
      businessId: session.businessId,
      actorUserId: session.sub,
      conversationId: id,
    });
    if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
