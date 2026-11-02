import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { requireContract, readContractDocument } from "@/lib/contracts/service";
import {
  cancelEnvelope,
  getSigningOverview,
  MAX_INVITATION_DAYS,
  resendInvitation,
  saveSigningDraft,
  sendEnvelope,
} from "@/lib/contracts/signing";
import { freezeContractDocument } from "@/lib/contracts/service";
import { resolveWorkspaceSubject } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../../../guard";

/**
 * The contract's SIGNING envelope (issue #908): who signs, in what order, and
 * the actions that move it — send, resend, copy a link, cancel.
 *
 * Every verb is `workspace.contracts_manage` + `edit` on the contract. Sending a
 * document out to be signed by a third party is the point at which this business
 * commits itself, so it is never a `workspace.manage` action.
 *
 * `POST` is an action switch rather than four sibling routes because all four
 * write the same envelope row and share the same guard; keeping them together is
 * what stops one of them forgetting the guard.
 */

/**
 * The browser-facing origin a signer's link should use.
 *
 * `request.url` is the CONTAINER's origin behind a TLS proxy (issue #1062), so
 * an explicit `PUBLIC_ORIGIN` wins, then the proxy headers, and only then the
 * request itself. A wrong origin here produces a link that 502s at the signer.
 */
function linkOrigin(request: NextRequest): string {
  const configured = process.env.PUBLIC_ORIGIN?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host") || "";
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  return host ? `${proto}://${host}` : new URL(request.url).origin;
}

export const GET = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView, request);
    if (error) return error;
    const { id } = await context.params;
    try {
      await resolveWorkspaceSubject(owner, "contract", id, "view");
      const contract = await requireContract(owner, id);
      const [overview, document] = await Promise.all([
        getSigningOverview(owner, contract),
        readContractDocument(owner, contract),
      ]);
      let canManage = owner.access?.canManageContracts === true;
      if (canManage) {
        canManage = await resolveWorkspaceSubject(owner, "contract", id, "edit").then(
          () => true,
          () => false,
        );
      }
      return NextResponse.json({
        contract: { id: contract.id, title: contract.title, status: contract.status },
        overview,
        slots: document.slots,
        versions: document.versions,
        expiresInDaysMax: MAX_INVITATION_DAYS,
        capabilities: { canManage },
      });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

/** Save the signer list on a draft envelope. */
export const PUT = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceContractsManage, request);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    try {
      await resolveWorkspaceSubject(owner, "contract", id, "edit");
      const contract = await requireContract(owner, id);
      const overview = await saveSigningDraft(owner, contract, {
        signingMode: body.signingMode,
        signers: body.signers,
        expiresInDays: body.expiresInDays,
      });
      return NextResponse.json({ overview });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceContractsManage, request);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    const action = String(body.action ?? "");
    try {
      await resolveWorkspaceSubject(owner, "contract", id, "edit");
      const contract = await requireContract(owner, id);
      const origin = linkOrigin(request);

      if (action === "send") {
        // The freeze is passed in as a callback so the service can do it FIRST
        // (an envelope may never point at a version that does not exist) while
        // the validation that refuses an incomplete document lives in one place.
        const sent = await sendEnvelope(
          owner,
          contract,
          {
            signingMode: body.signingMode,
            signers: body.signers,
            expiresInDays: body.expiresInDays,
            origin,
          },
          () => freezeContractDocument(owner, contract),
        );
        return NextResponse.json({
          envelope: sent.envelope,
          version: sent.version,
          deliveries: sent.deliveries,
        });
      }

      if (action === "resend") {
        const delivery = await resendInvitation(owner, contract, String(body.signerId ?? ""), {
          channel: body.channel,
          origin,
        });
        return NextResponse.json({ delivery });
      }

      if (action === "cancel") {
        const overview = await cancelEnvelope(owner, contract, { reason: body.reason });
        return NextResponse.json({ overview });
      }

      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
