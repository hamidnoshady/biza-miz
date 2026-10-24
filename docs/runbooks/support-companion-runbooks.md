# Support companion runbooks (issue #984)

Operator procedures for the ticket-workspace support flow. Setup (keys,
MeshCentral, signing) lives in `docs/runbooks/support-companion.md` §2–4; this file
is the day-to-day: what to click, what each state means, and what to do
when something refuses. Every refusal below is fail-closed by design —
the runbook tells you which side (operator action vs customer action vs
external provisioning) unblocks it.

Companion tabs: Status · Enrollment · Authorize · Diagnostics · Repairs ·
Assistance · Updates · Settings. Console panels (ticket drawer): context ·
diagnostics · assistance · token · support-ai · history.

## 1. Enroll a machine

1. Customer opens the companion → Enrollment tab → Complete enrollment.
   The installation starts `pending`; the credential is DPAPI-sealed
   on that machine only.
2. Operator approves in the console (context panel) → `active`.
3. If the customer reinstalls or the credential leaks: Rotate credential
   (companion) or revoke the installation (console) — revocation bumps
   the generation, so outstanding tokens, requests and sessions naming
   the older generation fail closed on their next check.

## 2. Remote assistance session

1. Operator: assistance panel → request (caps `view`, optionally
   `control`) with a reason. State: `requested`.
2. Customer polls (Status tab → Poll now) and approves/denies in the
   Assistance tab. Approval needs the session JWT from the poll;
   `awaiting_local_consent` means exactly that — nothing has started.
3. Operator joins from the console (`approved` → `connecting`): a
   one-time operator URL opens the provider viewer in a new tab. The
   URL is never stored; a leaked URL cannot be reused.
4. Lease epochs bound the session; `active_view` / `active_control`
   show the live grant. Either side ends it at any time: customer
   STOP (companion) or operator revoke (console). Both land the same
   terminal state — revoke-after-end resolves success, never a
   spurious failure.
5. Dropped viewer (network blip, closed tab): operator rejoins from
   the console. Rejoin only works from `connecting`/`active_*` for the
   same operator with a live lease; a lapsed lease closes the session
   (`lease_expired`) and rejoin is refused — request a fresh session.

Refusals: `provider_not_configured` (no MeshCentral — records-only
mode, see §2 of the setup doc) · `agent_not_linked` (no agent node id
— install the agent, let discovery link it, or link by hand) ·
`lease_expired` (above) · `mfa_required` (fresh two-factor needed).

## 3. Diagnostics: request → run → report

1. Either side may file the request, and both land in the same ticket:
   - Operator: diagnostics panel → request with modules + reason.
   - Customer: Support → ticket → «درخواست بررسی» → pick the verified
     installation, tick the module groups, write the reason. The row is
     recorded as `initiated_by = member` (never `operator`), and the
     selected installation must be this business's own active one —
     forged ids answer 404/409, not a silent success.
2. Customer polls; the request lands `delivered`; the companion runs
   it under the redactor (secrets never leave the machine unredacted).
3. Upload is chunked and idempotent: re-uploading the same run never
   duplicates it. The console shows upload state + received time with
   a freshness badge (live / captured / stale / unavailable). The
   customer's ticket shows the same upload state, run state, severity
   and received time — a request that has not run is shown as
   «در انتظار باز شدن همراه», never as a green result.
4. Findings carry severities; the run state machine ends in a receipt
   the operator can quote back to the ticket.
5. Stop: the customer can cancel a request from the companion or from
   the ticket page («توقف بررسی»). Cancelling is immediate and does
   not need the operator; the console then shows `cancelled`. The
   customer's ticket also offers the same Stop for live assistance
   sessions, so the browser path never depends on the operator's
   authorization still being valid.

Refusals: expired requests cannot run (re-request) · wrong-generation
requests fail closed (re-enroll or rotate first) · a member request for
an installation that is not enrolled/active answers 409
(`installation_not_active`) instead of queuing forever.

## 4. Repairs: propose → approve → execute

States: `proposed` → `dry_run_ready` → `awaiting_approval` →
`authorized` → `executing` → `verifying` → `succeeded`; side exits
`rolled_back`, `failed`, `recovery_required`, `declined`, `blocked`.

1. Operator proposes from the signed recipe catalog (console).
2. Operator approves — approval requires recorded customer consent
   (`consent_missing` otherwise); high-risk recipes additionally need
   the risk acknowledgement.
3. Customer: Repairs tab → fetch the run, dry-run the plan (the plan
   hash pins the exact live state approved), then Execute with the
   consent checkbox. Execution holds the bilateral maintenance gate:
   the desktop updater cannot install mid-repair and the repair
   cannot run mid-update — whoever holds the gate wins, the other
   waits or refuses loudly.
4. Outcomes: `succeeded` (postchecks green) · `rolled_back` (verbatim
   staging restore, then terminal) · `failed` (nothing mutated) ·
   `recovery_required` (mutation happened but rollback did not
   complete — human intervention, the journal shows exactly what).
   `plan_drifted` means live state changed since approval: re-plan
   and re-approve, never force.

## 5. Tokens (on-site authorization)

