# Markdown inventory under `docs/`

Every markdown file under `docs/` (recursively), excluding `docs/design/visual/` and
`docs/mcp/`. 136 files. Line counts are the exact output of `wc -l` for each file.

| Path | Lines | What it is for |
| --- | --- | --- |
| `docs/accounting-overview-kpis.md` | 47 | Defines every KPI tile on the Accounting overview page (`/accounting/overview`) with its exact integer-Rial calculation, as-of cutoff and exclusion rules. |
| `docs/accounting-terminology.md` | 55 | Standard Persian accounting glossary (گروه، کل، معین، تفصیلی …) plus a checklist to run before changing any accounting-adjacent UI copy. |
| `docs/accounting-workspace-ia.md` | 337 | The route and navigation contract for the Accounting workspace, including the canonical route map and the legacy-URL redirect table. |
| `docs/ai-gateway-secret-cutover-operator-checklist.md` | 330 | Copy-paste operator procedure (issue #757) for applying the AI gateway secret-cutover migration on a live Coolify deployment, with stop conditions and the evidence to keep per step. |
| `docs/ai-operating-layer/AI_BILLING_ARCHITECTURE.md` | 164 | Historical record of the migration-0168 single-billing cutover, kept for the Rial settlement invariants it states. |
| `docs/ai-operating-layer/PHASE_A_AUDIT.md` | 1247 | Historical audit of the AI operating layer and the migration map it proposed, superseded by the LiteLLM-only consolidation. |
| `docs/ai-subsystem-architecture.md` | 311 | Current ownership map of the AI subsystem — prompt resolution, tool narrowing, the LiteLLM call and the tool loop — and the boundaries between its parts. |
| `docs/android-runtime.md` | 394 | Describes the Android Trusted Web Activity shell, its versioned native bridge contract and the capabilities still gated on external prerequisites. |
| `docs/app-boundaries.md` | 39 | Defines the platform's four standalone business apps and exactly what each one owns, per the `src/lib/apps.ts` registry. |
| `docs/audits/934-connections-hub.md` | 206 | Audit of the connections hub (issue #934): the authorization contract per surface, the findings and the hardening applied with its tests. |
| `docs/auth-hardening-854.md` | 732 | Map of the auth and account-hardening pass (#854): each security invariant, where it is enforced today and the items deliberately deferred. |
| `docs/authorization-architecture.md` | 93 | The tenant authorization decision flow and how tenant, membership, role presets, individual grants and revocations are evaluated. |
| `docs/authorization/ARCHITECTURE.md` | 276 | Reference description of the authorization decision chain (identity → tenant → role → overrides → scope → context → resource policy) that `src/lib/auth.ts` and `authorize.ts` implement. |
| `docs/authorization/RECONCILIATION.md` | 213 | Inventory and canonical decision for reconciling the two parallel permission-catalogue refactors, stated as the prerequisite for touching `permissions.ts`. |
| `docs/backup-restore.md` | 388 | Runbook for how backups work and how to restore a location's database from a local or cloud artifact. |
| `docs/commission-release-verification.md` | 171 | Release-verification record for the commission work (#869) that separates implementation from acceptance, publication and deployment — all still blocked. |
| `docs/commission-settlement.md` | 386 | How commission settlement runs are grouped from accruals and then approved, paid out, reversed and closed, with a code map. |
| `docs/crm-architecture.md` | 609 | How the CRM app is built: what it owns and the rules it follows, each with the failure that produced it. |
| `docs/crm-engineering-report.md` | 135 | Engineering report on the CRM build — verified bugs found and fixed, and which documentation claims were checked against the code. |
| `docs/crm-relationship-os.md` | 534 | States what a member is supposed to be able to do with the CRM and where each of those answers comes from in the code. |
| `docs/data-transfer-engine.md` | 352 | Map of the universal import/export engine (upload → analyse → map → validate → preview → perform) and its entity registry, plus what is still missing. |
| `docs/deployment-architecture.md` | 45 | Describes the implemented runtime: deployment profiles (cloud/hybrid/local), runtime roles, capability gating and data ownership. |
| `docs/deployment-engineering-report.md` | 45 | Engineering report on the deployment-profile work, with a KEEP/REFACTOR/MERGE/MIGRATE disposition for each subsystem. |
| `docs/deployment-local-network.md` | 148 | Retired Komodo + Traefik recipe for running the POS on a cafe's own local network, kept for anyone still on that stack. |
| `docs/design-system.md` | 720 | The normative visual canon — colours, component recipes, states, motion and a decision guide mapping each UI need to the one approved component. |
| `docs/design/PR-description.md` | 158 | The design-system PR write-up explaining why the four tenant apps needed one shared language above and inside the card, and what changed. |
| `docs/design/coverage-matrix.md` | 138 | Measured audit of every tenant-facing area against the reference screenshots, with each area's gaps and migration priority. |
| `docs/design/reference/archive-2026-09/README.md` | 27 | Explains why the pre-2026-09 reference screenshots are kept and that they are historical rather than normative. |
| `docs/design/removed-legacy-code.md` | 69 | Inventory of every legacy design element deleted, with the check that proved each one unused or superseded. |
| `docs/design/test-results.md` | 440 | Recorded automated-suite, build and visual-comparison results with the commands that produced them, plus the remaining deviations. |
| `docs/design/visual-regression.md` | 268 | How the visual regression check renders representative screens of the four apps against committed baselines, and the rules around re-recording them. |
| `docs/desktop-updates-coolify.md` | 232 | Operator runbook for publishing a signed Desktop release through the existing Coolify deployment and the GitHub release pipeline. |
| `docs/desktop-updates.md` | 167 | The desktop release and update lifecycle: SemVer identity, the signed build/promote pipeline, Central registration and channel rollout. |
| `docs/engineering/dead-code-cleanup.md` | 417 | Repository-wide dead and unreachable code audit, with the confirmed removals and how each was verified. |
| `docs/engineering/issue-825-verification.md` | 174 | Implementation and verification record for the receivables audit (#825), historical through a pinned commit. |
| `docs/engineering/issue-825-visual-accessibility.md` | 170 | Follow-up record for the visual and modal-accessibility findings on #825, on the same branch. |
| `docs/engineering/issue-868-ownership.md` | 106 | Records which repository owns what data, which side is ledger authority and which remaining items need product decisions. |
| `docs/eshobe-cms-integration.md` | 538 | The contract and setup steps for connecting this app to the separate eshobe-cms (Payload 3) website platform over REST. |
| `docs/inventory-visual-count.md` | 123 | Design of visual stock counting by phone camera — classical computer vision first, metered AI tagging as an explicit second step. |
| `docs/issue-947-integration-contracts.md` | 138 | Names the seams between #947's Team consolidation and its neighbours #854 and #916, what each side owns and the tests that hold the contract. |
| `docs/issues-drafts/periodic-followups.md` | 133 | Draft GitHub issues for the remaining inventory-costing methods left after Phase 43, meant to be filed verbatim and then deleted. |
| `docs/knowledge-base.md` | 165 | Describes the in-product Persian knowledge base (45 seeded guides) together with its super-admin editorial console and data model. |
| `docs/local-to-hybrid-conversion.md` | 57 | Operator-assisted two-phase runbook for converting a Local install to Hybrid without resetting or auto-merging its database. |
| `docs/network-printer-wifi-extender.md` | 199 | How to put a LAN-only receipt printer on WiFi through a range extender's LAN port so the till always reaches a stable IP. |
| `docs/notifications-audit-931.md` | 223 | Implementation and rollout record of the notifications audit (#931): push-endpoint security, the event outbox, rules and tenant RLS. |
| `docs/openobserve.md` | 268 | Operations manual for switching on the optional OpenObserve fleet-monitoring integration behind the super-admin console's monitoring tab. |
| `docs/parspack-deployment.md` | 143 | Retired ParsPack Compose deployment walkthrough, kept for anyone still running that shape of stack. |
| `docs/parties-directory-audit.md` | 455 | Audit and fixes for the shared «اشخاص» parties directory, covering the section components and the helper modules they read. |
| `docs/payroll-engine.md` | 154 | The statutory payroll engine (#865) layered on top of journal-level payroll, with its source map and the guards against double booking. |
| `docs/payroll.md` | 475 | How journal-level payroll turns standing pay terms into gross-to-net lines, books and settles them, and recovers salary advances. |
| `docs/performance-audit-2026-09.md` | 193 | Measured platform and application performance audit for Shahrivar 1405 / September 2026, including the bench used and its findings. |
| `docs/phases/Phase-0-Foundation.md` | 44 | Phase 0 record: the working skeleton — schema, auth, role and multi-location scaffolding, and the RTL shell. |
| `docs/phases/Phase-1-Setup-Wizard.md` | 68 | Phase 1 record: the guided setup wizard that configures a fresh install end to end with no manual DB edits. |
| `docs/phases/Phase-10-Backup-System.md` | 79 | Phase 10 record: local and encrypted offsite cloud backups per location, with scheduling and a manual trigger. |
| `docs/phases/Phase-11-Delivery-Post-V1.md` | 59 | Phase 11 record: turning delivery into a real order type with couriers and a dispatch UI. |
| `docs/phases/Phase-12-Multi-Business-Tenancy.md` | 170 | Phase 12 record: global identities, per-business memberships, tenant RLS and the separate super-user realm. |
| `docs/phases/Phase-13-Teams-Permissions.md` | 58 | Phase 13 record: invitations, member management, per-member permission overrides and branch assignment. |
| `docs/phases/Phase-14-Multi-Location-Per-Business.md` | 55 | Phase 14 record: several branches per business with a branch switcher, provisioning and consolidated reporting. |
| `docs/phases/Phase-15-Super-Admin-Console.md` | 73 | Phase 15 record: the separate platform-admin realm with business lifecycle, plans and audited impersonation. |
| `docs/phases/Phase-16-Accounting-Suite.md` | 76 | Phase 16 record: fiscal periods, financial statements and AR/AP subledgers that make the ledger closable. |
| `docs/phases/Phase-17-Feature-Gating-Hardening.md` | 85 | Phase 17 record: enforcing entitlements and plan limits, proving tenant isolation and adding per-tenant backup/export. |
| `docs/phases/Phase-18-AI-Platform-Administration-Credit-Billing.md` | 155 | Historical Phase 18 record of AI platform administration and credit billing, superseded by the LiteLLM-only design. |
| `docs/phases/Phase-18b-AI-Agent-Capability-Expansion.md` | 316 | Phase 18b record: widening the assistant's read tools, action catalogue and role-scoped variants across every module. |
| `docs/phases/Phase-19-Public-API-Webhooks.md` | 220 | Phase 19 record: the scoped, bearer-token public API and sub-app webhooks for external integrations. |
| `docs/phases/Phase-2-Menu-Cashier-Order-Flow.md` | 62 | Phase 2 record: menu CRUD and the cashier POS ordering flow that produces correct order records. |
| `docs/phases/Phase-20-Employee-Secure-Identity.md` | 914 | Phase 20 record: per-employee revocable sessions, a credential model that grows past PIN, and attributable POS auditing. |
| `docs/phases/Phase-21-Multi-Industry-Accounting-Platform.md` | 799 | Phase 21 record: turning the F&B POS into a multi-industry accounting platform, starting with jewelry, watch and accessories. |
| `docs/phases/Phase-22-Accounting-Standards-Compliance-Gap-Analysis.md` | 793 | Phase 22 record: Wave 1's audit and gap analysis of accounting-standards compliance and per-industry chart coverage. |
| `docs/phases/Phase-23-Subdomain-Tenancy.md` | 537 | Phase 23 record: per-business subdomains, environment-aware sync and typable sync tokens. |
| `docs/phases/Phase-23-WooCommerce-Integration.md` | 142 | Phase 23 record: the two-way WooCommerce integration epic — orders, customers, stock, money posting, retries and reconciliation. |
| `docs/phases/Phase-24-Security-Hardening-Data-Protection.md` | 912 | Phase 24 record: security headers, login lockout, MFA, VPN/LAN HTTPS and a Postgres-backed rate limiter, with an honest shipped-versus-designed status note. |
| `docs/phases/Phase-25-Industry-Separation.md` | 258 | Phase 25 record: making the business type a real product boundary, one wave per sub-issue. |
| `docs/phases/Phase-26-Holoo-Interoperability.md` | 267 | Phase 26 record: Holoo migration and companion-mode interoperability. |
| `docs/phases/Phase-27-Cosmetics-And-Per-Trade-Specialization.md` | 376 | Phase 27 record: cosmetics and toiletries support plus a specialized identity for every trade. |
| `docs/phases/Phase-28-Connections-Hub-And-WordPress-Plugin.md` | 196 | Phase 28 record: the connections hub, the desktop pairing repair and the WordPress plugin, starting from a reported failure. |
| `docs/phases/Phase-29-In-House-Production.md` | 156 | Phase 29 record: two-level recipes so a business can produce items in-house instead of only buying them. |
| `docs/phases/Phase-3-Table-Management-Reservations.md` | 100 | Phase 3 record: the real floor plan, table state machine and reservations that replace the Phase 2 table stub. |
| `docs/phases/Phase-30-Missing-Account-Headings-And-Cheques.md` | 196 | Phase 30 record: filling the missing chart-of-accounts headings across industry templates and adding cheques. |
| `docs/phases/Phase-31-AI-Autopilot.md` | 175 | Phase 31 record: owner-set guardrails letting the assistant apply changes unattended, with an audit trail and undo. |
| `docs/phases/Phase-32-AI-Coworker.md` | 232 | Phase 32 record: standing instructions that let the assistant hold a job the owner already knows (the AI coworker). |
| `docs/phases/Phase-33-Assistant-Usability.md` | 110 | Phase 33 record: fixing the assistant's chat surface and grounding after reproduced complaints from an owner using a phone. |
| `docs/phases/Phase-34-MCP-Connector.md` | 264 | Phase 34 record: the MCP connector that lets an owner's own AI client ask about their business. |
| `docs/phases/Phase-35-Notifications.md` | 262 | Phase 35 record: reaching a person who is not at a screen through rules, push delivery and an inbox. |
| `docs/phases/Phase-36-App-Ecosystem.md` | 272 | Historical Phase 36 record of the app ecosystem, with a correction noting the local vector/cache stack was later retired. |
| `docs/phases/Phase-36b-Growth-Marketing-App.md` | 224 | Phase 36b record: building the Growth & Marketing app out of what had been three flat sidebar pages. |
| `docs/phases/Phase-36c-CRM-App.md` | 247 | Phase 36c record: building the CRM app for issue #367, including its two stated departures from that issue. |
| `docs/phases/Phase-37-LiteLLM-Gateway.md` | 41 | Historical Phase 37 record of the LiteLLM gateway, kept with its current LiteLLM-only state summarized. |
| `docs/phases/Phase-37-Messaging.md` | 115 | Phase 37 (37b) record: SMS/email marketing to CRM segments, metered on the platform and posted to the business ledger. |
| `docs/phases/Phase-38-Website-Manager.md` | 195 | Phase 38 (38w) record: the website manager waves that complete the Eshobe CMS content path. |
| `docs/phases/Phase-38-WooCommerce-Catalogue-And-Store-Ops.md` | 308 | Phase 38 record: the WooCommerce catalogue model a real store has and operating the store from the app. |
| `docs/phases/Phase-38b-LiteLLM-Platform.md` | 43 | Historical Phase 38b record of LiteLLM usage-cost capture and spend reconciliation against the Rial ledger. |
| `docs/phases/Phase-39-LiteLLM-Only-AI-Platform.md` | 162 | Phase 39 record: LiteLLM as the only provider, its ownership, and the secret-cutover rollout that completion requires. |
| `docs/phases/Phase-4-Waiter-Kitchen-RealTime-Sync.md` | 97 | Phase 4 record: the waiter app and kitchen display with real-time order sync over the local network. |
| `docs/phases/Phase-40-App-Ownership-And-WP-Manager.md` | 119 | Phase 40 record: explicit app ownership boundaries, the Growth customer projection and the standalone WP Manager. |
| `docs/phases/Phase-41-Shared-Party-Record.md` | 145 | Phase 41 record: one shared `parties` record replacing the per-app customer, supplier and staff tables. |
| `docs/phases/Phase-42-Warehouse-Module.md` | 86 | Phase 42 record: reorganising the F&B inventory workspace around the warehouse's menu and adding warehouse documents and per-warehouse levels. |
| `docs/phases/Phase-42b-Retail-Warehouse-Module.md` | 164 | Phase 42b record: applying the same warehouse module shape to the retail stock model. |
| `docs/phases/Phase-43-Periodic-Inventory-System-LIFO.md` | 82 | Phase 43 record (in Persian): adding perpetual-versus-periodic inventory and LIFO as a third costing method to the setup wizard. |
| `docs/phases/Phase-44-Hybrid-Sync-Completeness.md` | 91 | Phase 44 record: fixing the Hybrid event transport and closing the data-coverage gaps between a paired desktop and the cloud. |
| `docs/phases/Phase-45-Cloud-Primary-Hybrid.md` | 202 | Phase 45 record: making the cloud the system of record and the paired desktop the till only. |
| `docs/phases/Phase-46-Desktop-Full-Suite.md` | 76 | Phase 46 record: putting the full suite back into one desktop window after Phase 45's till-only menu and second window. |
| `docs/phases/Phase-47-AEC-Industry-And-Project-Operations.md` | 875 | Phase 47 record: the AEC business type and its project operations across waves 1–11, with the two deliberate limits. |
| `docs/phases/Phase-5-Offline-Queue-Hardware.md` | 102 | Phase 5 record: the client-side offline queue plus receipt/kitchen printing and cash-drawer hardware. |
| `docs/phases/Phase-6-Inventory.md` | 79 | Phase 6 record: recipe-based stock deduction and correct COGS under FIFO or weighted average. |
| `docs/phases/Phase-7-Double-Entry-Ledger.md` | 78 | Phase 7 record: auto-posted, always-balanced double-entry journal entries for every business event. |
| `docs/phases/Phase-8-Reporting-Analytics-Engine.md` | 149 | Phase 8 record: reporting views, the report builder and pinned dashboard widgets. |
| `docs/phases/Phase-9-Multi-Location-Rollup-Polish.md` | 85 | Phase 9 record: cross-location sync to a central view, plus the hardening and performance polish before v1. |
| `docs/phases/Phase-G-My-Workspace.md` | 337 | Phase G development plan, written before the code, for the «میز کار من» My Workspace project workspace. |
| `docs/phases/README.md` | 127 | The phase index: every phase file in reading order with its status. |
| `docs/platform-billing.md` | 143 | The super-admin billing system: per-business credit wallets, Zarinpal top-ups and the plan builder that prices each function. |
| `docs/platform-business-reporting.md` | 213 | The superadmin business reporting surface (#810): its route boundary, the read-only capability it requires and its query rules. |
| `docs/platform-company-route-inventory.md` | 79 | Classifies every route in the Platform Business surface as active or dead with the evidence per row, pinned by a route-guard test. |
| `docs/platform-company-workspace.md` | 371 | Architecture of the platform's own internal business: the singleton ownership marker, the setup initializer and its entitlements. |
| `docs/pos-overhaul-report.md` | 272 | Report on the POS overhaul — what changed, the quoted command output behind each claim, and what was explicitly not tested. |
| `docs/printing.md` | 613 | The printing section: the data-defined template model, the single renderer and the gallery behind receipts, invoices, kitchen tickets and labels. |
| `docs/production-deployment-verification.md` | 108 | How to prove a production rollout is actually running the newly built image, using the build SHA exposed at `/api/health`. |
| `docs/retail-batch-inventory.md` | 85 | Records the canonical retail batch-allocation path (FEFO, exact batch COGS, roll-up) that every retail channel goes through. |
| `docs/runbooks/media-storage-operations.md` | 56 | Operations runbook for the platform-wide S3-compatible media library, starting from its isolation invariants. |
| `docs/server-migration.md` | 409 | How to move a whole running install to another server: universal data steps plus a per-platform hosting recipe to pick from. |
| `docs/server-sync.md` | 577 | Site-to-cloud synchronization: the supported event catalog, the cloud-primary split and how a paired desktop behaves. |
| `docs/standalone-desktop-app.md` | 333 | The Windows standalone Business Suite: Electron packaging, embedded PostgreSQL and its startup orchestration. |
| `docs/superpowers/plans/2026-08-03-desktop-first-run-wizard.md` | 3813 | Task-by-task implementation plan for the Electron desktop first-run wizard that chooses between a local business and pairing. |
| `docs/superpowers/plans/2026-08-11-edit-delete-addon-groups.md` | 165 | Implementation plan for inline edit and delete of add-on (modifier) groups, kept as a historical record of the pre-move paths. |
| `docs/superpowers/plans/2026-08-11-inventory-search.md` | 506 | Implementation plan for Persian-aware, client-side inventory item search across the list and the form pickers. |
| `docs/superpowers/plans/2026-09-30-cloud-primary-hybrid.md` | 2234 | Implementation plan for cloud-primary Hybrid mode, where only the till screens render locally on a paired desktop. |
| `docs/superpowers/specs/2026-08-03-desktop-first-run-wizard-design.md` | 261 | Approved design spec for the desktop first-run wizard, with a note on its current industry-shaped step list. |
| `docs/superpowers/specs/2026-08-10-inventory-search-design.md` | 72 | Approved design for inventory search matching name, SKU or unit with no API or schema change. |
| `docs/superpowers/specs/2026-08-11-edit-delete-addon-groups-design.md` | 63 | Approved design for inline rename/edit/delete of modifier groups, written before menu management moved to `/accounting/menu`. |
| `docs/support-companion-runbooks.md` | 170 | Day-to-day operator runbooks for the ticket-workspace support flow of the Support Companion (issue #984). |
| `docs/support-companion.md` | 154 | Server-side operator guide for the Windows Support Companion: enrollment, device credentials and the pieces that live in this repo. |
| `docs/tax-invoicing.md` | 387 | Reference for the taxpayer invoicing workspace (سامانه مودیان) — the record lifecycle, database guarantees and the not-yet-live transmission status. |
| `docs/ui-conventions.md` | 209 | The dashboard composition rules — which primitives to use and how — paired with the pixel-level design canon. |
| `docs/vpn-only-deployment.md` | 31 | Recommends a zero-public-exposure VPN posture (WireGuard or Tailscale plus Caddy) for on-site installs. |
| `docs/warehouse-document-audit.md` | 203 | Persian audit of the warehouse receipt/issue document feature in both the F&B and retail implementations, listing each defect found with its fix. |
| `docs/wordpress-plugin-updates.md` | 203 | How the in-repo WooCommerce plugin is built, hosted and updated from its two possible update sources. |
| `docs/wp-manager-permissions.md` | 52 | The permission matrix every WP/Woo manager page, menu and API route stands behind (issue #944). |

Total: 38099 lines across 136 files.
