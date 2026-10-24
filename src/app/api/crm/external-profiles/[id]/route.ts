import { NextRequest, NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveExternalProfile } from "@/lib/crm-external-identity";
import { isUuid } from "@/lib/uuid";

/**
 * A person decides who an online shopper actually is.
 *
 * This is the only path on which an ambiguous external identity becomes a link
 * to a customer record, and the only path on which remote data is allowed to
 * overwrite a value the shop entered itself. Both are judgements about people,
 * so both require a human and both leave an audit row naming them.
 *
 * The five decisions:
 * - `link` — this shopper is that customer.
 * - `create` — nobody we have; make a record from what the store knows.
 * - `ignore` — not a customer of ours (a test order, a bot, a duplicate feed).
 * - `accept_conflicts` — the store's values are right; replace ours.
 * - `reject_conflicts` — ours are right; keep them and close the flag.
 *
 * Note what is absent: there is no "merge these two customers" action. Merge
 * is irreversible and lives behind its own screen with its own preview; a
 * reconciliation queue that could trigger one would be a destructive operation
 * hiding inside a routine one.
 */
const ACTIONS = ["link", "create", "ignore", "accept_conflicts", "reject_conflicts"] as const;
type Action = (typeof ACTIONS)[number];

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmManage);
    if (error) return error;

    const { id } = await context.params;
    if (!isUuid(id)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

    let body: { action?: string; partyId?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const action = body.action as Action | undefined;
    if (!action || !ACTIONS.includes(action)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (action === "link" && (!body.partyId || !isUuid(body.partyId))) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const decision =
      action === "link"
        ? ({ action, partyId: body.partyId! } as const)
        : ({ action } as Exclude<Parameters<typeof resolveExternalProfile>[2], { action: "link" }>);

    let profile;
    try {
      profile = await resolveExternalProfile(session.businessId, id, decision, {
        name: session.fullName,
        userId: session.sub,
      });
    } catch (err) {
      if ((err as Error).message === "insufficient_identity") {
        return NextResponse.json({ error: "insufficient_identity" }, { status: 409 });
      }
      throw err;
    }

    // Null covers both "no such profile in this business" and "the party you
    // named is not ours" — the service proves tenancy rather than trusting the
    // ids, and the API does not distinguish the two cases for the caller.
    if (!profile) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ profile });
  },
);