- Online: console issues a short code (token panel) → customer redeems
  in Authorize → redeem code. Single-use, ticket-bound, expiring.
- Offline (no connectivity): console shows a challenge → customer New
  challenge / Verify offline in the companion, verified locally
  against the poll-served ES256 bundle. The bundle only ever carries
  public keys.
- Revoke from the console the moment a token is suspect; redemption
  checks revocation on every use.

## 6. MeshCentral agent: install, link, isolate

- No agent on the machine: the poll answers with a mesh-embedded
  installer URL (needs `MESHCENTRAL_URL` + `MESHCENTRAL_MESH_ID`) and
  the companion offers it as a download button. Without the mesh id
  the companion says so — ask the operator for the installer.
- Linking: the companion reports presence + hostname; with
  `MESHCENTRAL_MESH_ID` set, the server matches the hostname against
  the mesh's agents and records the node id. Zero or ambiguous
  matches never guess — link by hand from the console instead.
- Tenancy: one mesh per tenant boundary; the broker user needs rights
  only on the support meshes. Cross-tenant binds are refused by the
  server (`Access denied`, proven in conformance).
- If the server sets `lockagentdownload`, anonymous installer
  download 401s: distribute the exe out of band.

## 7. Companion updates

1. Release: `companion-release` workflow (tag `companion-v*` or manual
   with version/channel/kid) publishes the unsigned EXE + the
   unsigned update channel (manifest with machine-computed hashes).
2. Sign offline with the release RSA key (the same key as the #981
   desktop channel): re-run `scripts/build-companion-update.mts` with
   `DESKTOP_RELEASE_PRIVATE_KEY_PEM` — it self-verifies before and
   after writing the `.sig`. Serve `channel.json` + `.sig` + EXE
   statically.
3. Customer: Updates tab → paste the manifest URL → Check & verify →
   Download & stage (per-file progress, 512 MiB cap, sha256 re-hash of
   every byte) → Install & restart (staged apply via `apply.cmd`,
   then the app relaunches). The Settings tab stores the channel's
   manifest URL + channel name so the customer does not retype them.
4. Downgrades are refused by version compare; unsigned or
   wrong-channel manifests are refused by signature. Rollback is
   last-known-good recovery, never an older manifest.
5. `update-keys.json` rotation: replace the bundle on the machine
   (a poll-served rotation is a follow-up — see the packaging README),
   then publish the next channel signed by the new key id.

## 7b. The tenant's support policy blocks operator work

`businesses.support_access_policy` (Settings → Security → support access)
is checked by every **operator-initiated** companion action before anything
is created: diagnostic requests, assistance sessions, repair proposals and
on-site token issuance. When it is `disabled` the service returns
`support_access_disabled` and the console answers **409** with the Persian
explanation that the business has turned support off.

- Unblock = the customer sets the policy back to `standard` themselves.
  Neither the operator nor a live session can loosen it; `PATCH
  /api/support-access` refuses inside an impersonation session.
- The customer's **own** request from their ticket is not blocked — the
  policy withdraws the operator's access, not the customer's control (and
  their Stop keys stay independent of it).
- `strict` / `approval_required` are **not** reinterpreted for device work:
  they keep their existing meaning for the application-impersonation grant.
  Attended-desktop semantics for them are still an open product decision, so
  the services allow and the UI shows the policy as-is.

## 8. Incidents

- Suspect session: revoke it (console) or STOP it (companion) — then
  read the history panel: every grant, consent, join, rejoin and
  revocation is journalled with actor + reason.
- Suspect token/code: revoke from the token panel; outstanding
  single-use codes die immediately.
- Journal tamper evidence (`hash mismatch`, `chain broken`, recovery
  refused with "not a torn tail"): do NOT delete the journal — it is
  the evidence. Copy `operations.jsonl` aside, investigate, and only
  re-seed the machine (uninstall + revoke + re-enroll) once you know
  what wrote the bad line. Torn tails (crash mid-write) heal
  themselves with an audited `journal_recovered` record.
- MeshCentral down: sessions stay records-only; join refuses with
  `provider_unreachable` and the records say so honestly. No cached
  viewer URLs exist to go stale.
- Stolen machine: revoke the installation (generation bump kills every
  outstanding grant), revoke open tokens/sessions, rotate the mesh
  broker password, and re-enroll from scratch once recovered
  (uninstall, delete the data dir shown in the Settings tab,
  re-install, Complete enrollment).

## 9. Staged rollout (pilot checklist)

1. Provision setup per `docs/runbooks/support-companion.md` §2–4 on a pilot
   tenant: keys, self-hosted MeshCentral + service user + pilot mesh,
   signed pilot installer (once the cert exists).
2. Enroll 2–3 pilot machines; run one assistance session, one
   diagnostic run and one low-risk repair end to end; confirm the
   history panel tells the story back.
3. Publish a pilot update channel; confirm check → download → install
   & restart on one machine before pointing the fleet at it.
4. Re-run the live broker conformance before every release that
   touches the broker (docs §3); keep CI green on the release tag.
5. Expand mesh by mesh; per-tenant meshes keep every later incident
   blast radius contained by construction.