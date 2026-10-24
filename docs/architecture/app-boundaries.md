# Platform app boundaries

The platform has exactly four standalone business apps. `src/lib/apps.ts` is the
registry, and `src/lib/app-shells.ts` gives each app its own workspace menu.

| App | Canonical workspace | Owns |
| --- | --- | --- |
| Accounting (`accounting`) | `/accounting` | Sales/POS, orders, tables and kitchen, delivery, inventory and products, ledger and financial reports |
| Growth & Marketing (`growth`) | `/growth` | Loyalty, campaigns, gift cards, commissions and messaging |
| CRM (`crm`) | `/crm` | Customer records, segments, deals, activities, cases and consent |
| Website Management (`website`) | `/websites` | The Eshobe CMS manager and the WordPress/WooCommerce manager |

Website Management contains **two separate SaaS systems**, each with its own
integration, pages and settings. Eshobe CMS lives at `/websites/cms`; the
WordPress/WooCommerce manager lives at `/websites/wp`. They share the Website
Management app door; neither is a fifth app.

Sales/POS and operations are areas of Accounting, not standalone apps.
`dashboard`, `orders`, `pos`, the operational modules, `ledger` and
`reports` map to Accounting for app availability. An Accounting maintenance
state therefore affects those work areas together. The trade-level module keys
in `industry-profile.ts` still decide which capabilities a given industry has;
roles and feature entitlements still apply to individual pages.

The AI assistant, shared Settings, technical Connections, support and
knowledge surfaces are platform utilities. They do not get their own app key
or app availability state. In particular, the technical connection hub is
separate from the two website managers' business workflows. (The assistant is
the workspace home itself: `/dashboard` is its chat surface for every tenant,
and the retired second applications — the old quick-report dashboard and the
standalone `/ai` app — redirect there rather than existing alongside it.)

The super-admin app switchboard and its per-business overrides should list
only these four registry apps. Historical `sales`, `operations`, `settings`
and `connections` rows in the availability tables are ignored by the resolver;
do not add them back to the registry. Existing data is retained for audit and
recovery. An operator should review any historical non-available states before
changing the Accounting state, because consolidating conflicting app states
automatically would guess at intent.
