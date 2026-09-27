/**
 * The request half of pairing-code redemption, shared by the two URLs that
 * expose it.
 *
 * There are two because of where the credential is now issued. Redemption has
 * always lived under `/api/platform/pairing/redeem`, and middleware moves
 * *anything* under `/api/platform` to the console's own host — correct for the
 * console, wrong here: since an owner can issue a desktop code from their own
 * dashboard, the address they hand the desktop app is their own business
 * origin (`biz1.example.com`), and pairing against it would bounce through a
 * cross-host redirect before it ever reached a handler. `/api/pairing/redeem`
 * is the same exchange with no `/api/platform` prefix, so it answers on
 * whatever origin the owner copied.
 *
 * The old URL stays, unchanged in behaviour: every desktop build already
 * shipped points at it, and `/api/setup/pair` still falls back to it when a
 * cloud server is too old to serve the new one.
 */
import { NextRequest, NextResponse } from "next/server";
import { redeemPairingCode } from "./pairing-service";
import { clientIpFrom } from "./rate-limit";

/** The caller's address, for the `redeemed_ip` audit column. Best-effort by nature. */
function clientIp(request: NextRequest): string | null {
  const ip = clientIpFrom(request.headers, 0);
  if (ip !== "unknown") return ip;
  return (request as unknown as { ip?: string }).ip ?? null;
}

const STATUS_BY_ERROR: Record<string, number> = {
  code_not_found: 404,
  code_expired: 410,
  code_already_redeemed: 409,
  code_revoked: 410,
  code_pending_activation: 409,
};

/**
 * Trade a pairing code for a business snapshot.
 *
 * Public by necessity: the caller is a freshly-installed desktop app with no
 * session in either realm, and the code *is* the credential — the same shape
 * as /api/auth/accept-invite and the server-sync bearer routes.
 *
 * The response carries the business's whole configuration including credential
 * hashes, so it must never be cached or logged. The cloud device remains
 * pending until the local install acknowledges /api/pairing/activate.
 */
export async function handlePairingRedeem(request: NextRequest): Promise<NextResponse> {
  let body: { code?: string; deviceName?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const code = body.code?.trim();
  if (!code) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const deviceName = typeof body.deviceName === "string" ? body.deviceName : "Windows Business Suite";
  const result = await redeemPairingCode(code, clientIp(request), deviceName);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: STATUS_BY_ERROR[result.error] ?? 400 });
  }

  const response = NextResponse.json({ snapshot: result.snapshot });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
