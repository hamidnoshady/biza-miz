import { NextRequest, NextResponse } from "next/server";
import { withoutTenantScope } from "@/lib/db";
import {
  redeemOfflineToken,
  redeemOnlineCode,
  type CompanionSession,
} from "@/lib/support-companion/access-tokens";

/** Redeems a ticket-issued authorization into a companion session:
 * `{ mode: "online_code", code }` or `{ mode: "offline", token,
 * technicianBindingHash, challenge }`. One atomic consume per issuance;
 * failures name the reason without leaking which codes exist. */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const mode = typeof body.mode === "string" ? body.mode : "";

  if (mode === "online_code") {
    const code = typeof body.code === "string" ? body.code : "";
    if (!code.trim()) return NextResponse.json({ error: "code_required" }, { status: 400 });
    // The business scope is unknown until the code resolves; the redeem
    // itself runs unscoped by code hash, then the session pins the scope.
    const redeemed = await withTenantBypass(async () =>
      redeemOnlineCode({
        code,
        technicianBindingHash: typeof body.technicianBindingHash === "string" ? body.technicianBindingHash : null,
      }),
    );
    return redeemResponse(redeemed);
  }

  if (mode === "offline") {
    const token = typeof body.token === "string" ? body.token : "";
    const technicianBindingHash =
      typeof body.technicianBindingHash === "string" ? body.technicianBindingHash : "";
    const challenge = typeof body.challenge === "string" ? body.challenge : "";
    if (!token || !technicianBindingHash || !challenge) {
      return NextResponse.json({ error: "token_challenge_and_binding_required" }, { status: 400 });
    }
    const redeemed = await withTenantBypass(async () =>
      redeemOfflineToken({ token, technicianBindingHash, challenge }),
    );
    return redeemResponse(redeemed);
  }

  return NextResponse.json({ error: "unknown_mode" }, { status: 400 });
}

type Redeemed = { ok: true; session: CompanionSession } | { ok: false; error: string };

function redeemResponse(redeemed: Redeemed): NextResponse {
  if (!redeemed.ok) {
    const status =
      redeemed.error === "token_not_found"
        ? 404
        : redeemed.error === "token_expired" ||
            redeemed.error === "token_consumed" ||
            redeemed.error === "binding_mismatch"
          ? 410
          : redeemed.error === "signing_unavailable"
            ? 503
            : 403;
    return NextResponse.json({ error: redeemed.error }, { status });
  }
  return NextResponse.json({ session: redeemed.session }, { status: 201 });
}

// Redemption resolves scope FROM the presented authorization (code hash /
// signed claims), so it cannot run inside a pre-selected tenant scope. The
// queries below still carry explicit business predicates from the resolved
// issuance row — nothing here is a cross-tenant read.
async function withTenantBypass<T>(fn: () => Promise<T>): Promise<T> {
  return withoutTenantScope("support-companion-redeem", fn);
}
