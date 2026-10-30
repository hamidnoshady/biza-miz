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
| #1128 Advertising Agency business type | `partial`, `pr-open`, `scope:partial` | **Merged (#1157):** waves 1–2 — `advertising_agency` registry entry, migration 0259, the 85-account chart, the industry profile and the service-shape wizard; the eight operating presets stored as a setting and chosen in tenant settings, §B's seven Workspace blueprints with preset ordering, the sidebar contract test, and — joined to main's #799 service invoice — the trade's own sale document: `service` lines on «صورتحساب و دریافت» crediting 4640/4650/4660/4670. **Merged (#1172):** wave 3, §D's billing documents — migration 0260's two project-scoped registers (`agency_billing_milestones`, `agency_change_requests`), `agency-commercial.ts` owning both status chains and the act catalogue as a pure module, the service that writes them and reads the project P&L, seven `/api/agency/**` routes behind one guard, both subjects in the shared approvals queue, the invoice's project dimension carried through the posting rule, and the billing card on the project's «مالی» tab. **Merged (#1182):** wave 4, §E's media client review — migration 0265's four tables and six triggers (rounds, items, links, events), `media-review.ts` owning both status chains and the two freeze predicates as a pure module, the service that mints and revokes short-lived scoped links and streams bytes through the app instead of a presigned URL, seven `/api/media/review-rounds/**` routes behind media.view/media.manage, three token-guarded `/api/media/review/[token]/**` routes with the token as the whole credential, and the public `/review/[token]` screen the client lands on — followed by the «بررسی کارفرما» panel at `/media/review` under the library door, which is where a member creates a round, picks its files, sends it, mints and copies the link, and revokes it. **Left —** §D's remaining documents: estimates/quotations, true customer advances drawn against future invoices, the vendor quote → PO → payable → settlement chain, the gross-vs-net pass-through policy (the media recharge is still booked gross and 1270 is unreached), and per-project overdue balances; §A CRM agency pipeline/briefs/proposals; the client-vs-own campaign split in Growth (§C); the agency dashboard, AI drafting and print documents (§F, #1127); preset-driven default nav and KPIs, and the combining-presets UX; the Workspace eligibility matrix and AI invisibility for this key (#1110 — the matrix does not exist yet, so P0 item 5 cannot be closed here); #1081's sweeps (the «سفارش‌های شیفت» report tab and the `industry/items` audit guard both still reach a trade with no till); and the live rollout checks. | #1157 (merged), #1172 (merged), #1182 (merged) |
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
