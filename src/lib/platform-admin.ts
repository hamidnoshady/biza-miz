/**
 * Phase 15 — what each platform-admin role may do.
 *
 * Answering open question 3 (differentiated platform roles): one level is not
 * enough. The console has surfaces of very different danger, and reserving the
 * dangerous ones for the most trusted operators is cheaper than trusting every
 * admin equally.
 *
 *   - support  — the day-to-day desk. Reads everything, and may enter a
 *     business *read-only* to see what a customer sees. Changes nothing.
 *   - engineer — support, plus the write side of operations: feature flags,
 *     suspend/reactivate, system/job controls. Cannot provision, cannot
 *     hard-delete, cannot take full-access control of a business.
 *   - owner    — the whole console: provisioning, archive/hard-delete, granting
 *     full-access impersonation, and managing other platform admins.
 *
 * This module is pure — the single place the role→capability mapping lives, so
 * it can be unit-tested directly and both the API guard and the console UI ask
 * the same question and get the same answer.
 */
import type { PlatformAdminRole } from "./platform-auth-edge";

export type { PlatformAdminRole };

export const PLATFORM_ADMIN_ROLES: PlatformAdminRole[] = ["support", "engineer", "owner"];

/** Every discrete thing the console can do, gated independently of the pages. */
export type PlatformCapability =
  // Read surfaces
  | "businesses.read"
  | "business.reports.read"
  | "audit.read"
  | "system.read"
  | "usage.read"
  | "ai.read"
  // Operational writes
  | "features.write"
  // Migration 0132, split by issue #807. The single `backup.manage` capability
  // gave whoever held it custody of a complete copy of every tenant's data:
  // changing the S3 destination, minting peer tokens that hand the dump to
  // another server, and running the whole-database dump. Those are three
  // different trusts, so they are three (well, six) capabilities now:
  //
  //   backup.read        health, run history, artifact lists — any admin role
  //   backup.run         take a whole-system backup now
  //   backup.verify      verify an artifact into a scratch database
  //   backup.configure   schedule, directories, destinations, passphrase
  //   backup.share       serving toggle + peer tokens (custody of the dump)
  //   backup.peer.manage add/edit/delete the servers this install pulls from
  //   backup.restore     destructive apply — owner only, always
  //
  // `backup.manage` is retained as the *operational* alias (read + run +
  // verify) so existing routes and expectations that meant "operate the backup
  // system day to day" keep working, and so no engineer loses the work they
  // could do before. It deliberately no longer implies configure/share, and it
  // never implied restore.
  /** @deprecated Use the specific backup.* capability; equals read+run+verify. */
  | "backup.manage"
  | "tenant_backup.read"
  // Issue #903 §10 — the tenant-backup surface is split by trust, exactly like
  // the platform backup capabilities above. Reading metadata is support work;
  // proving an artifact, fetching its bytes, restoring it and changing the
  // managed storage/price policy are four different trusts.
  | "tenant_backup.verify"
  | "tenant_backup.download"
  | "tenant_backup.restore"
  | "tenant_backup.policy"
  | "backup.read"
  | "backup.run"
  | "backup.verify"
  | "backup.configure"
  | "backup.share"
  | "backup.peer.manage"
  // Migration 0139 — administering the website platform (eshobe-cms) from this
  // console: its address and platform key, a site's lifecycle, issuing and revoking
  // site keys, and syncing content in either direction. An engineer holds it for the
  // same reason they hold `backup.manage`: keeping the fleet's websites serving is
  // ordinary operations, and the alternative is an operator opening the CMS's own
  // admin on another host, where nothing this console does is audited. Reading the
  // CMS report rides `system.read` — knowing that four domains are unverified is not
  // privileged information.
  | "cms.manage"
  | "business.suspend"
  // Platform billing: credit packages, plan builder, wallet
  // grants and payment approval.
  | "billing.manage"
  // Billing (migration 0176) — the fine-grained split of `billing.manage`
  // demanded by the Billing Control Center. Granted today to exactly the
  // roles that hold `billing.manage` (engineer + owner), so splitting the
  // vocabulary changes no one's access — it only lets a future grant hand a
  // desk one slice of the console (e.g. payments review without price
  // policy). `billing.view` is the read half: every admin role holds it,
  // matching the reads that previously required only a login.
  | "billing.view"
  | "plans.manage"
  | "payments.review"
  | "gateways.manage"
  | "adjustments.manage"
  // Messaging (migration 0137+): SMS/Email provider credentials, rates, credit
  // packages and top-up approval. Its own capability rather than riding
  // `billing.manage` so the messaging desk is not coupled to the payments
  // console; granted to the same roles, so no operator loses access.
  | "messaging.manage"
  // Media (migration 0149): the tenant object-storage connection, storage
  // pricing and AI image-enhancement pricing. Its own capability rather than
  // riding `backup.manage` (which is about the deployment's database backup, a
  // different domain); granted to the same roles.
  | "media.manage"
  // Security (migration 0140s): MFA policy/enforcement, grace extensions and the
  // Kavenegar OTP provider. Its own capability rather than riding
  // `system.read`; the write side needs a real boundary.
  | "security.manage"
  // Issue #1041 — data retention and automatic destruction policy. It can
  // delete a business's operational data after a disable, so it is a
  // destructive capability: owner only, never borrowed from `billing.manage`.
  | "retention.manage"
  // Owner-only business data operations
  | "business.edit"
  | "business.reset"
  // Learning content: the per-section knowledge-base URLs every business's
  // «آموزش» modal opens.
  | "knowledge.manage"
  // The support desk (migration 0130): reading and answering every business's
  // support tickets. Given to every admin role — answering tickets is the
  // `support` role's whole job, and there is no read-only half worth
  // separating: the console's ticket page is read surfaces plus the reply box,
  // and every write is audited.
  | "support.manage"
  // Issue #984 — the standalone Windows diagnostics companion is gated
  // separately from the ticket desk. Holding `support.manage` (or viewing a
  // ticket, changing an assignment, or holding an impersonation session)
  // grants NONE of these: device execution and remote control need their own
  // authority, checked on every action, download, viewer admission and lease
  // renewal — never just hidden buttons.
  //
  //   support.context.read      requester/business/installation/health context
  //   support.diagnostics.request  request diagnostics from a ticket
  //   support.reports.read      view/download redacted reports + artifacts
  //   support.repair.propose    propose an approved catalog repair
  //   support.repair.execute    execute an approved repair (owner only)
  //   support.assist.view       request/join remote view
  //   support.assist.control    request/join remote control (owner only)
  //   support.assist.revoke     revoke/end a remote session
  //   support.repair.publish    publish/manage repair catalog policy (owner only)
  //   support.token.issue       generate on-site access tokens (+recent MFA)
  //   support.ai.use            use Support AI in ticket/companion
  //   support.ai.configure      publish support model profiles (owner only)
  | "support.context.read"
  | "support.diagnostics.request"
  | "support.reports.read"
  | "support.repair.propose"
  | "support.repair.execute"
  | "support.assist.view"
  | "support.assist.control"
  | "support.assist.revoke"
  | "support.repair.publish"
  | "support.token.issue"
  | "support.ai.use"
  | "support.ai.configure"
  // Impersonation, split by blast radius
  | "impersonate.readOnly"
  | "impersonate.controlled"
  | "impersonate.full"
  | "impersonate.revoke"
  | "impersonate.extend"
  // …but *replacing this server's entire database* with another server's is not
  // an operations task: it is the one console action that can destroy more data
  // than deleting every business on the platform, so it needs `backup.restore`,
  // which no role but owner holds.
  | "backup.restore"
  // Owner-only halves of the split above: custody of the destination and of the
  // credentials that hand a full copy of every tenant's data to another machine
  // (#807). Named here rather than left implicit so a reviewer sees the split.
  | "backup.configure"
  | "backup.share"
  | "backup.peer.manage"
  // Owner-only, most dangerous
  | "business.provision"
  | "business.archive"
  | "business.delete"
  | "admins.manage"
  // Owner-only — holds real platform secrets and price policy.
  | "updates.manage"
  | "ai.config.manage";

