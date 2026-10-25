# Local gateway hardening (#1002)

- New installations create a two-year CA with critical NameConstraints: IPv4
  RFC1918 ranges (and loopback for local diagnostics), `business-suite.local`,
  and no IPv6 names. Leaf validity is at most 397 days and never exceeds the CA.
- On Windows, Electron safeStorage protects the CA signing key with the current
  Windows account's DPAPI. Legacy plaintext keys are migrated before a cached
  leaf is reused; encryption failures stop startup rather than falling back to
  plaintext. Other platforms retain owner-only file permissions. Encryption
  does not defend against malicious code already running as the same user.
- Existing roots are **not silently replaced**: their certificates are already
  trusted by paired phones. Legacy unconstrained roots log a warning. To rotate
  one, disable the gateway, remove the old CA from every paired device's trust
  store, back up then remove the gateway certificate directory, and re-enable
  and repeat onboarding on each device. Never distribute the signing key.
  An expired CA requires this same explicit re-onboarding procedure.
- The gateway and its CA-only onboarding listener use adjacent available ports.
  Startup reselects and persists a pair if either saved port is unavailable.
  A port change requires updating phone URLs and reinstalling the scoped
  firewall rule. Binding still remains authoritative if another process wins
  the race after probing; listener failures clean up both servers.
- Reserve the desktop's IPv4 address in the router (DHCP reservation). The DNS
  SAN does not itself advertise mDNS or provision a DNS record. Address changes
  still require selecting the current interface and updating phone URLs; the
  settings warning explains this rather than silently choosing another network.
- Windows Firewall remains Private-profile / LocalSubnet only. Public networks
  are detected and explained in settings; access is not widened automatically.
- HTTP proxy bodies are capped at 32 MiB, including chunked requests. Header,
  request and idle timeouts bound stalled clients; upstream errors, truncated
  responses and client disconnects tear down proxy streams. WebSocket peers
  propagate close/error and have idle timeouts.
- Client-supplied Forwarded, X-Forwarded-* and X-Real-IP are stripped; gateway
  client identity is supplied from the TLS socket. The upstream TCP peer is
  necessarily loopback: application authorization must never equate a loopback
  transport with an authenticated desktop owner. Gateway IPC continues to use
  its independent sender-frame and owner authorization checks.
- Structured log metadata preserves nested data and errors while redacting
  credential keys. Do not log arbitrary secrets under unrecognized field names.

The PostgreSQL exit-hook fix tracked in #985 is already present: packaging patches
and verifies the dependency, and the main process detaches the unsafe exit hook.
