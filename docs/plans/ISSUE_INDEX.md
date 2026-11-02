# Issue index

Snapshot of every open GitHub issue as of **2026-10-25**, checked against merged and open pull
requests and against the code on `main`. Each open issue also has a **"📋 Development brief"**
comment (status, problem, remaining work as a checklist, acceptance, related links). Start there.

This file is a snapshot, not a live view. The live view is the issue labels below.

## Status labels

| Label | Meaning |
|---|---|
| `workflow:backlog` | Not started. Checked: no code for it on `main`. |
| `workflow:partial` | Started, not finished. Part of it is merged. |
| `scope:partial` | The merged part covers only some of the stated scope. |
| `workflow:pr-open` | A pull request for it is open and not merged. |
| `needs:owner-signoff` | Built; waiting for the owner's live check or decision. |
| `needs:merge-conflict` | The open PR cannot merge as is. |
| `kind:goal` | A business goal tracked here, not a code task. |

## 1. Waiting for you

| Issue | What you need to do |
|---|---|
| #864 Shareholders and profit distribution | Code is merged (PR #970, migrations 0222 and 0223). Promote an image to production, run `/mnt/project-files/shareholder-pr-970/deployment-checklist.md`, then close. |
| #884 Android TWA | Keep open (your decision). Needs Play App Signing enrolment, SHA-256 fingerprints in `assetlinks.json`, the two GitHub Environments, and device checks. |
| #915 Purchases and warehouse audit | Sign off that FS edit/cancel stays cloud-only and returns stay server-posted. Then do one manual purchase → receipt → return → report pass. |
| #1077 WP queue retention | Decide how long finished queue rows are kept. |
| #1075 WP queue verification | Choose how creates are verified (plugin meta, fingerprint, or stay "unknown"). |
| #1063 Legacy Windows | Decide the support matrix after the feasibility spike. |
| #998 Credit metering | Still open from your 2026-10-18 answers: list of metered functions, notification schedule and copy, default debt ceiling. |
| #1119 First 10 paying customers | Business goal; record the weekly numbers on the issue. |
| #1041 Service billing | Review PR #1129 before merge (purge worker, tenant write block); tariffs must be published before use. |

## 2. In flight: a pull request is open

