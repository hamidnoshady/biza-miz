import { NotificationBell } from "@/components/notifications/notification-bell";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { endedSupportSessionClaims, getSession, type Role } from "@/lib/auth";
import { appForModule } from "@/lib/apps";
import {
  isProductWorkspaceIndustry,
  PRODUCT_WORKSPACE_SECTIONS,
} from "@/lib/product-workspace";
import { ACCOUNTING_SECTIONS } from "@/app/(app)/accounting/accounting-nav";
import { PARTY_DIRECTORY_NAV_VIEWS, partyDirectoryHref } from "@/lib/party-directory";
import { accountingSectionHref } from "@/app/(app)/accounting/accounting-routes";
import { ACCOUNTING_WORKSPACE_HREFS, PLATFORM_BILLING_HREF, PLATFORM_SETTINGS_HOME } from "@/lib/app-routes";
import { settingsTabHref } from "@/lib/settings-routes";
import { REPORTS_TABS, reportsTabHref } from "./reports/reports-nav";
import { REPORT_CAPABILITY_PERMISSIONS } from "@/lib/report-permissions";
import { effectiveAppAvailability } from "@/lib/app-availability-service";
import { query, withTenant } from "@/lib/db";
import { effectiveFeatures, isLockableFeature } from "@/lib/features";
import { INDUSTRY_LABELS, type Industry } from "@/lib/industries";
import { hasModule, industryProfile, labelFor } from "@/lib/industry-profile";
import { PERMISSIONS, POS_REQUIRED_PERMISSIONS, type Permission } from "@/lib/permissions";
import { memberAccessFor } from "@/lib/member-access";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { visibleSettingsTabs, type ResolvedSettingsTab } from "@/lib/settings-tabs";
import { visibleWorkspaceSections } from "@/app/(app)/workspace/workspace-routes";
import { MoneyProvider } from "@/components/money/money-context";
import { BugReportProvider } from "@/components/bug-report/bug-report-provider";
import { LockProvider } from "./lock-screen";
import { DashboardSidebar, type NavItem } from "./dashboard-sidebar";
import { DashboardMain } from "./dashboard-main";
import { AppAvailabilityGate } from "./app-availability-gate";
import { DeploymentCapabilityGate } from "./deployment-capability-gate";
import { AssistantLinkProvider } from "@/components/ai/ask-assistant";
import { TenantAiIdentity } from "@/components/ai/persistent-tenant-ai";
import { TenantAssistantFrame } from "@/components/ai/tenant-assistant-frame";
import { accessibleNavItemsFor } from "@/lib/tenant-navigation";
export { navItemsFor, accessibleNavItemsFor } from "@/lib/tenant-navigation";
import { getPlatformAiMode } from "@/lib/ai-runtime-modes";
import { canManageAi, resolveAllowedAiPanelSections } from "@/lib/ai-panel";
import { resolveAccessibleFocuses, resolveEligibleTasks, resolveStarterPrompts, resolveTenantTaskFeatures } from "@/lib/ai-tasks";
import { isAppUsable } from "@/lib/app-availability";
import { NativeDeviceRegistrar } from "@/components/native/native-device-registrar";
import { OfflineQueueProvider } from "./offline-queue";
import { NavigationPendingProvider } from "@/components/navigation/navigation-pending";
import { HeadingFocusManager } from "@/components/navigation/heading-focus";
import { KitchenDispatchAgentLoader } from "./kitchen/kitchen-dispatch-agent-loader";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { resolveCapability, type CapabilityKey } from "@/lib/capabilities";
import { deploymentRole } from "@/lib/deployment-role";
import { getServerSyncConfig } from "@/lib/server-sync";
import { isHybridSite } from "@/lib/site-routes";
import { isCloudEmbedUserAgent } from "@/lib/cloud-embed";
import { HybridConnectivityNotice } from "./hybrid-connectivity-notice";
import { getGrant } from "@/lib/platform-service";
import { SupportSessionBanner, SupportSessionEnded } from "./support-session-banner";
import { LocalOfflineShellGuard } from "./local-offline-shell-guard";
import { getLocalActivationView } from "@/lib/local-activation-site-service";
import { getLocalRemoteSupportStateForUi } from "@/lib/local-remote-support-service";
import { GROWTH_APP_PERMISSIONS } from "@/lib/growth-access";
import { SessionExpiryListener } from "@/components/auth/session-expiry-listener";

