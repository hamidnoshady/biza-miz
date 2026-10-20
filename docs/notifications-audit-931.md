# Notification audit #931 — implementation and rollout

This change extends the existing catalogue, encrypted Web Push sender, event
outbox, recipient inbox, native FCM adapter, rules and tenant RLS. It does not
introduce a second notification system or implement SMS/TWA app features.

## Security / privacy

- Web Push registration and sending accept only `fcm.googleapis.com`,
  `web.push.apple.com`, and a single provider-owned label under
  `push.services.mozilla.com`. HTTPS, default TLS port, no URL credentials or
  fragments. Unknown providers require a reviewed transport-policy change.
- `notification-transport.ts` resolves once, rejects any private/non-global
  answer, and supplies a pinned lookup to a fresh HTTPS connection. TLS hostname
  verification/SNI remain enabled. Redirects are never followed. DNS failures
  fail closed. The generic `assertPublicHttpsUrl` helper is **not** claimed to be
  a secure connect-time boundary for other subsystems.
- Register and test APIs have durable, tenant/user/action-scoped 30-second
  throttles (429 + Retry-After), and a 20-browser-device registration cap.
- Notification preferences never grant permission. The policy uses canonical
  live membership (including custom roles, explicit revocations, site denials,
  inactive members/businesses), accounting app availability, branch scope,
  industry and AEC capabilities. AEC disclosures require project membership
  even for business owners/accountants with business-wide overrides. Financial
  project notifications also require `ledger.view`. Unknown event keys deny.
- AI summaries can contain arbitrary source/tool facts: conservatively these
  remain owner-only, in addition to AI permissions. The associated job or
  automation must still exist in this tenant, and its current project (if any)
  requires membership. Typed source ACL metadata would be needed before safely
  widening their audience to delegated AI administrators.
- Authorization is checked independently at fanout, queued/recovered push
  processing, and inbox reads. Hidden records do not contribute unread counts.
  Deep links must be local paths and remain subject to the destination's guards.
- Browser devices bind to an authorized **employee login session**, not just a
  person. Migration 0233 disables legacy unbound registrations; users explicitly
  activate them again. Revoking/ending one session disables only that session's
  registrations. Sending and listing also check expiry and ownership live.
  Existing logout/business-switch session revocation is reused.
- Client logout clears the worker binding, visible OS cards and browser
  subscription best-effort, even on an unconfirmed server revocation. Server
  revocation remains authoritative if client cleanup fails. Reactivation of an
  unregistered/disabled browser subscription rotates it, avoiding a cross-tenant
  endpoint reassignment through RLS. Native sign-out/revocation stays with the
  existing #884 lifecycle.
- Worker binding persists across worker restarts. A late provider payload for a
  different/logout identity displays only a generic sign-in notice, never the
  old title, body or deep link. Notifications already read by an OS/user cannot
  be recalled. No claim of guaranteed remote erasure is made.

## Durable delivery and anti-flood behavior

1. Producers insert stable semantic `dedupe_key` facts exactly as before.
2. Fanout takes a five-minute recoverable event lease. Only successful fanout
   sets `processed_at`; partial inserts replay safely through unique keys.
3. Every rule-admitted, authorized event has an in-app detail record, including
   push-only and quiet-hour preferences. Per-device push work is inserted into
   **the existing** `notification_deliveries` table.
4. Web Push and native FCM both drain that durable queue. Tenant advisory locks
   serialize short claim/budget transactions, not network calls. Push claims have
   two-minute leases and per-attempt fencing tokens. Presentation batch IDs are
   stable across retries. An expired claim can be recovered by another worker.
5. Ready authorized facts for one recipient/device/urgency lane are grouped into
   one summary, broken down by catalogue event label. No cross-user/project
   audience aggregation. Full individual detail remains in the inbox.
6. Ordinary and critical lanes have independent persistent business, user and
   device budgets. Ordinary default: 60 pushes/business/minute and one grouped
   push/user/device per five minutes. Critical: 120/business/minute and one per
   user/device per ten seconds. Critical bypasses ordinary backlog and quiet
   hours, but cannot form an unbounded loop. Oldest work is favored within a
   priority lane. Limits are product defaults to validate with users, **not
   Chrome rules**.