| Issue | Status | What is left | PR |
|---|---|---|---|
| #1125 Staff privilege toggles (P0) | `pr-open` | Merge the fix; hybrid replica sync and the live-database matrix are out of the PR's scope; reproduce once after deploy. | #1142 |
| #1127 Printing template gallery | `pr-open` | CI green and review; real printers afterwards (#815). | #1136 |
| #1128 Advertising Agency business type | `partial`, `pr-open`, `scope:partial` | **Merged (#1157):** waves 1–2 — `advertising_agency` registry entry, migration 0259, the 85-account chart, the industry profile and the service-shape wizard; the eight operating presets stored as a setting and chosen in tenant settings, §B's seven Workspace blueprints with preset ordering, the sidebar contract test, and — joined to main's #799 service invoice — the trade's own sale document: `service` lines on «صورتحساب و دریافت» crediting 4640/4650/4660/4670. **Merged (#1172):** wave 3, §D's billing documents — migration 0260's two project-scoped registers (`agency_billing_milestones`, `agency_change_requests`), `agency-commercial.ts` owning both status chains and the act catalogue as a pure module, the service that writes them and reads the project P&L, seven `/api/agency/**` routes behind one guard, both subjects in the shared approvals queue, the invoice's project dimension carried through the posting rule, and the billing card on the project's «مالی» tab. **Merged (#1182):** wave 4, §E's media client review — migration 0265's four tables and six triggers (rounds, items, links, events), `media-review.ts` owning both status chains and the two freeze predicates as a pure module, the service that mints and revokes short-lived scoped links and streams bytes through the app instead of a presigned URL, seven `/api/media/review-rounds/**` routes behind media.view/media.manage, three token-guarded `/api/media/review/[token]/**` routes with the token as the whole credential, and the public `/review/[token]` screen the client lands on — followed by the «بررسی کارفرما» panel at `/media/review` under the library door, which is where a member creates a round, picks its files, sends it, mints and copies the link, and revokes it. **Merged (#1201):** wave 5, §A's first CRM slice — `crm-agency-pipeline.ts` holding the agency's seven sales stages as a preset over the platform's own `crm_pipeline_stages` (no table, no entity, no engine), and `ensureAgencySalesPipeline` creating it on read from the pipelines configurator and the deals board, beside the universal default rather than instead of it, with `is_default` false and nothing written at all for any other trade. **Merged (#1204):** wave 6, §A's client briefs — migration 0274's `agency_client_briefs`, the one record of what a client actually asked for, carried from the opportunity it was written against into the project it becomes. `party_id` is NOT NULL (a brief with no client is the agency guessing); deal and project are nullable and survive either going. Five rules live in the database rather than only in the service: every reference is this tenant's own, the approver must be a contact of *this brief's own client* (which is §A's "without exposing another client's information" enforced as a constraint rather than a convention), what the client confirmed is frozen, the deal and project pointers deliberately are not because the project arrives *after* confirmation and freezing it would break the §A→§B handoff, and deleting a client takes its confirmed briefs with it rather than letting the guard block the cascade. `agency-brief.ts` holds the vocabulary pure so the panel may import it, the service carries an explicit `business_id` on every statement and reads a PATCH by `"field" in patch`, and `register-numbering` gains a business-scoped sibling rather than a changed signature. Three routes in `/api/crm/briefs/**` and a `/crm/briefs` screen in the CRM door rather than the agency one, because §D's guard gates on the workspace *projects* service and a brief is written before any project exists. 48 raw-SQL assertions on 0274, 26 pure, 17 integration, CRM suites 363, sweeps 1309, plan-doc decisions 38–42. **Merged (#1209):** wave 7 — §A's proposals/quotes and §D's estimates, which turn out to be one document — §B's own stage list puts "proposal/quote" between brief and contract, so building two would be the same offer in two places free to disagree about the price. Migration 0276's `agency_proposals` + `agency_proposal_lines`: the header stores `discount_rial` and `tax_rial` and no total, because a stored total is a second answer to "how much" and keeping two answers agreeing is a trigger whose whole job is bookkeeping; each line's `amount_rial` is computed from quantity × unit price rather than trusted, quantity is `numeric(14,3)` because agency work is sold in halves and thirds, and each line names one of the trade's four revenue accounts validated against the tenant's own chart. `cost_rial` and `pass_through` are internal and the client boundary is structural rather than advisory — `agencyProposalClientView` returns a type in which those properties do not exist, and a test asserts the exact key set. Frozen from `sent` rather than from acceptance as a brief is, because a proposal states a *price* (0260's rule for a submitted milestone, applied to the document an approver reads first), lines included, with `contract_id` deliberately writable afterwards for the reason 0260's `invoice_order_id` is. Decisions are terminal and the correction is a new number in the series, which the screen makes a button. Two rules no CHECK can express live in the service and are documented where they are enforced: a discount past the subtotal it discounts, and accepting an offer whose validity has run out — without the second a client could accept a six-month-old quote at the old price. Lapsing is computed from the date rather than read from the `expired` status, so a list finds the offers that quietly stopped being offers. Three routes in `/api/crm/proposals/**` and a `/crm/proposals` screen with حاشیهٔ سود as its central column, marked «ناقص» when only some lines were costed, read from ONE lateral aggregate so a list's margin is real and equals the opened row's. 89 raw-SQL assertions on 0276, 34 pure, 27 integration, plan-doc decisions 43–48. **Merged (#1214):** wave 8 — §A's multi-brand client presentation, which decision 37 correctly said needs no schema and which wave 8 found is nonetheless not a query. `crm_party_relationships` states that `from → to` reads "from is *kind* of to", so `parent_organization` points parent → child and `branch_of` points child → parent: exact inverses, meaning one hierarchy can be recorded in either direction and a group's two brands in *different* directions by two members on two days. A resolver treating them as two relations sees a group with no brands, or a brand with two parents, or nothing — and looks correct in every unit test written against one direction. `crm-org-structure.ts` collapses both to one `child → parent` statement first, is total over any edge list (cycles terminate on a visited set, two claimed parents take the newest and report the other, every walk is bounded by `ORG_DEPTH_LIMIT` with the truncation reported), and returns contradictions in `conflicts` naming only their own members rather than resolving them silently. `organizationStructureFor` reads the edges with `business_id` on each `parties` join and counts each brand's work in one grouped read over the four registers that name a client — `crm_deals.customer_id`, `agency_client_briefs.party_id`, `agency_proposals.party_id` with accepted separately, `workspace_contracts.party_id`. **`growth_campaigns` names nobody**: it has no client column in 0262 or any later migration, so §A's "concurrent campaigns" is not presentable per brand and §C's client-versus-own split is blocked on a *dimension*, not on the missing list endpoint this index previously blamed. A campaign count of zero was refused rather than rendered, because «۰ کمپین» on every brand states that no brand has campaigns, which is not what the data says — and the suite pins the absence so adding it is a decision somebody makes. Read-only `GET /api/crm/customers/[id]/organization` on `crm.view` (writes stay on `/relationships`, which already gates and audits), and a card on the 360° file that renders nothing at all for a party that is not part of a group, because an empty card on every file teaches people to skip this one. Not industry-gated, like §E: a wholesaler has the same shape. 19 pure, 12 integration, plan-doc decisions 49–51. **Open (wave 9):** §C's client campaign record, which §A's "concurrent campaigns" needed first. The premise wave 8 recorded had to be overturned to build it: `growth_campaigns` is not a campaign table an agency could add a client to, it is #901's **retail cashback automation** — `CAMPAIGN_TRIGGER_TYPES` is exactly `["pos_sale_settled"]`, `CAMPAIGN_REWARD_TYPES` is exactly `["cashback"]` — so its party is the shopper earning money back. Adding a client column there would have made one column mean two things in two trades, and the symptom would have been a report: a "campaigns by client" figure silently counting cashback automations. `message_campaigns` is an SMS broadcast with its own credit ledger and `media_review_rounds.campaign_id` points at the first of those, so migration 0278 adds a fourth thing the word names — `agency_client_campaigns`. Downstream of the brief, the proposal, the contract and the project, so it carries five nullable reference FKs and a trigger requiring a brief's or proposal's client to equal the campaign's, which is §A's separation rule as a constraint. **An overspend is recordable** — no CHECK of spend against budget, because refusing the true figure pushes it into a note no report can read, and `over` is a first-class derived state beside `unbudgeted`, `under` and `at`. **Every ratio is null when its denominator is zero**, since a CPL of 0 on a lead-less campaign reads as the cheapest leads ever bought and §C's word for that is "fake"; `metrics_source` has exactly two values because there is no ad-platform integration and a third would claim one; and attribution is a member's claim with `metrics_note` holding the method, because a number with no stated method is not defensible. A completed or cancelled campaign is frozen — the correction is a new campaign — with two exemptions the harness found and both narrower than they look: a reference cleared because its parent row is *gone* (`ON DELETE SET NULL` is an UPDATE of the child, so the freeze was blocking a brief from being deleted), and a client attribution moving through an audited merge. That second one was a **bug in shipped code**: 0274 and 0276 each froze `party_id` inside their substance comparison, so `mergeCustomers` — which re-points every reference the registry classifies as `move` — failed with a raw `23514` on the CRM's duplicates screen whenever either client held a confirmed brief or a sent proposal. Migration 0279 redefines both guards, never editing an applied migration in place, following 0217's idiom: substance immutable always, attribution movable only while the transaction has declared `app.ledger_party_move = on`, which the merge loop sets for a reference that declares a `preMoveSql` after that statement has audited the move into the new `crm_party_attribution_moves`. `party-merge-coverage` had been green throughout, because it checks that every `parties(id)` reference has a declared disposition and not that the move survives the table's own triggers. Three routes in `/api/crm/client-campaigns/**` with an exhaustive eighteen-code status map, a `/crm/client-campaigns` screen whose pickers hold only the chosen client's own records, a new CRM section key, `client-campaigns` and not `campaigns` because `app-ownership.test.ts` gives that destination name to Growth and the boundary is right — two different things sharing an English word get two names, not one name with a comment (and «کمپین» moved off the brief's alias list, where it had been pointing at the nearest thing), and wave 8's refused campaign count is now counted per brand with the in-flight subset broken out. 66 raw-SQL assertions on 0278, 26 pure, 16 + 6 integration, 6 guard, plan-doc decisions 52–56. **Left —** §D's remaining documents: turning an accepted proposal into an invoice, true customer advances drawn against future invoices, the vendor quote → PO → payable → settlement chain, the gross-vs-net pass-through *posting* (the media recharge is still booked gross and 1270 is still unreached — what now exists is the decision it needs, recorded line by line at offer time on `agency_proposal_lines.pass_through`), and per-project overdue balances; §A's remaining CRM: contract renewals and scope of work as a versioned document rather than as prose on a proposal (the sales pipeline, the client briefs, the proposals and the multi-brand client presentation all now ship — decision 37 said the brand structure needed no schema and wave 8 confirmed it, needing instead a *reading* of the two hierarchy kinds that are one relation stored in opposite directions); §C's *reporting* half — the calendar across campaigns, the agency's-own versus client-managed split (which needs a "whose campaign is this" dimension no record carries, and which the issue's own non-goal rules out inventing), cross-campaign CPL/CPA/ROAS roll-ups and manual import of platform data as a file rather than as typed figures; the record half now ships, and the correction to wave 8's "blocked on `growth_campaigns`" diagnosis is decision 52; the agency dashboard, AI drafting and print documents (§F, #1127); preset-driven default nav and KPIs, and the combining-presets UX; the Workspace eligibility matrix and AI invisibility for this key (#1110 — the matrix does not exist yet, so P0 item 5 cannot be closed here); #1081's sweeps (the «سفارش‌های شیفت» report tab and the `industry/items` audit guard both still reach a trade with no till); and the live rollout checks. | #1157 (merged), #1172 (merged), #1182 (merged), #1195 (merged), #1201 (merged), #1204 (merged), #1209 (merged), #1214 (merged), wave 9 |
| #1041 Service activation and hourly billing | `pr-open`, `needs:merge-conflict` | **Migration number clash:** the PR adds `0255_service_activation_billing.sql` but `main` already has `0255_import_reconciliation.sql`. Renumber, rebase, green CI. | #1129 |
| #1140 Persistent AI assistant | `pr-open`, `scope:partial` | Draft covers the first slice only; sidebar, Superadmin assistant, navigation tool, upload and library picker remain. Tours overlap #972. | #1139 (draft) |
| #1115 Windows Hybrid onboarding and sync | `partial` | Slices 1–3 are in the draft; browser enrolment, IAM correctness, snapshot, measured initial sync, Force Send/Receive/Both, Full Offline wizard, fleet integration, E2E remain. | #1138 (draft) |

