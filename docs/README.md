# Documentation map

Where each kind of document lives. Phase docs and the design canon are cited by tests,
CI and CODEOWNERS, so their paths are fixed; everything else is grouped by purpose.

| Folder | What belongs there |
|---|---|
| [`phases/`](phases/README.md) | One file per development phase: scope, decisions, exit criteria. |
| [`architecture/`](architecture) | Cross-cutting design: app boundaries, branding (Bizamiz / بیزامیز), tenancy/authorization, effective feature access, sync, AI subsystem, CRM, accounting workspace IA. |
| [`features/`](features) | Per-feature references: payroll, tax invoicing, printing, commission, platform billing, … |
| [`integrations/`](integrations) | External systems: Eshobe CMS, WooCommerce/WordPress, integration contracts. |
| [`deployment/`](deployment) | Installing, updating, migrating and backing up: server, desktop, Android, monitoring. |
| [`runbooks/`](runbooks) | Operator procedures and checklists. |
| [`audits/`](audits) | Security, performance and hardening audits and release verifications. |
| [`reports/`](reports) | Engineering reports and session write-ups (historical, not normative). |
| [`plans/`](plans) | Per-issue implementation plans (`ISSUE_<n>_PLAN.md`) and the [open-issue index](plans/ISSUE_INDEX.md). |
| [`engineering/`](engineering) | Engineering notes, evidence and cleanup records. |
| [`design/`](design) | Visual canon assets, baselines and verification (paths are test-enforced). |
| [`mcp/`](mcp) | Generated MCP inventories — regenerate, do not hand-edit. |
| [`superpowers/`](superpowers) | Older agent-written plans and specs. |

Top-level files: [`design-system.md`](design-system.md) and [`ui-conventions.md`](ui-conventions.md)
(the UI canon, enforced by `npm run test:design`).

Wire contracts and their fixtures live outside `docs/`, in [`../contracts`](../contracts).
