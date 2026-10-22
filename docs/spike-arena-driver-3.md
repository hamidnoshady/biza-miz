# Documentation inventory

| Path | Exact line count | Description |
| --- | ---: | --- |
| `docs/accounting-overview-kpis.md` | 47 | Defines the Accounting overview KPI calculations, periods, filters, visibility rules, and drill-down behavior. |
| `docs/accounting-terminology.md` | 55 | Standardizes Persian accounting vocabulary and provides a checklist for keeping accounting UI copy consistent. |
| `docs/accounting-workspace-ia.md` | 337 | Documents the Accounting workspace’s canonical routes, navigation composition, people directory, legacy redirects, and commission-settlement boundary. |
| `docs/ai-gateway-secret-cutover-operator-checklist.md` | 330 | Provides an operator checklist for backing up, migrating, verifying, and signing off the ciphertext-only AI gateway secret cutover. |
| `docs/ai-operating-layer/AI_BILLING_ARCHITECTURE.md` | 164 | Records the historical migration 0168 architecture for single-wallet AI billing, plan allowances, and LiteLLM virtual-key responsibilities. |
| `docs/ai-operating-layer/PHASE_A_AUDIT.md` | 1247 | Presents a historical codebase audit and phased migration map for the AI Operating Layer, including capability gaps and delivered follow-up work. |
| `docs/ai-subsystem-architecture.md` | 311 | Maps the current AI subsystem’s ownership boundaries, runtime modes, prompts, tools, memory, research, settlement, and permissions. |
| `docs/android-runtime.md` | 394 | Explains the Android Trusted Web Activity shell, native bridge, security model, device registry, offline behavior, testing, and release process. |
| `docs/app-boundaries.md` | 39 | Defines the four standalone business apps and the boundaries of their work areas and two Website Management managers. |
| `docs/audits/934-connections-hub.md` | 206 | Records the Connections Hub authorization and lifecycle audit, hardening work, regression investigations, verification, and support notes. |
| `docs/auth-hardening-854.md` | 732 | Maps issue #854 authentication and account hardening changes, security invariants, tests, limitations, and later profile and team audits. |
| `docs/authorization/ARCHITECTURE.md` | 276 | Provides the reference authorization decision chain for permissions, roles, branch scope, separate realms, tenant isolation, and tests. |
| `docs/authorization/RECONCILIATION.md` | 213 | Reconciles competing permission catalogues from parallel authorization branches into canonical semantic decisions and an implementation sequence. |
| `docs/authorization-architecture.md` | 93 | Describes tenant identities, memberships, effective permissions, scoped access, invitations, and offboarding alongside the separate platform-administration realm. |
| `docs/backup-restore.md` | 388 | Provides the backup and restore runbook for local and cloud artifacts, encryption keys, dry-run validation, whole-system recovery, and tenant exports. |
| `docs/commission-release-verification.md` | 171 | Records commission issue #869 release evidence, unresolved verification blockers, and the production operator handoff without treating merging as deployment. |
| `docs/commission-settlement.md` | 386 | Specifies immutable commission settlement runs, including calculation, review, approval, payout, reversal, reconciliation, permissions, and APIs. |
| `docs/crm-architecture.md` | 609 | Defines CRM ownership, cross-app boundaries, data models, transaction rules, consent, merging, automation, and testing invariants. |
| `docs/crm-engineering-report.md` | 135 | Reports verified CRM bug fixes, architectural changes, delivered features, test evidence, and known implementation gaps. |
| `docs/crm-relationship-os.md` | 534 | Describes member-facing CRM workflows across daily work, customer history, pipelines, health, data quality, and automations. |
| `docs/data-transfer-engine.md` | 352 | Documents the shared import/export engine, entity registry, upload-to-perform flow, APIs, UI, schema, tests, and remaining limitations. |
| `docs/deployment-architecture.md` | 45 | Describes implemented Cloud, Hybrid, and Local deployment profiles, process roles, authority, synchronization, pairing, backups, printing, and LAN behavior. |
| `docs/deployment-engineering-report.md` | 45 | Reports the deployment-profile implementation, subsystem decisions, authority and synchronization behavior, and validation evidence. |
| `docs/deployment-local-network.md` | 148 | Guides a Komodo and Traefik LAN deployment with HTTPS for POS clients, receipt printing, backups, and ongoing operations. |
| `docs/design/PR-description.md` | 158 | Summarizes the historical pull request that unified the four tenant apps around shared design-system primitives and visual verification. |
| `docs/design/coverage-matrix.md` | 138 | Audits tenant-facing screens against approved visual references and design primitives, with adoption coverage and migration priorities. |
| `docs/design/reference/archive-2026-09/README.md` | 27 | Explains the purpose and historical, non-normative status of the archived pre-2026-09 reference screenshots. |
| `docs/design/removed-legacy-code.md` | 69 | Inventories legacy design-code removals with evidence for each deletion and the reasons deliberate candidates were retained. |
| `docs/design/test-results.md` | 440 | Records observed automated, visual, and manual verification for the design-system work, including discovered bugs and remaining deviations. |
| `docs/design/visual-regression.md` | 268 | Guides running, reviewing, and extending deterministic visual-regression tests while protecting approved screenshot baselines. |
| `docs/design-system.md` | 720 | Defines the product’s normative visual canon for colour, typography, components, interaction states, motion, and design review. |
| `docs/desktop-updates-coolify.md` | 232 | Provides the operator runbook for publishing, verifying, rotating, and rolling back signed Desktop releases through Coolify and GitHub. |
| `docs/desktop-updates.md` | 167 | Describes the Desktop release and update lifecycle, SemVer identity, Central rollout policy, offline packages, recovery, and production configuration. |
| `docs/engineering/dead-code-cleanup.md` | 417 | Documents evidence-backed dead-code and unused-route cleanup decisions, retained candidates, regression coverage, and later AI and navigation addenda. |
| `docs/engineering/issue-825-verification.md` | 174 | Maps receivables issue #825 implementation and verification evidence, review corrections, ownership, query plans, and acceptance checks. |
| `docs/engineering/issue-825-visual-accessibility.md` | 170 | Records the issue #825 visual and accessibility follow-up, inspected images, corrections, build attempts, and verification results. |
| `docs/engineering/issue-868-ownership.md` | 106 | Defines issue #868 repository ownership, runtime ledger authority, coordinated contracts, deferred product decisions, and verification. |
| `docs/eshobe-cms-integration.md` | 538 | Defines the integration contract and setup between this platform and a separately deployed Eshobe CMS, including credentials, website management, orders, and failures. |
| `docs/inventory-visual-count.md` | 123 | Describes visual stock counting from cameras, photos, and video using classical computer vision, optional metered AI tagging, and explicit privacy limits. |
| `docs/issue-947-integration-contracts.md` | 138 | Defines the integration contracts between Team consolidation issue #947, identity propagation issue #854, and staff-eligibility issue #916. |
| `docs/issues-drafts/periodic-followups.md` | 133 | Contains draft GitHub issues for remaining inventory-costing methods and clarification of the current weighted-average terminology. |
| `docs/knowledge-base.md` | 165 | Describes the Persian in-product learning centre, member visibility, super-admin editing, APIs, starter content, and section-identity auditing. |
| `docs/local-to-hybrid-conversion.md` | 57 | Provides the two-phase operator runbook for converting Local to Hybrid without resetting data, including validation before deliberate sync activation. |
| `docs/network-printer-wifi-extender.md` | 199 | Guides connecting a LAN-only receipt printer through a WiFi extender, assigning a stable address, installing the connector, and diagnosing failures. |
| `docs/notifications-audit-931.md` | 223 | Records notification issue #931 implementation and rollout details for secure durable delivery, inboxes, rules, retention, and scope decisions. |
| `docs/openobserve.md` | 268 | Guides OpenObserve-based fleet monitoring for the super-admin console, including installation, ingestion checks, alerts, retention, and privacy. |
| `docs/parspack-deployment.md` | 143 | Provides a ParsPack Compose deployment walkthrough for the app, PostgreSQL, optional OpenObserve, images, environment, and tenancy choices. |
| `docs/parties-directory-audit.md` | 455 | Records the parties-directory audit and fixes for data correctness, races, permissions, accessibility, responsive layout, and UX copy. |
| `docs/payroll-engine.md` | 154 | Documents the statutory payroll engine’s authorization, workflow, lifecycle, calculations, accounting posting, reports, and completion evidence. |
| `docs/payroll.md` | 475 | Explains journal-level payroll from gross to net, monthly accrual and settlement, advances, commissions, audit history, permissions, and limitations. |
| `docs/performance-audit-2026-09.md` | 193 | Presents the measured September 2026 platform and CMS performance audit, benchmark failures, priorities, passing areas, and reproduction steps. |
| `docs/phases/Phase-0-Foundation.md` | 44 | Defines the foundation phase for the initial schema, authentication, multi-location scaffolding, and RTL shell before business features. |
| `docs/phases/Phase-1-Setup-Wizard.md` | 68 | Defines the guided eight-step setup wizard for configuring a fresh installation without manual database edits. |
| `docs/phases/Phase-10-Backup-System.md` | 79 | Defines the local and offsite cloud backup phase for recoverability, scheduling, retention, encryption, and restoration evidence. |
| `docs/phases/Phase-11-Delivery-Post-V1.md` | 59 | Defines the post-v1 delivery phase that activates couriers, delivery orders, statuses, and the corresponding user workflows. |
| `docs/phases/Phase-12-Multi-Business-Tenancy.md` | 170 | Defines the multi-business tenancy core with database isolation, multiple memberships per person, tenant roles, and a separate super-user realm. |
| `docs/phases/Phase-13-Teams-Permissions.md` | 58 | Defines owner-managed teams, invitations, permissions, branch assignments, and member removal without developer database changes. |
| `docs/phases/Phase-14-Multi-Location-Per-Business.md` | 55 | Defines multiple branches per business with branch-specific menus, stock, and tills plus consolidated operation where needed. |
| `docs/phases/Phase-15-Super-Admin-Console.md` | 73 | Defines the separately authenticated super-admin console for business provisioning, entitlements, health, and support. |
| `docs/phases/Phase-16-Accounting-Suite.md` | 76 | Defines and tracks the full accounting suite needed for professional statements, fiscal periods, and year-end closing. |
| `docs/phases/Phase-17-Feature-Gating-Hardening.md` | 85 | Defines and tracks feature gating and platform hardening for enforced entitlements, tenant isolation, and safe paid hosting. |
| `docs/phases/Phase-18-AI-Platform-Administration-Credit-Billing.md` | 155 | Records the historical scope for platform-managed AI administration, metering, credit billing, and its original implementation decisions. |
| `docs/phases/Phase-18b-AI-Agent-Capability-Expansion.md` | 316 | Defines and tracks metered waves that expand AI tools and actions across the platform’s business domains. |
| `docs/phases/Phase-19-Public-API-Webhooks.md` | 220 | Defines and tracks the public business API and sub-app webhooks, including authorization, scopes, and delivery waves. |
| `docs/phases/Phase-2-Menu-Cashier-Order-Flow.md` | 62 | Defines the menu and cashier phase for building and submitting correct dine-in and takeaway orders. |
| `docs/phases/Phase-20-Employee-Secure-Identity.md` | 914 | Defines and verifies the multi-wave employee identity programme for revocable sessions, WebAuthn, device binding, shifts, and audit security. |
| `docs/phases/Phase-21-Multi-Industry-Accounting-Platform.md` | 799 | Defines and tracks expansion from a food-and-beverage POS into multi-industry accounting for jewelry, watches, and accessories. |
| `docs/phases/Phase-22-Accounting-Standards-Compliance-Gap-Analysis.md` | 793 | Analyzes accounting-standards gaps and sequences work for the common core, terminology, account structures, and industry charts of accounts. |
| `docs/phases/Phase-23-Subdomain-Tenancy.md` | 537 | Defines and verifies per-business subdomains, environment-aware synchronization, typable sync tokens, and the secure production cutover. |
| `docs/phases/Phase-23-WooCommerce-Integration.md` | 142 | Defines the WooCommerce integration epic for two-way catalogue and order synchronization, financial posting, retries, audit, and reconciliation. |
| `docs/phases/Phase-24-Security-Hardening-Data-Protection.md` | 912 | Combines the original security-hardening specification with current status for perimeter controls, two-factor authentication, encryption, VPN deployment, and remaining hardening. |
| `docs/phases/Phase-25-Industry-Separation.md` | 258 | Defines and verifies industry separation so business type drives product boundaries, shell profiles, retail invoicing, and industry homes. |
| `docs/phases/Phase-26-Holoo-Interoperability.md` | 267 | Defines Holoo migration and companion-mode interoperability across master data, transactions, accounting, writes, validation, and reconciliation. |
| `docs/phases/Phase-27-Cosmetics-And-Per-Trade-Specialization.md` | 376 | Records the completed cosmetics and per-trade specialization programme, including shared retail capabilities, batches, expiry, and FEFO. |
| `docs/phases/Phase-28-Connections-Hub-And-WordPress-Plugin.md` | 196 | Records the Connections Hub, desktop pairing repair, WordPress plugin work, and the later ownership correction. |
| `docs/phases/Phase-29-In-House-Production.md` | 156 | Defines in-house production so raw ingredients can become stock items with explicit yields, costing, and inventory movements. |
| `docs/phases/Phase-3-Table-Management-Reservations.md` | 100 | Defines floor-plan table management, reservations, walk-ins, and table sessions, with a note on later billing changes. |
| `docs/phases/Phase-30-Missing-Account-Headings-And-Cheques.md` | 196 | Records the addition of missing cross-industry account headings and cheque support, with accounting decisions and completion evidence. |
| `docs/phases/Phase-31-AI-Autopilot.md` | 175 | Defines owner-governed AI autopilot actions with category controls, numeric guardrails, audit history, and one-click undo. |
| `docs/phases/Phase-32-AI-Coworker.md` | 232 | Defines the AI coworker’s persistent standing instructions, scheduled jobs, action boundaries, and completion criteria. |
| `docs/phases/Phase-33-Assistant-Usability.md` | 110 | Records assistant usability work focused on a natural mobile chat experience and grounded, trustworthy answers. |
| `docs/phases/Phase-34-MCP-Connector.md` | 264 | Defines the MCP connector that lets external AI clients access permitted business capabilities through a controlled interface. |
| `docs/phases/Phase-35-Notifications.md` | 262 | Defines the Web Push notification system for delivering business events to people away from the app, with rules and testing notes. |
| `docs/phases/Phase-36-App-Ecosystem.md` | 272 | Contains historical implementation notes for the app ecosystem, assistant workspace, retrieval, caching, prompt management, and cost-plus pricing. |
| `docs/phases/Phase-36b-Growth-Marketing-App.md` | 224 | Records the Growth and Marketing app that unifies loyalty, campaigns, gift cards, commissions, reporting, and navigation. |
| `docs/phases/Phase-36c-CRM-App.md` | 247 | Records the CRM app’s customer-relationship workspace, architecture decisions, assistant boundaries, reports, and cross-app bridges. |
| `docs/phases/Phase-37-LiteLLM-Gateway.md` | 41 | Preserves the historical LiteLLM gateway phase while pointing to the current single-provider architecture and deployment state. |
| `docs/phases/Phase-37-Messaging.md` | 115 | Defines metered, consent-safe SMS and email marketing with queued delivery and accounting posting. |
| `docs/phases/Phase-38-Website-Manager.md` | 195 | Records the Eshobe website manager’s connection, content synchronization, assistant integration, and delivery evidence. |
| `docs/phases/Phase-38-WooCommerce-Catalogue-And-Store-Ops.md` | 308 | Records WooCommerce catalogue and store-operations work for variants, product identity, stock, orders, synchronization, and accounting. |
| `docs/phases/Phase-38b-LiteLLM-Platform.md` | 43 | Preserves the historical LiteLLM usage-cost capture and reconciliation phase while identifying the current architecture. |
| `docs/phases/Phase-39-LiteLLM-Only-AI-Platform.md` | 162 | Documents the current LiteLLM-only provider model, credential ownership, retired policy mirrors, and required secret cutover. |
| `docs/phases/Phase-4-Waiter-Kitchen-RealTime-Sync.md` | 97 | Defines waiter and kitchen workflows with real-time LAN synchronization of orders and table state. |
| `docs/phases/Phase-40-App-Ownership-And-WP-Manager.md` | 119 | Records Phase 40 app-ownership corrections, customer-workflow movement, WP Manager routes, and deliberate non-goals. |
| `docs/phases/Phase-41-Shared-Party-Record.md` | 145 | Records the shared parties record and scoped app views that replace fragmented customer, supplier, staff, and ledger counterparty data. |
| `docs/phases/Phase-42-Warehouse-Module.md` | 86 | Defines the food-and-beverage warehouse module for documents, per-warehouse stock levels, counts, and warehouse-oriented navigation. |
| `docs/phases/Phase-42b-Retail-Warehouse-Module.md` | 164 | Extends the warehouse module to retail using its own items, stock, batches, documents, levels, and counts. |
| `docs/phases/Phase-43-Periodic-Inventory-System-LIFO.md` | 82 | Defines periodic inventory and LIFO options while preserving existing perpetual FIFO and weighted-average behavior. |
| `docs/phases/Phase-44-Hybrid-Sync-Completeness.md` | 91 | Records Hybrid synchronization transport repairs, coverage completion, self-checks, and visible dead-letter handling. |
| `docs/phases/Phase-45-Cloud-Primary-Hybrid.md` | 202 | Records the cloud-primary Hybrid split between the offline-capable desktop till and cloud-rendered screens, including reconnect behavior. |
| `docs/phases/Phase-46-Desktop-Full-Suite.md` | 76 | Records the unified full-suite Desktop experience with hardened embedded cloud screens and preserved offline-till guarantees. |
| `docs/phases/Phase-47-AEC-Industry-And-Project-Operations.md` | 875 | Records the complete AEC industry and project-operations programme covering project controls, BOQs, drawings, RFIs, site execution, commercial controls, and procurement. |
| `docs/phases/Phase-5-Offline-Queue-Hardware.md` | 102 | Defines offline mutation queuing, idempotent synchronization, receipt and kitchen printing, and cash-drawer control. |
| `docs/phases/Phase-6-Inventory.md` | 79 | Defines recipe-based inventory deduction and COGS, costing methods, purchasing, waste, stock counts, and low-stock operation. |
| `docs/phases/Phase-7-Double-Entry-Ledger.md` | 78 | Defines automatic balanced journal posting for business events and a trial balance that always nets to zero. |
| `docs/phases/Phase-8-Reporting-Analytics-Engine.md` | 149 | Defines custom and standard reports, pinnable analytics dashboards, permissions, and later reporting-audit corrections. |
| `docs/phases/Phase-9-Multi-Location-Rollup-Polish.md` | 85 | Defines central multi-location rollup plus permission hardening, performance work, and daily-use polish. |
| `docs/phases/Phase-G-My-Workspace.md` | 337 | Documents My Workspace project architecture, sections, routes, migration, integrations, access rules, limitations, and tests. |
| `docs/phases/README.md` | 127 | Indexes the phased development plan and explains its ordering, scope, dependencies, status, and exit-criteria conventions. |
| `docs/platform-billing.md` | 143 | Describes super-admin wallet credits, plan building, Zarinpal top-ups, metered function billing, and the unified commercial system. |
| `docs/platform-business-reporting.md` | 213 | Defines read-only super-admin business reporting, its authorization boundary, APIs, scoping, performance semantics, and verification. |
| `docs/platform-company-route-inventory.md` | 79 | Inventories Platform Company browser and API routes with evidence-backed classifications, redirect policy, and unresolved duplicates. |
| `docs/platform-company-workspace.md` | 371 | Describes the internal Platform Business workspace, RLS architecture, authorization, billing, growth, lead intake, scripts, and canonical routes. |
| `docs/pos-overhaul-report.md` | 272 | Reports the POS overhaul’s implemented changes, removed code, interaction behavior, responsive work, verification, and unverified areas. |
| `docs/printing.md` | 613 | Provides the reference for template-driven receipts, invoices, kitchen tickets, labels, printer pairing, cash drawers, testing, and model extension. |
| `docs/production-deployment-verification.md` | 108 | Explains how to verify the actual production image SHA with smoke checks and GitHub Actions or Coolify rather than trusting a restart acknowledgement. |
| `docs/retail-batch-inventory.md` | 85 | Defines the canonical retail batch-inventory contract, stock rollups, allocation engine, channel callers, and legacy limits. |
| `docs/runbooks/media-storage-operations.md` | 56 | Provides operational procedures for S3-compatible media storage, tenant isolation, storage-location changes, and orphan cleanup. |
| `docs/server-migration.md` | 409 | Guides moving an entire installation between servers through inventory, dump, restore, verification, cutover, and platform-specific recipes. |
| `docs/server-sync.md` | 577 | Documents site-to-cloud synchronization architecture, pairing, event transport, supported scope, operations, updates, and troubleshooting. |
| `docs/standalone-desktop-app.md` | 333 | Describes the standalone Windows Electron suite’s packaged runtime, network boundaries, persistence, pairing, offline operation, builds, backups, updates, and recovery. |
| `docs/superpowers/plans/2026-08-03-desktop-first-run-wizard.md` | 3813 | Plans the Electron first-run wizard that lets a new installation either create a local-only business or pair with an existing online business. |
| `docs/superpowers/plans/2026-08-11-edit-delete-addon-groups.md` | 165 | Plans frontend-only inline editing and deletion of menu modifier groups using the existing tenant-scoped APIs. |
| `docs/superpowers/plans/2026-08-11-inventory-search.md` | 506 | Plans Persian-aware client-side inventory search across item lists and form pickers with shared normalization. |
| `docs/superpowers/plans/2026-09-30-cloud-primary-hybrid.md` | 2234 | Plans the cloud-primary Hybrid Desktop split between local till workflows, sandboxed cloud windows, shift synchronization, and settings. |
| `docs/superpowers/specs/2026-08-03-desktop-first-run-wizard-design.md` | 261 | Specifies the approved first-run Desktop design for local-only setup versus online pairing, including data, feature flags, and errors. |
| `docs/superpowers/specs/2026-08-10-inventory-search-design.md` | 72 | Specifies approved Persian-aware inventory search by name, SKU, and unit using shared client components without API or schema changes. |
| `docs/superpowers/specs/2026-08-11-edit-delete-addon-groups-design.md` | 63 | Specifies the approved inline modifier-group edit and delete experience, data flow, validation, and testing. |
| `docs/support-companion-runbooks.md` | 170 | Provides day-to-day support-companion procedures for enrollment, remote assistance, diagnostics, repairs, tokens, updates, incidents, and staged rollout. |
| `docs/support-companion.md` | 154 | Guides server operators through the standalone Windows support companion’s architecture, credentials, external setup, offline tokens, MeshCentral, and scheduling. |
| `docs/tax-invoicing.md` | 387 | Defines the taxpayer-invoicing workspace, immutable submissions, lifecycle, corrections, reliability, reconciliation, configuration, callbacks, and open items. |
| `docs/ui-conventions.md` | 209 | Explains the dashboard design language and required shared primitives for pages, controls, mobile layout, colour, and change review. |
| `docs/vpn-only-deployment.md` | 31 | Guides a private VPN-only local deployment using WireGuard or Tailscale with Caddy HTTPS and no public port forwarding. |
| `docs/warehouse-document-audit.md` | 203 | Records the Persian warehouse-document audit and fixes across food-and-beverage and retail models for server errors, amounts, UI, responsiveness, and integration. |
| `docs/wordpress-plugin-updates.md` | 203 | Guides building, hosting, and updating the WooCommerce plugin from GitHub or a self-hosted update source, with security and compatibility rules. |
| `docs/wp-manager-permissions.md` | 52 | Defines the WordPress and WooCommerce manager permission matrix for pages, navigation, actions, APIs, sync responses, and queue classification. |