## 3. Started, not finished

| Issue | What is left | Merged so far |
|---|---|---|
| #1118 Safe import and first-sync reconciliation (P0) | Gate the Woo first handshake and `syncProducts`; review wizard and routes; party, document and inventory loaders; historical posting policy; outbound gating; run report. | #1134 |
| #1000 Desktop sync block, unsigned updates, updater hardening (P0) | Signed build and published release (delivery lives in #981); pin publisher, re-verify before launch, throttle download writes, prune pre-update backups; confirm the #988 alert after upgrade. | #994 |
| #1002 Desktop gateway and CA hardening (P0) | Verify on real Windows (DPAPI migration, firewall, phone pairing); decide legacy CA rotation. | #1120 |
| #1004 Config and branding hygiene | `package.json` name and description, compose defaults, `DEPLOYMENT_ROLE` check in `server.ts`, slow tests. (appId and root clutter are done.) | #1121, #1114, #1133 |
| #1080 Tenant S3 uploads fail (reopened today) | Virtual-host vs path-style addressing fix and a column for it; show failure stage in the tenant UI. | #1082 (diagnostics only) |
| #981 Automatic desktop updates | Policy inheritance and preview, Full Offline update checks, unattended-install gates and E2E, private release delivery, operator docs. Needs a signed build (#1000). | #982, #1061 |
| #984 Support companion | `strict`/`approval_required` policy, `ai.assist` consumer, attended run on real Windows. | #993, #1009, #1067 |
| #976 Telegram bot and Mini App | Mini App navigation and approvals, notification preferences, group and channel setup, AI policy, production readiness. | #1095 |
| #951 Accounting ↔ WooCommerce | Create/publish and link flows, per-field ownership, stock and refund invariants, price source, taxonomy mapping. First import must use #1118. | #1056 |
| #944 WP overview | OVR-05, OVR-06, OVR-08 gaps, queue GET permission, live-store QA. | #1051, #1053 |
| #941 WP media (P0) | Scoped download URLs before rollout, snapshot protocol, remote delete and trash reconciliation, media UX, network hardening, live evidence. | #1045, #1051 |
| #903 Managed tenant backup | Managed storage, central recovery, key custody, billing, Superadmin panel, recovery drills. | #1071, #1117 |
| #869 Commission lifecycle | Multi-person browser test, statement pagination and export, category rules, dead-code audit, live two-instance check. | #930, #964, #977 |
| #815 Printing audit | Hardware runs only; follow-ups are #1047–#1050 and #1127. Close when those are done. | #856, #959, #1025, #1044, #1052 |
| #757 `/platform/ai` hardening | Branch readiness (P1-5), fleet N+1 (P1-6), drop plaintext key columns after the backfill check, docs sweep, dead-route audit. (P2-7/8 done by migration 0184.) | #756, #857, #962, #969, #978 |