const READ: PlatformCapability[] = [
  "businesses.read",
  "business.reports.read",
  "audit.read",
  "system.read",
  "usage.read",
  "ai.read",
  // Backup reads ride with every admin role (issue #807): "was last night's
  // copy taken?" is a question the support desk must answer without being able
  // to change a destination or start a destructive restore.
  "backup.read",
  // Metadata only; grants neither archive export nor any tenant mutation.
  "tenant_backup.read",
  // Billing reads (rates, invoices, subscription state) ride along for every
  // role — exactly what the billing GET routes allowed when they only checked
  // a login.
  "billing.view",
];

/** The billing-write split — held by every role that holds `billing.manage`. */
const BILLING_WRITE: PlatformCapability[] = [
  "billing.manage",
  "plans.manage",
  "payments.review",
  "gateways.manage",
  "adjustments.manage",
];

/**
 * The capabilities each role holds. Higher roles are supersets of lower ones,
 * spelled out rather than inherited so a reviewer sees exactly what each role
 * can do without tracing an inheritance chain.
 */
const CAPABILITIES: Record<PlatformAdminRole, PlatformCapability[]> = {
  // Issue #984: the desk reads ticket context and redacted reports; it
  // cannot request diagnostics, issue tokens or touch remote control.
  support: [...READ, "support.manage", "impersonate.readOnly", "support.context.read", "support.reports.read"],
  engineer: [
    ...READ,
    "support.manage",
    "impersonate.readOnly",
    "impersonate.controlled",
    "features.write",
    "business.suspend",
    ...BILLING_WRITE,
    "impersonate.revoke",
    "impersonate.extend",
    "knowledge.manage",
    // Issue #984: operate diagnostics, propose repairs, view-only remote
    // assistance (with customer consent + lease), issue on-site tokens (with
    // recent MFA, enforced at the route) and use Support AI. Repair
    // execution, remote control, catalog publishing and AI profile
    // management stay owner-only.
    "support.context.read",
    "support.reports.read",
    "support.diagnostics.request",
    "support.repair.propose",
    "support.assist.view",
    "support.assist.revoke",
    "support.token.issue",
    "support.ai.use",
    // Issue #807: an engineer runs and verifies backups (operational work) but
    // does not configure destinations, mint sharing tokens, or restore.
    "backup.manage",
    "backup.run",
    "backup.verify",
    // Issue #903 §10: an engineer may re-prove a tenant artifact (checksum,
    // signature, archive parse) — that repairs trust. Taking a copy of a
    // tenant's data, restoring over it, or changing where the fleet stores
    // backups are not engineer work.
    "tenant_backup.verify",
    "cms.manage",
    // Messaging and media are operational, granted at the same level as the
    // capabilities they used to ride (billing.manage / backup.manage).
    "messaging.manage",
    "media.manage",
  ],
  owner: [
    ...READ,
    "support.manage",
    // Issue #984: the owner holds the whole companion surface, including
    // repair execution, remote control, catalog publishing, token issuance
    // and Support AI configuration.
    "support.context.read",
    "support.reports.read",
    "support.diagnostics.request",
    "support.repair.propose",
    "support.repair.execute",
    "support.assist.view",
    "support.assist.control",
    "support.assist.revoke",
    "support.repair.publish",
    "support.token.issue",
    "support.ai.use",
    "support.ai.configure",
    "impersonate.readOnly",
    "impersonate.controlled",
    "features.write",
    "business.suspend",
    ...BILLING_WRITE,
    "impersonate.revoke",
    "impersonate.extend",
    "knowledge.manage",
    "backup.manage",
    "backup.run",
    "backup.verify",
    "backup.configure",
    "backup.share",
    "backup.peer.manage",
    "cms.manage",
    "messaging.manage",
    "media.manage",
    "security.manage",
    "backup.restore",
    // Issue #903 §10 — the tenant-backup counterparts, owner-only: downloading a
    // tenant's artifact, applying a tenant restore, and setting the managed
    // storage + pricing policy the whole fleet is billed under.
    "tenant_backup.verify",
    "tenant_backup.download",
    "tenant_backup.restore",
    "tenant_backup.policy",
    "impersonate.full",
    "business.provision",
    "business.archive",
    "business.delete",
    "retention.manage",
    "business.edit",
    "business.reset",
    "admins.manage",
    "updates.manage",
    "ai.config.manage",
  ],
};

