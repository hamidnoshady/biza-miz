# First-run import access

GitHub **#1580 / ESH-227** — how the optional «ورود اطلاعات» step decides whether
an import target may be used, and where that decision is enforced.

This is the audit deliverable the issue asks for (access matrix + no-duplication
boundaries). It complements [`effective-access.md`](effective-access.md) for
features and [`commercial-resolver.md`](commercial-resolver.md) for pricing; it
does not introduce a fourth access model.

## The formula

```
effective import access =
    authenticated tenant + authorised branch
  + domain permission (`data.import` AND the entity's own key)
  + industry/module applicability (`requiresModule`)
  + deployment/provider support (where the route applies it)
  + an effective active service entitlement
```

`effective active service entitlement` means **either** a canonical paid
activation (`business_service_activations.state = 'active'`) **or** an active
#1579 complimentary grant (`business_complimentary_grants`, time-limited or
indefinite). It is never:

- `settings.setupSelectedApps` (a draft intent),
- `setupPaid` / wallet balance / subscription status,
- Workspace shell visibility (that is not the Workspace business capability),
- or the fact that the owner opened the wizard.

`src/lib/import-access.ts` holds the pure decision; `import-access-service.ts`
reads the canonical axes. The two are the only copy of this rule.

## Scenarios

| Situation | Applying an import | Staging (upload / mapping / no-write preview) |
| --- | --- | --- |
| Paid activation `active` | allowed | allowed |
| Active complimentary grant (limited or indefinite) | allowed | allowed |
| Pre-gallery tenant (no `setup.selectedApps` row) | allowed (grandfathered) | allowed |
| App selected, no activation and no grant | refused `service_not_activated` («منتظر فعال‌سازی») | allowed; the job is kept |
| Grant expired/revoked | refused (`service_not_activated` or `service_grant_inactive`) | allowed |
| Service suspended (credit/platform/legal) | refused `service_suspended` | allowed |
| Customer-disabled / purging / purged | refused `service_disabled` | refused |
| App not selected (explicit selection) | refused `service_not_selected` | refused |
| Operator-unavailable app | refused `service_unavailable` | allowed |
| Industry lacks the module | refused `industry_module` | refused |
| Member lacks `data.import` or the entity key | refused `permission` | refused |
| Workspace target, ineligible industry | refused `workspace_not_available` | refused |
| Workspace service disabled/suspended | refused/awaiting activation | allowed |
| Legacy `/setup/menu` bookmark | redirects to the one import step | — |

Staging writes only the engine's own `data_import_jobs` / `data_import_rows`; it
never writes tenant domain data. That is why it may remain available while the
destination cannot be written.

## Enforcement points

1. **Discovery** — `GET /api/setup/imports` returns each candidate with the real
   decision, `stagingAllowed` and the Persian reason.
2. **Staging** — `createImportJob` asks `stagingAllowed` only.
3. **Approval / enqueue** — `queueImportJob` and `retryFailedRows` require
   `allowed`.
4. **Execution** — `runImportJob` revalidates before the run and **before every
   200-row page's write boundary**.
5. **Worker** — a job that loses access mid-run is parked `failed` with the
   reason; rows already committed stay, and `queueImportJob` is the resume path
   once the service is effective again.

The route has already enforced tenant/branch/permission through
`src/app/api/data/guard.ts` (the two-key rule); the engine asks the service axis
again and never trusts the client.

## Canonical sources (do not duplicate)

| Axis | Source |
| --- | --- |
| Selected apps (draft) | `setup-apps-service.getSelectedSetupApps` |
| Paid activation state | `service-activation/app-gate-service` |
| Complimentary grant | `complimentary-grant-service.readActiveComplimentaryGrant` (#1579) |
| Workspace eligibility/service | `workspace-access.workspaceAccessFor` (#1110) |
| App availability | `app-availability-service.effectiveAppAvailability` |
| Permissions | the request's effective member permissions |
| Import engine | `src/lib/data-transfer/*` (no second importer) |
| Menu manual writes | `/api/setup/menu` + `menu-service` (F&B only) |
| Parties | `POST /api/parties` → `parties-service.createParty` |
| Provider connections | `integration_connections` + the Woo/WP/Eshobe services |

## Intentional boundaries

- **No in-engine deployment gate for background jobs.** The HTTP route applies
  the install's deployment capability; the worker asks only whether the service
  may receive writes, so a job staged on Cloud is not stranded on Hybrid or an
  offline install.
- **A failed read fails closed for mutations.** A failed selection read is
  treated as "nothing selected"; a failed grant read as "no proven grant". A
  legacy tenant's historic access does not depend on either read.
- **No provider dataset import is implied.** The wizard can create/test/reuse
  WooCommerce, WordPress and Eshobe connections, but it does not advertise a
  one-time provider import that the canonical services do not implement.
  `syncProducts` writes directly and has no no-write preview, so it is not used
  as an onboarding import.

## Related

- [`accounting-workspace-ia.md`](accounting-workspace-ia.md) — where business
  work areas live (import is a setup step, not an app).
- [`app-boundaries.md`](app-boundaries.md) — the four apps, and why Workspace is
  not a fifth.
