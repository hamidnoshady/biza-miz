# Phase 48 — Official Telegram Bot and Mini App

**GitHub issue:** [#976](https://github.com/hamidnoshady/biza-miz/issues/976)
**Product boundary:** one centrally operated official Bizamiz bot and first-party Mini App, tied to existing platform identities. This is an epic with five implementation phases; Phase 1 alone is not the definition of done.

## Current status

- **Phase 0 — inventory and threat model:** documented below. The existing identity, `employee_sessions`, MFA, RLS, capability, entitlement, deployment-role, branch and shared-AI boundaries are the authoritative systems. No Telegram-specific user, role, tenant, permission or AI authority is introduced.
- **Phase 1 — bot and account linking:** implementation is in progress. The repository now contains the central Bot API adapter and configuration command, a bounded/secret-verified webhook with a durable update-id inbox, a private-DM command processor, browser-bound account-link challenges, a Telegram Web App session exchange, existing MFA/lockout/session integration, and a first-party Mini App entry page. Migration `0250_telegram_phase_1_identity.sql` is forward-only and gives every new tenant table RLS in the same migration. Phase 1 is **not declared complete** until the migration and integration checks, full repository checklist, deployment registration and operational verification pass.
- **Phase 2 — Mini App and management:** not started. The initial page is an authentication/bootstrap shell, not the full Mini App management experience.
- **Phase 3 — group/channel bindings and forum-topic templates:** not started. Phase 1 intentionally ignores group/channel updates; Telegram does not grant bots arbitrary user visibility or management authority.
- **Phase 4 — shared AI:** not started. Telegram must call the current shared assistant/tool pipeline with the same tenant, permission, confirmation, budget and audit checks. There is no parallel Telegram prompt, model client, identity or memory store.
- **Phase 5 — production readiness:** not started. Production launch requires the operator runbook, real Telegram test-bot validation, rate/retention monitoring, deployment checks and incident procedures.

## Phase 0 — inventory and threat model

### Existing systems that remain authoritative

- A Telegram account is linked to an existing `platform_users` identity through a signed-in browser session. The Telegram numeric ID is not a new account credential and cannot create a platform user.
- Tenant access remains an active `users` membership on the host-derived business, and every session is an existing revocable `employee_sessions` row.
- `authorize()`, RLS, live role/permission checks, current branch assignment, Cloud deployment profile, `integrations` entitlement, recent-auth policy, MFA factors, lockout policy, token version and existing audit trail remain authoritative.
- The official bot token, webhook secret and domain configuration are platform-owned deployment secrets. A business cannot supply or see them.
- Bot messages and Mini App requests do not create a second AI pipeline. Issue #976 Phase 4 is explicitly responsible for integration with the shared assistant pipeline.

### Threats and controls

| Threat | Phase 1 boundary/control |
|---|---|
| Forged or stale Mini App identity | The server verifies Telegram's HMAC over raw `initData`, checks its short age window and rejects a non-private `chat_type`. `initDataUnsafe` and client-supplied Telegram/business IDs are never trusted. |
| Replaying a valid `initData` envelope | Store only a canonical-data hash in a unique replay table; consume it once and only while the linked identity is live. |
| Linking an attacker-controlled Telegram account to another person's Bizamiz identity | A 256-bit random challenge is generated only from an authenticated, recent-auth browser session; only its hash is stored. It is bound to the current membership, platform identity, session row and token version, expires quickly, is single-use, and must be redeemed by a Telegram private-DM `/start` update. Global partial unique indexes allow only one active link per platform identity and per Telegram identity. |
| Stale or cross-tenant authority | The tenant comes only from the canonical business hostname, never a body field. Alias hosts are refused for session exchange. Link generation, active identity, current membership, business status, Cloud profile and feature entitlement are rechecked at session resolution and before MFA/session issuance. |
| MFA or lockout bypass | Telegram is a primary factor only. Existing role policy, factor verification/enrolment, recovery-code rules, account lockout and challenge routes remain in force. Trust-device grants are not offered by Telegram login. |
| Bot token/webhook secret leakage | Secrets are server-only; request bodies, Telegram descriptions, raw `initData`, challenge tokens, message text and numeric account IDs are not logged or stored. Bot API errors collapse to safe codes. The configuration CLI prints only the public username and webhook URL. |
| Forged webhook, flood or oversized payload | Exact Telegram secret-token header comparison, central-only route, dedicated high-volume IP rate bucket, 64 KiB body cap, bounded parser, durable unique update ID, fenced attempt counter, active-work retries, retryable failure status and safe error-code storage. |
| Group/channel content becoming an accidental tenant boundary | Phase 1 supports private messages only. Group, channel, supergroup and forum-topic updates are not processed and never establish tenant scope. Future bindings must be explicit, manager-authorized, tenant-scoped and revalidated. |
| Clickjacking or cross-site cookie leakage in Telegram Web | Telegram Mini App pages use a host-only, Secure, `SameSite=None; Partitioned` session cookie; ordinary browser sessions remain `SameSite=Lax`. Only `https://web.telegram.org` is allowed by an enforced `frame-ancestors` rule on the Mini App page and signed Telegram-session documents; undocumented alternate hosts are not allowlisted. Other pages retain `X-Frame-Options: DENY`. |
| RLS bypass or global identity data mixing with tenant data | Tenant challenge table has forced RLS in migration `0237`; global link, replay and webhook inbox tables have forced RLS restricted to the documented `telegram-identity-auth` service boundary. Every membership operation still uses the business selected from the request host. |

The CSP allows only the official `https://web.telegram.org` origin. Telegram's [official applications page](https://telegram.org/apps) lists its Web clients, but no authoritative Telegram documentation was found confirming separate `webk.telegram.org` or `weba.telegram.org` origins as Mini App frame parents. Those aliases are deliberately excluded; expand the allowlist only after official confirmation and a browser integration test.

### Telegram capability matrix (Phase 0)

| Surface | Telegram capability and hard limit | Bizamiz policy |
|---|---|---|
| Private bot chat | Inline/reply keyboards, callback queries, Web App buttons, slash commands and native `primary` / `success` / `danger` button styles are supported. Button styling is client-rendered; arbitrary CSS/glass is not. Custom emoji use has eligibility limits. | Keep private chat as the place for personal account actions and Mini App launch. Set safe native styles only; omit custom emoji unless the centrally configured bot is eligible. |
| Basic group | Bot visibility depends on privacy mode and granted admin rights. A bot must not infer a tenant from title, username, creator, command or message. | Do not disable privacy mode to make the bot read all group traffic. Phase 1 ignores non-private updates; future work requires explicit one-tenant binding, least rights and group opt-in. |
| Forum supergroup | Forum topics are available only in topic-enabled supergroups; topic creation/editing needs the corresponding admin right. The stable routing identifier is `message_thread_id`, and chats may migrate to a different ID. | Create/reconcile only after an authorized tenant admin approves a one-chat binding. Persist per-topic mapping to existing workflows; migrate binding IDs; never create topics in a channel. |
| Channel | A channel bot needs administrator permission to publish; channel posts do not provide an ordinary member's identity. A channel is not a forum and has no general topic workflow. | Treat as approved broadcast-only delivery, never infer staff identity or allow commands/private-data queries. Require a tenant-bound channel and existing approval/consent rules. |
| Mini App | Bot Web Apps launch in private chats, supply signed `initData`, and may run in a Telegram Web iframe or native WebView. Browser APIs and cookie behavior vary by client. | Validate raw `initData` server-side; keep the host-only partitioned session; use the same server authorization for every route. Capability-aware fallbacks are required for print, offline, file and integration flows. |

Sources: [Telegram Mini Apps](https://core.telegram.org/bots/webapps), [Bot API inline keyboard buttons](https://core.telegram.org/bots/api#inlinekeyboardbutton), [forum topic creation](https://core.telegram.org/bots/api#createforumtopic), and [Telegram applications](https://telegram.org/apps). The official API documents three native styles (`primary`, `success`, `danger`); it does not offer arbitrary chat-button CSS, so the glass visual language belongs only to Mini App HTML/CSS.

### Phase 1 data handling

- `telegram_identity_links` stores only the Telegram numeric ID, the existing `platform_users.id`, generation, timestamps and fixed provenance. It does not store Telegram name, username, phone number, profile photo, chat history or contacts.
- `telegram_link_challenges` stores a hash, a tenant/membership/session binding and expiry; the plaintext token exists only in a short-lived Telegram deep link.
- `telegram_init_data_replays` stores the canonical hash and expiry, never the raw payload. Expired replay rows are deleted during insertion.
- `telegram_webhook_updates` stores update ID, processing state, bounded attempt count and safe error code only. Update bodies and message content are never persisted. Processed/failed rows are retained for up to 30 days; active processing leases can be reclaimed when Telegram retries.

## Phase 1 operational setup

1. Create and control one official bot through Telegram's official bot-management flow. Keep its token in the central Cloud secret store only.
2. Configure `DEPLOYMENT_ROLE=central`, `ROOT_DOMAIN`, `TELEGRAM_ENABLED=true`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` (without `@`), a randomly generated `TELEGRAM_WEBHOOK_SECRET`, and the exact HTTPS apex/webhook URLs in `.env.example`.
3. Ensure the apex and wildcard business hosts have valid HTTPS certificates. The public origin must be the apex of `ROOT_DOMAIN`; the webhook URL must be that same origin plus `/api/telegram/webhook`.
4. Run `npm run telegram:configure` from the central deployment. It verifies `getMe()` against the configured username, registers the webhook without dropping pending updates, and installs only `/start`, `/businesses` and `/help`.
5. Validate with a non-production/test bot first. Link from a signed-in browser, exercise `/start` and `/businesses` in a private DM, open the business button, complete mandatory MFA where applicable, then revoke the link and verify that the Mini App session stops working.
6. Do not announce Phase 1 production readiness until database integration tests, the full local checklist, rate-limit behaviour and Telegram Web/native client behaviour pass on a real Cloud test tenant.

To rotate the webhook secret or bot token, update the central secret store and rerun `npm run telegram:configure`; never paste a token into an issue, chat, source file or business settings. If the bot is disabled, set `TELEGRAM_ENABLED=false` in the central environment and remove/revoke its webhook using the operator-controlled Bot API procedure. Re-enabling requires the same registration and smoke checks.

## Phase exit criteria

### Phase 0 — inventory and threat model

- [x] Existing identity, session, MFA, tenancy, branch, entitlement, capability and AI ownership boundaries are recorded.
- [x] Trust boundaries, major threats, non-goals and controls are documented above.

### Phase 1 — bot and account linking

- [ ] One central official bot is registered and operationally verified on Cloud.
- [ ] Account linking and unlinking pass real-database RLS, replay, concurrency, audit and current-session revocation tests.
- [ ] HMAC/timestamp/initData, webhook secret, size/rate limits, idempotent retries, cookie partitioning and session live-checks pass targeted tests.
- [ ] Existing MFA, login lockout, employee-session listing/revocation and audit behavior are verified end to end.
- [ ] `npx tsc --noEmit`, `npm test`, `npm run test:db`, and `npm run build` pass.
- [ ] Deployment runbook and Cloud smoke checks are exercised.

### Phases 2–5

- [ ] Phase 2: complete and test the Mini App's first-party management experience and accessible RTL interaction.
- [ ] Phase 3: implement explicit tenant-authorized group/channel bindings and forum-topic templates within Telegram's capability limits.
- [ ] Phase 4: use the shared AI pipeline with live tenant/branch/permission checks, existing billing/confirmation/audit, and no second model/identity system.
- [ ] Phase 5: complete production operations, observability, abuse testing, retention, incident response and deployment readiness.
