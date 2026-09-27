import { NextResponse } from "next/server";
import { withTenantScope, requireRole } from "@/lib/auth";
import { generateSyncToken } from "@/lib/sync-token";

/**
 * Owner-only: mint a shared sync token in the canonical POS1 format.
 *
 * Deliberately *only* generates — it does not save. The owner sees the value
 * once, copies it to the other side, and then saves it through the existing
 * PUT /api/server-sync/config, which is where validation and the
 * `server_sync_tokens` hash already live. Generating and storing in one step
 * would rotate the live token before the peer had the new value, breaking
 * sync between the two calls.
 */
export const POST = withTenantScope(async () => {
  const { error } = await requireRole("owner");
  if (error) return error;

  return NextResponse.json({ token: generateSyncToken() });
});