/**
 * The dashboard nav.
 *
 * Each entry names the `module` that owns it (src/lib/industry-profile.ts), so
 * which entries exist is a property of the business's industry rather than of
 * this list. Labels that differ by trade come from `labelFor` for the same
 * reason — a jewellery business's sell screen is «فروش و فاکتور», not
 * «صندوق (فروش)» — while labels that are the same everywhere stay literals.
 *
 * The three industry pages take their label from `INDUSTRY_LABELS`, the same
 * constant the console and the /welcome picker use, so a business's type is
 * called one thing across the whole product.
 */
/**
 * The one dashboard chrome — sidebar, mobile header, bottom bar, availability
 * gate — shared by `/dashboard/*` and by every public app route under
 * `src/app/(app)` (`/accounting`, `/growth`, `/crm`, `/websites`, `/workspace`,
 * `/settings`).
 *
 * It used to *be* `src/app/dashboard/layout.tsx`, which is why the public app
 * URLs had to be rewritten back onto `/dashboard/<app>` to get a sidebar at
 * all. The apps are real route directories now, so the chrome is a component
 * both route groups' layouts render instead of a layout only one tree can
 * reach.
 */
export async function WorkspaceShell({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getSession();
  if (!session) {
    const endedSupport = await endedSupportSessionClaims();
    if (endedSupport) return <SupportSessionEnded grantId={endedSupport.imp.grantId} />;
    redirect("/login");
  }

  // withTenant() rather than the ambient scope getSession() already set: that
  // scope was applied with enterWith(), which does not survive a concurrent
  // withTenant()/withoutTenantScope() run() call elsewhere in the process (a
  // background tick, another in-flight request) — see the withTenantScope
  // doc comment in src/lib/auth.ts. Without this, the query below can come
  // back empty non-deterministically and, since it gates access, incorrectly
  // sign an active member out.
  //
  // The membership read itself is `memberAccessFor`'s one copy
  // (src/lib/member-access.ts) — the explicit scope and the
  // effectivePermissions resolution live there, so this shell and the pages
  // that gate by permission cannot drift about either.
  const [member, tenantReads] = await Promise.all([
    memberAccessFor(session),
    withTenant(
      session.businessId,
      () =>
        Promise.all([
          query<{ industry: Industry }>("SELECT industry FROM businesses WHERE id = $1", [session.businessId]),
          getSetting<{ currencyDisplay?: "toman" | "rial" }>(session.businessId, SETTING_KEYS.businessPrefs),
          // Migration 0128 — the app's own state («به‌زودی», «در حال تعمیر», …),
          // resolved platform row + per-business override. Orthogonal to the
          // feature flags above: a flag says whether the business is entitled to
          // a capability, this says whether the app it lives in is working.
          effectiveAppAvailability(session.businessId),
          effectiveFeatures(session.businessId),
          readDeploymentProfile(session.businessId),
          getServerSyncConfig(session.businessId),
        ]),
      { locationId: session.locationId, userId: session.sub },
    ),
  ]);
  if (!member?.isActive) redirect("/login");
  const [industryResult, prefs, appAvailability, features, deployment, serverSyncConfig] = tenantReads;
  const runtimeRole = deploymentRole();
  // Phase 46: a Hybrid desktop shows the full menu; cloud screens open in its
  // content area (DeploymentCapabilityGate → CloudPane).
  const hybridSite = isHybridSite(deployment.profile, runtimeRole);
  // The cloud page inside that pane: the desktop draws the menu, so this page does not.
  const embedded = runtimeRole === "central" && isCloudEmbedUserAgent((await headers()).get("user-agent"));
  const cloudUrl = serverSyncConfig?.enabled ? serverSyncConfig.remoteUrl : null;
  const supportGrant = session.imp ? await getGrant(session.imp.grantId, session.businessId) : null;
  const localSiteGuardData =
    runtimeRole === "site" && deployment.profile === "local"
      ? await withTenant(
          session.businessId,
          () =>
            Promise.all([
              getLocalActivationView(session.businessId),
              getLocalRemoteSupportStateForUi(session.businessId),
            ]),
          { locationId: session.locationId, userId: session.sub },
        )
      : null;
  const industry = industryResult.rows[0]?.industry ?? "food_service";
  const currencyDisplay = prefs?.currencyDisplay === "rial" ? "rial" : "toman";
  const permissions = member.permissions;
  const settingsTabs = visibleSettingsTabs(permissions, { role: member.role, features, industry });
  // My Workspace is shared platform functionality, but its contextual
  // navigation must still be permission-honest. Pass only serializable route
  // data to the client sidebar; the client imports the matching icon registry.
  const workspaceSections = visibleWorkspaceSections(permissions).map(({ key, label, description }) => ({
    key,
    label,
    description,
  }));
  const profile = industryProfile(industry);
  const navItems = accessibleNavItemsFor(
    industry,
    { settingsTabs },
    member.role,
    permissions,
    features,
  ).map((item) => {
      // An app that is off is *announced*, not hidden: the entry stays and
      // carries its state's badge («به‌زودی», «در حال تعمیر», «نسخهٔ آزمایشی»),
      // and its page renders the explanation screen instead of the app. That
      // is why this is a `map` and not another `filter` — see
      // src/lib/app-availability.ts for why the two off-switches differ.
      const app = appForModule(item.module);
      const availability = app ? appAvailability[app] : undefined;
      const deploymentCapability: CapabilityKey | null =
        app === "growth" ? "app.growth" : app === "website" ? "app.website" : null;
      const deploymentLocked = deploymentCapability
        ? !resolveCapability(deploymentCapability, { deployment: deployment.profile }).available
        : false;
      return {
        ...item,
        locked: deploymentLocked || Boolean(item.flag && !features[item.flag]),
        appState:
          availability && availability.badged
            ? { state: availability.state, label: availability.label, usable: availability.usable }
            : undefined,
      };
    });
  // The same assistant capabilities are resolved once by the shared shell for
  // both the full home and the persistent sidebar. Neither the client nor the
  // model supplies the actor's permissions or enabled app set.
  const aiEnabled = features.ai_assistant === true && permissions.has(PERMISSIONS.aiUse);
  const researchMode = aiEnabled
    ? await getPlatformAiMode("deep_research").catch(() => ({ is_active: false }))
    : { is_active: false };
  const deepResearchEnabled = Boolean(researchMode.is_active);
  const taskFeatures = resolveTenantTaskFeatures(features, {
    industry,
    usableApps: {
      accounting: isAppUsable(appAvailability, "accounting"),
      crm: isAppUsable(appAvailability, "crm"),
      growth: isAppUsable(appAvailability, "growth"),
      website: isAppUsable(appAvailability, "website"),
    },
  });
  const eligibility = { mode: "dashboard" as const, industry, features: taskFeatures, permissions };
  const eligibleTaskIds = aiEnabled
    ? resolveEligibleTasks(eligibility, { includeCustom: false }).map((item) => item.id)
    : [];
  const accessibleFocuses = aiEnabled ? resolveAccessibleFocuses(eligibility) : [];
  const aiChatProps = {
    canManageAi: canManageAi(permissions, undefined, { deepResearchEnabled }),
    canAutoApply: member.role === "owner",
    allowedPanelSections: resolveAllowedAiPanelSections(permissions, { deepResearchEnabled }),
    deepResearchEnabled,
    eligibleTaskIds,
    starterPrompts: aiEnabled ? resolveStarterPrompts({
      ...eligibility, eligibleTaskIds, accessibleFocuses, count: 3,
    }) : [],
    accessibleFocuses,
    industry,
  };

  return (
    <LockProvider fullName={session.fullName}>
      <MoneyProvider unit={currencyDisplay}>
        {/*
          Issue #884 — registers this Android installation once the native
          bridge connects. Mounted here, not in the root layout, because by
          this point a session and a business are both already known; the
          root layout also wraps the public/marketing pages, which have
          neither (see the component's own header comment).
        */}
        <NativeDeviceRegistrar businessId={session.businessId} />
        <NotificationBell key={`${session.businessId}:${session.sub}`} identity={`${session.businessId}:${session.sub}`} />
        {/*
          Issue #909 §13 — the one place that reacts to api()'s
          `biza:session-expired` event with an actual expired-session path
          (`/login?next=...`) instead of leaving every caller's 401 as an
          inert label. See the component's own header comment for why this
          belongs here and not in the root/login/setup/platform layouts.
        */}
        <SessionExpiryListener />
        <TenantAiIdentity account={`${session.businessId}:${session.sub}`} />
        <OfflineQueueProvider businessId={session.businessId}>
        <KitchenDispatchAgentLoader enabled={permissions.has(PERMISSIONS.printingExecute)} />
        <BugReportProvider>
        {/*
          A *definite* height, not `min-h-screen` — this is the fix for "the app
          doesn't scroll on my phone".

          The dashboard scrolls inside <main>, which is `overflow-y-auto` and
          `overscroll-y-contain`. With `min-height` here the box still grew to
          its content, so <main> was always exactly as tall as its own content
          and never had anything to scroll: the *document* scrolled instead. On
          a desktop that is merely untidy. On a touch screen it is fatal — the
          drag is captured by <main> (a scroll container with zero scrollable
          distance) and `overscroll-behavior: contain` is precisely the rule
          that stops it chaining out to the document. Nothing moves, on every
          page, and no amount of pulling helps.

          Giving the box a definite height makes <main> the scroller it was
          always written as. `dvh` rather than `vh` so it tracks the visible
          viewport as a phone's URL bar comes and goes; `svh` would leave a gap
          once the bar retracts.
        */}
        <div className="flex h-[100dvh] flex-col md:h-screen md:flex-row">
        {/*
          Issue #909 §9 — one owner for "a navigation is in flight", for the
          sidebar, the Accounting section chips/quick actions and the guard's
          own confirmed "leave this page?" alike, mounted here so it survives
          the very navigation it is reporting on (see the provider's own
          header comment for the full contract).
        */}
        <NavigationPendingProvider>
        <HeadingFocusManager />
        {hybridSite ? <HybridConnectivityNotice /> : null}
        {/*
          `embedded` covers a request that arrived with the pane's token. The
          wrapper's attribute covers the rest: a navigation the cloud's service
          worker forwarded without it (globals.css hides it under
          `html[data-cloud-embed]`). `contents` keeps it out of the layout.
        */}
        {embedded ? null : <div data-workspace-sidebar="" className="contents"><DashboardSidebar
          navItems={navItems}
          role={member.role}
          permissions={[...permissions]}
          fullName={session.fullName}
          brandTitle={profile.brandTitle}
          brandSubtitle={profile.brandSubtitle}
          industry={industry}
          workspaceSections={workspaceSections}
          deploymentProfile={deployment.profile}
          account={`${session.businessId}:${session.sub}`}
        /></div>}
        <TenantAssistantFrame account={`${session.businessId}:${session.sub}`} enabled={aiEnabled} aiProps={aiChatProps}>
        <DashboardMain
          hybridSite={hybridSite}
          showBackupHealth={runtimeRole === "site" && permissions.has(PERMISSIONS.backupManage)}
        >
          {session.imp && supportGrant ? (
            <SupportSessionBanner session={{
              grantId: supportGrant.id,
              businessName: supportGrant.businessName ?? session.businessSlug ?? "کسب‌وکار",
              operatorName: supportGrant.operatorName ?? "اپراتور پلتفرم",
              mode: session.imp.mode,
              expiresAt: new Date(supportGrant.expiresAt).toISOString(),
              serverNow: new Date().toISOString(),
            }} />
          ) : null}
          {localSiteGuardData ? (
            <LocalOfflineShellGuard
              initialActivation={localSiteGuardData[0]}
              initialRemoteSupport={localSiteGuardData[1]}
              canManageActivation={member.role === "owner" && !session.imp}
              canManageSupport={
                (member.role === "owner" || member.role === "manager") && !session.imp
              }
              showLegacyUnenrolledBanner={deployment.source !== "inferred"}
            >
              <AppAvailabilityGate availability={appAvailability}>
                <DeploymentCapabilityGate
                  profile={deployment.profile}
                  runtimeRole={runtimeRole}
                  cloudUrl={cloudUrl}
                >
                  <AssistantLinkProvider enabled={features.ai_assistant === true}>
                    {children}
                  </AssistantLinkProvider>
                </DeploymentCapabilityGate>
              </AppAvailabilityGate>
            </LocalOfflineShellGuard>
          ) : (
            <AppAvailabilityGate availability={appAvailability}>
              <DeploymentCapabilityGate
                profile={deployment.profile}
                runtimeRole={runtimeRole}
                cloudUrl={cloudUrl}
              >
                <AssistantLinkProvider enabled={features.ai_assistant === true}>
                  {children}
                </AssistantLinkProvider>
              </DeploymentCapabilityGate>
            </AppAvailabilityGate>
          )}
        </DashboardMain>
        </TenantAssistantFrame>
        </NavigationPendingProvider>
        </div>
        </BugReportProvider>
        </OfflineQueueProvider>
      </MoneyProvider>
    </LockProvider>
  );
}
