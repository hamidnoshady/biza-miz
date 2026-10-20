# Notification audit #931 — implementation and rollout

This change extends the existing catalogue, encrypted Web Push sender, event
outbox, recipient inbox, native FCM adapter, rules and tenant RLS. It does not
introduce a second notification system or implement SMS/TWA app features.

## Security / privacy

- Web Push registration and sending accept only `fcm.googleapis.com`, the exact
  Chromium non-stable Google host `jmt17.google.com`, `web.push.apple.com`, a
  single provider-owned label under `push.services.mozilla.com`, and validated
  DNS labels below `notify.windows.com` (Edge/WNS regional channels). Root-path
  token-bearing WNS URLs are supported, not just `/w/` URLs. HTTPS, default TLS
  port, no URL credentials or fragments. Unknown providers require a reviewed
  transport-policy change; neither `*.googleapis.com` nor `*.windows.com` is
  allowed.
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
  industry and AEC capabilities. Project-bound AEC disclosures require project
  membership even for business owners/accountants with business-wide overrides.
  Guarantee/insurance expiries may cover business-level contracts: the live
  tenant contract must match the event's project (including explicit null).
  Deleted, foreign, mismatched or moved sources fail closed. Financial AEC
  notifications also require `ledger.view`. Unknown event keys deny.
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
inheritance chain: branch rule → all-branch rule → role default. Catalogue and
save authorization use the selected branch. An all-branch preference only applies
to authorized branches; it does not grant business-wide financial visibility.

Removing the current device deletes its server binding once, then unsubscribes
locally. Local unsubscribe failures are reported, with the already-removed
server state reconciled so the device does not remain misleadingly active.
Ordinary disable still requires successful server removal before unsubscribing.

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


## Final-head compatibility review and scope decisions

### Browser provider evidence (2026-10-20)

Endpoint forms were checked against vendor source and reported browser endpoint
families, with redacted opaque tokens in tests (not live user subscriptions):

- Chromium's [constants](https://github.com/chromium/chromium/blob/913740dd13d751f641392e1d55ca83962f801533/components/push_messaging/push_messaging_constants.cc)
  and [channel selection](https://github.com/chromium/chromium/blob/913740dd13d751f641392e1d55ca83962f801533/components/push_messaging/push_messaging_utils.cc)
  emit `fcm.googleapis.com/fcm/send/`, `/wp/`, `/preprod/wp/`, and the **exact**
  non-stable host `jmt17.google.com/fcm/send/`. Tests cover all four forms.
- Microsoft's [WNS channel-domain guidance](https://github.com/MicrosoftDocs/windows-dev-docs/blob/docs/hub/apps/develop/notifications/push-notifications/wns-overview.md)
  says regional subdomains change and must be validated at the `notify.windows.com`
  domain boundary. Its root-path `cloud.notify.windows.com/?token=...` example
  and Edge's `/w/?token=...` regional family are supported. The browser-family
  compatibility gap is also recorded in [web-push issue 801](https://github.com/web-push-libs/web-push/issues/801).
- Legacy `android.googleapis.com/gcm/send/` uses a **GCM API key**, not this
  stack's VAPID authentication ([upstream web-push implementation](https://github.com/web-push-libs/web-push/blob/master/src/web-push-lib.js)).
  It remains unsupported rather than pretending a host allowlist change adds
  GCM delivery. Re-subscribe using a current VAPID-capable browser.
- No current Chromium-emission evidence was found for `fcm-x.googleapis.com`;
  it is not added on speculation. Unknown Google hosts fail closed. A genuine
  subscription using another host needs a reviewed vendor source/redacted
  endpoint example before extending the exact-host list.

Tests retain opaque tokens through registration/encryption/mock send and check
host lookalikes, label boundaries, unsafe DNS, pinning and redirects. Real
Chrome/Edge/Firefox/Safari device subscription acquisition and live provider
acceptance remain unverified: this environment has neither those devices nor
outbound access to provider hosts. No live-token/device result is claimed.

### Deliberate delegated-role notification change

This PR **does change** delegated AI notification behavior. All five AI event
kinds (`ai.coworker.pending/reported/failed`, `ai.automation.pending/failed`) are
owner-only, including explicitly opted-in custom AI administrators. Role
presets were already owner-only by default, but previously a delegate could
opt in; the new ACL intentionally removes that disclosure path because rendered
summaries/errors may include arbitrary private tool/source facts with no typed
source ACL. Existing delegate rules do not grant an exception. Owners still
need current AI permissions, a live tenant-owned source and project membership
when applicable. Losing ownership hides existing inbox summaries immediately.

This restriction is **notification-only**: the existing `ai.manage` and
`ai.automations.manage` delegated management routes/services are unchanged.
Restoring summary notifications to delegates requires typed per-source ACLs or
a separately designed permission-safe/redacted notification format, not removal
of this check. PostgreSQL regression tests exercise every AI event, a real
custom role holding both AI grants, explicit opt-in, owner fanout, denied
inbox/unread access, ownership loss, source deletion/project membership, and
continued authorized non-AI branch notifications.

### Why manifest compaction stays in #1036

The user permitted a justification instead of a separate PR. This minimal
build-only prerequisite stays: this notification change measured **645.879 MiB**
in the actual Windows package, over the unchanged **644 MiB** gate. Removing
compaction restores that known failure; the root cause is repeated Next client
reference mapping metadata amplified by new routes/client boundaries. The
verified `f521222` build measured **636.922 MiB** (installer **165.2 MiB** versus
**175 MiB**), saving **9,392,266 bytes** without removing runtime mappings or
raising budgets. Splitting the fix without first merging a prerequisite would
make this PR knowingly unshippable, and this session is restricted to its current
branch. The compactor is independently tested, only touches staged generated
manifest syntax, verifies identical complete data per file, and leaves the web
build/dependencies untouched. The final-head CI must remeasure the package;
the `f521222` numbers above are historical evidence, not final-head results.