export function platformCan(role: PlatformAdminRole, capability: PlatformCapability): boolean {
  return CAPABILITIES[role]?.includes(capability) ?? false;
}

/**
 * The full capability list a role holds — what `auth/me` ships to the console
 * so the UI hides controls the operator could not use anyway. The server still
 * re-checks every write with `platformCan`; this is only to keep the UI honest.
 */
export function CAPABILITIES_FOR(role: PlatformAdminRole): PlatformCapability[] {
  return [...(CAPABILITIES[role] ?? [])];
}


/** Persian labels for the platform-admin roles, for the console UI. */
export const PLATFORM_ROLE_LABELS: Record<PlatformAdminRole, string> = {
  support: "پشتیبانی",
  engineer: "مهندس",
  owner: "مدیر ارشد",
};

/**
 * How long an impersonation window may last, in minutes. Deliberately short:
 * support access is for a specific look, not a standing seat inside a business.
 * Requested longer than this is clamped to it.
 */
export const MAX_IMPERSONATION_MINUTES = 60;
export const DEFAULT_IMPERSONATION_MINUTES = 30;

/**
 * What a `controlled` support session may actually do inside a tenant.
 *
 * Only diagnostic-and-retry verbs: a controlled session exists to look at a
 * problem and shake it loose, not to change a customer's books, and this list is
 * the whole of its authority.
 *
 * Issue #755 §20: this used to be `CONTROLLED_SUPPORT_CAPABILITIES`, a nine-
 * entry list nothing read, while the impersonation route carried its own
 * five-entry inline copy that was the one actually passed to
 * `startImpersonation`. The two had already drifted — the dead copy named
 * `connection.reconnect`, `media.reprocess` and `cache.refresh`, which no
 * controlled session was ever granted. The live five are what this is now, so
 * there is one list, it is enforced, and its name says what it governs. (The
 * dead copy is not "restored": widening a support session's reach is a security
 * decision, not a cleanup.)
 */
