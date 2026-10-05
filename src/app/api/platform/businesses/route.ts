import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, platformAudit, withPlatformScope } from "@/lib/platform-auth";
import {
  queryBusinesses,
  listBusinessPlanKeys,
  type BusinessQuery,
} from "@/lib/platform-service";
import { rootDomain } from "@/lib/host";
import { isIndustry } from "@/lib/industries";
import {
  provisionBusiness,
  validateProvisionBody,
  ExistingOwnerConfirmationRequiredError,
  OwnerPhoneRequiredError,
  SubdomainTakenError,
  type ProvisionRequestBody,
} from "@/lib/business-provisioning";
import { autoProvisionBusinessVirtualKey } from "@/lib/ai-gateway-service";

const VALID_STATUS = new Set(["active", "suspended", "archived"]);
const VALID_SORT = new Set(["newest", "oldest", "name", "orders", "members", "activity"]);
const VALID_ACTIVITY = new Set(["active", "idle"]);

/**
 * The console's business directory — filtered, sorted and paginated server-side
 * (any admin reads). Query params: `search`, `status`, `plan`, `industry`,
 * `from`/`to` (created-at ISO dates), `activity`, `sort`, `page`, `pageSize`.
 * `rootDomain` rides along because the console is a client component and cannot
 * read the server's environment — it needs the root to render a business's real
 * URL and to preview one before provisioning. The response carries `meta` with
 * pagination info (task section 25) and `statusCounts`, whose three figures are
 * server-side aggregates over the current filter context — not a count of the
 * 20 rows on this page, which is what the summary cards used to show.
 * `plans` is the distinct plan keys in use, so the plan filter has real options
 * without a `plans.manage`-gated catalogue read.
 */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const sp = request.nextUrl.searchParams;
  const statusParam = sp.get("status") ?? undefined;
  const sortParam = sp.get("sort") ?? undefined;
  const activityParam = sp.get("activity") ?? undefined;
  const industryParam = sp.get("industry") ?? undefined;
  const pageNum = Number(sp.get("page"));
  const pageSizeNum = Number(sp.get("pageSize"));

  const q: BusinessQuery = {
    search: sp.get("search") ?? undefined,
    status: statusParam && VALID_STATUS.has(statusParam) ? (statusParam as BusinessQuery["status"]) : undefined,
    plan: sp.get("plan") ?? undefined,
    industry: industryParam && isIndustry(industryParam) ? industryParam : undefined,
    createdFrom: sp.get("from") ?? undefined,
    createdTo: sp.get("to") ?? undefined,
    activity: activityParam && VALID_ACTIVITY.has(activityParam) ? (activityParam as BusinessQuery["activity"]) : undefined,
    sort: sortParam && VALID_SORT.has(sortParam) ? (sortParam as BusinessQuery["sort"]) : undefined,
    page: Number.isFinite(pageNum) && pageNum > 0 ? pageNum : undefined,
    pageSize: Number.isFinite(pageSizeNum) && pageSizeNum > 0 ? pageSizeNum : undefined,
  };

  const [result, plans] = await Promise.all([queryBusinesses(q), listBusinessPlanKeys()]);
  return NextResponse.json({
    businesses: result.businesses,
    rootDomain: rootDomain(),
    plans,
    meta: {
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      statusCounts: result.statusCounts,
    },
  });
});

/**
 * Provision a working business end-to-end: identity, owner membership, first
 * branch, and — because this is the console, not the setup wizard — the default
 * chart of accounts, so the owner can log straight in and sell (exit criterion
 * 1). Owner-only (`business.provision`), and audited before we return.
 *
 * **No password is accepted here (issue #755 §14).** The console used to take
 * an operator-chosen owner password and print the owner's second factor and
 * recovery codes. Now the new owner's identity is created with 32 random bytes
 * nobody knows, and the response carries a single-use activation link the
 * operator hands over. The owner sets their own password and receives their own
 * MFA material at that link, in their own browser — so no platform operator
 * ever holds a permanent credential to a tenant.
 *
 * The one exception is an email that already has a platform login: that person
 * keeps the password they already have (the operator never learns it), and the
 * business is simply added to their account. Because that is still an action on
 * somebody else's identity, it is refused the first time and only performed
 * when the operator repeats the request with `confirmExistingOwner`.
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("business.provision");
  if (error) return error;

  let body: ProvisionRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // The console is the one caller with a super-admin in front of it, so it is
  // the one caller required to name the business's address: `{subdomain}.$ROOT_DOMAIN`
  // is what the owner will be given, and it is typed in English by hand rather
  // than transliterated from a Persian business name.
  const validated = validateProvisionBody(body, {
    requireSubdomain: true,
    ownerActivation: true,
  });
  if (validated.input === null) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const input = validated.input;

  try {
    const provisioned = await provisionBusiness({
      ...input,
      seedChartOfAccounts: true,
      // The console's contract is a business the owner can log straight into
      // and sell from. Stamping the canonical completion marker here (issue
      // #808 §4) is what makes that true for onboarding routing as well:
      // without it the owner's first login lands in the first-run wizard.
      completeSetup: true,
      createdBy: session.padmin,
      confirmExistingOwner: body.confirmExistingOwner === true,
    });

    // A configured LiteLLM gateway now provisions the tenant key as part of
    // business creation; failures are recorded for retry and never undo the
    // otherwise successful tenant transaction.
    await autoProvisionBusinessVirtualKey(provisioned.businessId);

    await platformAudit({
      adminId: session.padmin,
      businessId: provisioned.businessId,
      action: "business.provision",
      entity: "business",
      entityId: provisioned.businessId,
      payload: {
        businessName: input.businessName,
        slug: provisioned.businessSlug,
        subdomain: provisioned.businessSubdomain,
        industry: input.industry,
        ownerEmail: input.email,
        ownerIdentityCreated: provisioned.ownerIdentityCreated,
        ownerActivationIssued: Boolean(provisioned.ownerActivation),
      },
    });

    return NextResponse.json(
      {
        business: {
          id: provisioned.businessId,
          slug: provisioned.businessSlug,
          subdomain: provisioned.businessSubdomain,
          locationId: provisioned.locationId,
        },
        // The activation token is *not* secret from this operator — they have to
        // carry it to the owner. What it deliberately is not is permanent, or
        // usable by them: it is single-use, it expires, and redeeming it sets a
        // password the operator never sees.
        owner: {
          email: input.email,
          existingLogin: !provisioned.ownerIdentityCreated,
          activationRequired: Boolean(provisioned.ownerActivation),
          activationToken: provisioned.ownerActivation?.token ?? null,
          activationExpiresAt: provisioned.ownerActivation?.expiresAt.toISOString() ?? null,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof SubdomainTakenError) {
      // Someone else already answers on that host, or it is an old host of
      // theirs that still redirects. The admin picks another rather than
      // being silently given `acme-2`.
      return NextResponse.json({ error: "subdomain_taken" }, { status: 409 });
    }
    if (err instanceof OwnerPhoneRequiredError) {
      // An activation link without a mobile cannot be honoured: redemption
      // requires a code texted to the owner (issue #755 §14). Say so instead of
      // creating a business nobody can log into.
      return NextResponse.json({ error: "owner_phone_required" }, { status: 400 });
    }
    if (err instanceof ExistingOwnerConfirmationRequiredError) {
      // The address already belongs to a platform user. Usually that is the
      // group owner opening their second café, but it is still an action on
      // someone else's account, so it needs an explicit yes.
      return NextResponse.json({ error: "email_already_registered" }, { status: 409 });
    }
    throw err;
  }
});