## 4. Not started

Checked: no code for any of these on `main`.

| Issue | Summary | First step |
|---|---|---|
| #1005 | Rehire an offboarded member who has no email | Email field or PIN-role path in the rehire dialog |
| #1073 | Attach files to warehouse documents | Join table with RLS, branch-checked routes |
| #1075 | WP queue: verify `post_upsert` and `media_create` landed | Decision (see section 1) |
| #1076 | WP queue: page plugin-side events | Plugin protocol extension |
| #1077 | WP queue: keyset paging and retention | Keyset first; retention needs your decision |
| #1047–#1050 | Kitchen (KDS) follow-ups: alerts, batch actions, filters, E2E and printer acceptance | See #815 |
| #1066 | Persian label typography (CRM RFM) | Shared label pattern, fix RFM rows |
| #1081 | Task-first UI rebuild epic | Plan and child issues first |
| #1085 | Small-business roadmap (parent of #1086–#1089) | Build the children |
| #1086 | Cash-flow forecast | Read-only forecast from existing A/R, A/P |
| #1087 | Social-commerce inbox | One channel on CRM parties |
| #1088 | Appointment booking | Services, availability, calendar |
| #1089 | Workforce scheduling and leave | Planned shifts joined to clock-in data |
| #1108 | New API proof of concept | Isolated PoC and a decision doc |
| #1110 | My Workspace only for project-based types | One eligibility function plus matrix test. Must now include `advertising_agency` (project-based, service family) — see #1128 / PR #1157. |
| #998 | Offline credit metering | Phase 0 decisions |
| #956 | Zero trust and Secure Connect | Split into child issues |
| #972 | Interactive guided tours | Tour runner on the existing help button |
| #906 | Decision-intelligence layer | Phase the 113 items; one consumer first |
| #907 | Workspace audit fixes | Authorization bypasses first |
| #908 | Contract editor and e-signing | After #907 |
| #894, #896 | Torob and Divar managed services | After the #902 managed-service contract |
| #900 | Marketer management | Roster, targets and tasks |
| #901 | Campaign builder | Model and simulation, one trigger and reward |
| #902 | Managed Kavenegar child accounts | Provider spike and managed-service contract |
| #1012 | CRM and Growth playbooks | After #901 |