7. User modes: Immediate (still burst-limited), Smart digest (default five
   minutes; informational events at least fifteen minutes), In-app only.
   Digest minutes are configurable 1–60. Important events in digest mode use
   the configured window; critical events remain immediate subject to their
   separate budget. A recipient IANA timezone overrides the branch fallback.
8. Quiet work remains queued and is re-evaluated once per minute. Throttling
   defers `available_at` and records `throttled`; it never marks a fact sent.
   HTTP 429/5xx/network errors retry with exponential backoff capped at an hour.
   Definitive rejection/removed subscription, revoked authorization/preferences,
   or stale work become explicitly failed/expired, never accepted. Staleness:
   seven days ordinary, thirty days critical, with inbox history retained.
9. `sent` means **accepted by the push provider**, not proven displayed/read by
   the browser. A crash after provider acceptance but before recording it can
   replay; stable tags and no `renotify` reduce duplicate presentation. There
   is no exactly-once delivery transaction across a provider and PostgreSQL.
   Browser/OS suppression cannot be established by a definitive Chrome spam API.

Tune deployment defaults with `NOTIFICATION_PUSH_INTERVAL_SECONDS` (minimum 30,
otherwise 300), `NOTIFICATION_BUSINESS_PUSH_PER_MINUTE` (otherwise 60), and
`NOTIFICATION_RETENTION_DAYS` (30–3650, otherwise 90). The settings UI exposes
queued/accepted/failed/throttled facts and device last acceptance/failure/reason.
Counts are facts, not the number of grouped OS cards.

## Inbox, rules and retention

The global keyboard-accessible bell works on narrow and desktop viewports,
independently of Push permission. It offers unread count, filters, mark one/all,
refresh/retry, local deep links, Escape/close and visible-page polling every 30s
plus focus refresh. An overlapping refresh is coalesced, not allowed to lose a
mark-read refresh. It currently shows the latest 200 authorized entries.

Amount inputs have event-keyed drafts, Persian/Latin normalization, safe integer
Toman→Rial conversion, zero/clear, blur/Enter commit and retained drafts on errors.
Per-rule serialized saves and mutation versions prevent old responses reverting
newer UI intent. Only that rule is reconciled after failure, not the whole form.
Advanced controls expose severity and accessible branch overrides with the
inheritance chain: branch rule → all-branch rule → role default.

The event and cascading inbox/delivery retention is deliberately **90 days after
processing**, configurable as above, and shown in the inbox. Queued work is never
removed by cleanup. Even idle tenants with expired retained history are selected
by the tick for cleanup. This is not an indefinite durable inbox promise.

## Deployment and verification

Apply migration **0233 before deploying the new worker/API**. Pause old-version
notification workers during this rollout: an old worker does not understand
leases. Preserve the existing deployment-wide VAPID identity. Legacy unbound
browser devices require activation; do not silently revive them. Review outbound
firewall rules in addition to application transport checks.

Automated coverage includes provider/URL/IP/DNS/rebinding/redirect transport
boundaries; malformed IDs/bodies and API throttles; settings drafts/races/device
errors; bell read/filter/keyboard behavior; shared-worker account isolation;
PostgreSQL fanout, a 100-event burst, duplicate facts, concurrent claims,
partial-fanout/expired-lease recovery, 429/503 retries, quiet timezone release,
session-specific revocation, live permission/project membership changes,
cross-tenant project denial, native FCM compatibility and retention.

**Not claimed:** production E2E, actual APNs/FCM/Mozilla acceptance, Android/iOS/
Windows PWA/OS presentation, Chrome classification/suppression diagnostics,
production throughput tuning, or real mobile RTL/accessibility validation.
Before rollout, exercise those devices with real opt-in users, including a
shared till account/business handoff, permission blocking, restart after provider
acceptance, DST/midnight and sustained multi-tenant traffic. This environment's
network policy does not allow contacting live push providers.
