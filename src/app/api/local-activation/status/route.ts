import { NextRequest, NextResponse } from "next/server";
import { requireMember, requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";
import {
  discardUnsentSupportDraft,
  enrollLegacyLocalInstallation,
  getLocalActivationView,
  listUnsentSupportDrafts,
  repairOrReenrollLocalInstallation,
  runLocalActivationValidationForBusiness,
  verifyCloudTokenFromSite,
} from "@/lib/local-activation-site-service";
import {
  getLocalRemoteSupportStateForUi,
  pollAndProcessLocalSupportSessionForBusiness,
  respondToLocalRemoteSupportConsent,
  revokeLocalRemoteSupportSessionLocally,
} from "@/lib/local-remote-support-service";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, private, max-age=0",
};

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requireMember();
  if (error) return error;

  const businessId = session.businessId;
  const role = deploymentRole();
  const deployment = await readDeploymentProfile(businessId);
  if (role !== "site" || deployment.profile !== "local") {
    return NextResponse.json(
      {
        applicable: false,
        deploymentRole: role,
        deploymentProfile: deployment.profile,
      },
      { headers: NO_STORE_HEADERS },
    );
  }

  const probe = request.nextUrl.searchParams.get("probe") === "1";
  const internetHintOffline = request.nextUrl.searchParams.get("offlineHint") === "1";

  if (probe) {
    await pollAndProcessLocalSupportSessionForBusiness(businessId).catch(() => {});
  }

  const canManageSupport =
    membership.permissions.has(PERMISSIONS.settingsManage) && !session.imp;

  const [activation, remoteSupport, unsentDrafts] = await Promise.all([
    getLocalActivationView(businessId, {
      probeReachability: probe,
      internetHintOffline,
    }),
    getLocalRemoteSupportStateForUi(businessId),
    canManageSupport
      ? listUnsentSupportDrafts(businessId)
      : Promise.resolve([]),
  ]);

  return NextResponse.json(
    {
      applicable: true,
      deploymentRole: role,
      deploymentProfile: deployment.profile,
      canManageActivation: session.role === "owner" && !session.imp,
      canManageSupport,
      activation,
      remoteSupport,
      unsentDrafts,
    },
    { headers: NO_STORE_HEADERS },
  );
});

export const POST = withTenantScope(async (request: NextRequest) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";

  if (
    action === "revalidate" ||
    action === "revoke_remote_support" ||
    action === "discard_unsent_draft"
  ) {
    const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
    if (error) return error;
    if (session.imp) {
      return NextResponse.json({ error: "forbidden_impersonation" }, { status: 403 });
    }

    const businessId = session.businessId;
    const role = deploymentRole();
    const deployment = await readDeploymentProfile(businessId);
    if (role !== "site" || deployment.profile !== "local") {
      return NextResponse.json({ error: "not_local_deployment" }, { status: 409 });
    }

    if (action === "revalidate") {
      const val = await runLocalActivationValidationForBusiness(businessId, { force: true });
      await pollAndProcessLocalSupportSessionForBusiness(businessId).catch(() => {});
      const activation = await getLocalActivationView(businessId, { probeReachability: true });
      return NextResponse.json(
        { ok: true, result: val, activation },
        { headers: NO_STORE_HEADERS },
      );
    }

    if (action === "revoke_remote_support") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) {
        return NextResponse.json({ error: "missing_session_id" }, { status: 400 });
      }
      await revokeLocalRemoteSupportSessionLocally({
        businessId,
        sessionId,
        actorUserId: session.sub,
      });
      const remoteSupport = await getLocalRemoteSupportStateForUi(businessId);
      return NextResponse.json({ ok: true, remoteSupport }, { headers: NO_STORE_HEADERS });
    }

    const eventId =
      typeof body.eventId === "string" && body.eventId
        ? body.eventId
        : typeof body.draftId === "string"
          ? body.draftId
          : "";
    if (!eventId) {
      return NextResponse.json({ error: "missing_event_id" }, { status: 400 });
    }
    await discardUnsentSupportDraft(businessId, eventId, session.sub);
    const unsentDrafts = await listUnsentSupportDrafts(businessId);
    return NextResponse.json({ ok: true, unsentDrafts }, { headers: NO_STORE_HEADERS });
  }

  // Owner-only privileged actions: token verify/enroll/replace, Cloud URL update, remote-support consent
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  if (session.role !== "owner") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (session.imp) {
    return NextResponse.json({ error: "forbidden_impersonation" }, { status: 403 });
  }

  const businessId = session.businessId;
  const role = deploymentRole();
  const deployment = await readDeploymentProfile(businessId);
  if (role !== "site" || deployment.profile !== "local") {
    return NextResponse.json({ error: "not_local_deployment" }, { status: 409 });
  }

  if (action === "verify_token") {
    const current = await getLocalActivationView(businessId);
    const cloudUrl =
      typeof body.cloudUrl === "string" && body.cloudUrl.trim()
        ? body.cloudUrl.trim()
        : (current.cloudOrigin ?? "");
    const token = typeof body.token === "string" ? body.token : "";
    const verified = await verifyCloudTokenFromSite({
      cloudUrl,
      token,
      expectedCloudBusinessId: current.cloudBusinessId,
    });
    if (!verified.ok) {
      return NextResponse.json(
        { ok: false, error: verified.error },
        { status: verified.httpStatus, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      {
        ok: true,
        cloudOrigin: verified.cloudOrigin,
        businessName: verified.businessBundle.name,
        businessSlug: verified.businessBundle.slug,
        locationName: verified.businessBundle.location.name,
        plan: verified.businessBundle.plan,
      },
      { headers: NO_STORE_HEADERS },
    );
  }

  if (action === "enroll_existing") {
    const cloudUrl = typeof body.cloudUrl === "string" ? body.cloudUrl : "";
    const token = typeof body.token === "string" ? body.token : "";
    const res = await enrollLegacyLocalInstallation({
      localBusinessId: businessId,
      cloudUrl,
      token,
      actorUserId: session.sub,
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: res.error },
        { status: res.httpStatus, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      { ok: true, activation: res.view },
      { headers: NO_STORE_HEADERS },
    );
  }

  if (action === "replace_token" || action === "update_cloud_url") {
    const cloudUrl =
      action === "update_cloud_url" && typeof body.cloudUrl === "string"
        ? body.cloudUrl
        : null;
    if (action === "update_cloud_url" && !cloudUrl?.trim()) {
      return NextResponse.json({ error: "missing_cloud_url" }, { status: 400 });
    }
    const token = typeof body.token === "string" ? body.token : "";
    const res = await repairOrReenrollLocalInstallation({
      localBusinessId: businessId,
      cloudUrl,
      token,
      actorUserId: session.sub,
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: res.error },
        { status: res.httpStatus, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      { ok: true, activation: res.view },
      { headers: NO_STORE_HEADERS },
    );
  }

  if (action === "approve_remote_support" || action === "deny_remote_support") {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!sessionId) {
      return NextResponse.json({ error: "missing_session_id" }, { status: 400 });
    }
    const res = await respondToLocalRemoteSupportConsent({
      businessId,
      sessionId,
      approve: action === "approve_remote_support",
      ownerUserId: session.sub,
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: res.error },
        { status: res.httpStatus, headers: NO_STORE_HEADERS },
      );
    }
    const remoteSupport = await getLocalRemoteSupportStateForUi(businessId);
    return NextResponse.json({ ok: true, remoteSupport }, { headers: NO_STORE_HEADERS });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
});