## 5. Duplicates and overlaps

No open issue is an exact duplicate, so none was closed as one. These pairs overlap; each
brief names the owner.

| Pair | Owner of the work |
|---|---|
| #972 tours and #1140 phase 2 highlight/tour | #972 owns tours; #1140 calls it. |
| #1000 item 2 (unsigned builds) and #981 | #981 owns update delivery. Item 1 of #1000 was already fixed by #988. |
| #951 first import and #1118 | #1118 owns first-import reconciliation. |
| #998 and #1041 | #998 owns offline leases; #1041 owns cloud hourly billing and retention. |
| #903 and #1041 | #903 owns backup artifacts; #1041 owns disabled-service retention. |
| #815, #1127 and #1047–#1050 | #815 tracks hardware only; the rest have their own issues. |
| #1085 and #1086–#1089 | #1085 is the parent. |

## 6. Recently closed: checked

| Issue | Result |
|---|---|
| #1123, #1124 | Done: #1135 and #1141. |
| #999, #1001, #1003 | Done by #1117, #1121, #1116 (the PRs say "Closes"). Owner steps from #1003 remain: set the `HEALTH_VERSION_TOKEN` secret (GitHub and Coolify) and smoke-test a packaged desktop under the enforced CSP. |
| #1126 | §A done by #1130. |
| #1132 | **Closed with no pull request and nothing built** (system-agent MCP provider wiring). Left closed because you closed it; reopen it if you still want it tracked. |
| #1080 | **Reopened:** #1082 only improved diagnostics. |

## 7. Fixed, owner steps outstanding

Merging to `main` only builds a candidate image. Production needs the manual promotion dispatch
of `publish.yml` with the `sha` of the image. Until then none of the merged fixes above are live.