export const CONTROLLED_SESSION_CAPABILITIES = [
  "printer.test",
  "connection.test",
  "sync.retry",
  "integration.test",
  "diagnostics.run",
] as const;

export function clampImpersonationMinutes(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_IMPERSONATION_MINUTES;
  }
  return Math.min(Math.floor(requested), MAX_IMPERSONATION_MINUTES);
}

/**
 * The two destructive business actions that demand a typed confirmation.
 * Kept as one vocabulary so the client and the server build the *same*
 * phrase from the *same* helper — the old fixed `delete-me` constant was
 * duplicated between the panel and the route (two copies of one magic
 * literal) and could not tell a factory reset apart from a hard delete.
 */
export type DestructiveBusinessAction = "reset" | "delete";

const DESTRUCTIVE_PHRASE_VERBS: Record<DestructiveBusinessAction, string> = {
  reset: "RESET",
  delete: "DELETE",
};

/**
 * The exact phrase an operator must type to confirm a destructive business
 * action: `RESET {slug}` for a factory reset, `DELETE {slug}` for a hard
 * delete. The phrase is action-specific *and* target-specific — it names the
 * verb and the exact tenant it applies to, so a confirmation typed for one
 * action or one business can never authorize another. The slug is the stable
 * Latin identifier (the Persian display name would be tedious and ambiguous
 * to retype exactly). The server compares against this function's output —
 * never against a literal of its own — so the phrase can never drift
 * between the dialog and the route (issue #822).
 */
export function businessDestructivePhrase(
  action: DestructiveBusinessAction,
  slug: string,
): string {
  return `${DESTRUCTIVE_PHRASE_VERBS[action]} ${slug}`;
}
