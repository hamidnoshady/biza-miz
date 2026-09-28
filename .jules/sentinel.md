## 2025-02-27 - Host Header spoofing bypass in Next.js middleware CSRF origin check
**Vulnerability:** A CSRF and origin check bypass was possible because the middleware blindly extracted and trusted the `X-Forwarded-Host` header when comparing `originUrl.host !== host`. A malicious attacker could spoof this header on a direct request to bypass the origin verification check.
**Learning:** `X-Forwarded-Host` should only be trusted when the application is securely behind a managed reverse proxy that strictly guarantees this header was generated internally or vetted. The codebase already had a mechanism to manage this trust via `TRUST_FORWARDED_HOST` and `requestHost` from `@/lib/host`, but it wasn't being used consistently for this particular check in `src/middleware.ts`.
**Prevention:** Always use the dedicated, secure `requestHost` (or `resolveRequestHost`) abstractions for retrieving the host in middleware, rather than raw header lookups, to ensure the deployment configuration regarding trusted proxies is consistently applied across all checks.

## 2025-02-27 - Unmitigated SSRF in AI Media Enhance webhook
**Vulnerability:** The AI media enhance feature (`runMediaEnhance` in `src/lib/ai-media-service.ts`) fetches an image URL returned by an external API without validating if the URL points to a public or private IP address. An attacker could potentially manipulate the AI provider's response or configure a malicious AI provider to return a URL pointing to an internal service (e.g., `http://169.254.169.254` or `http://localhost:5432`), causing the application server to make an unauthorized request into the private network.
**Learning:** Any URL provided by an external source, even an expected API response, must be validated before the server initiates a fetch request. The `assertPublicHttpsUrl` function provides this exact mitigation.
**Prevention:** Always validate external URLs using `assertPublicHttpsUrl` before fetching them on the server side to prevent SSRF vulnerabilities.

## 2024-05-28 - [Prevent IP Spoofing via x-forwarded-for parsing]
**Vulnerability:** Manually extracting IP addresses via `request.headers.get("x-forwarded-for")?.split(",")[0]` assumes the leftmost IP is trustworthy. In multi-proxy configurations without explicitly defined trusted proxies parsing right-to-left, attackers can forge the leftmost IP, bypassing security logging and rate limits by spoofing `x-forwarded-for`.
**Learning:** This specific vulnerability was found in the Impersonation (`src/app/api/platform/businesses/[id]/impersonate/route.ts`) and Support Session management (`src/lib/support-session.ts`), which incorrectly relied on manual string splitting rather than the centralized parser.
**Prevention:** Always use the centralized `clientIpFrom(headers, trustedHops)` utility from `@/lib/rate-limit`. This utility implements the correct right-to-left fallback matching scheme designed to identify the first public IP reliably, guarding against trivial header forgery.
## 2025-02-27 - [Environment guard for weak seed credentials]
**Vulnerability:** Weak default seed credentials with no environment guard in `scripts/seed.ts`
**Learning:** `scripts/seed.ts` lacked a mechanism to prevent seeding the database with weak default credentials (e.g. `owner1234`) in a production environment or an already-initialized database.
**Prevention:** Database seed scripts should enforce a safeguard to prevent execution with default weak credentials in a production setting (`NODE_ENV === 'production'`) or when the database already holds non-default real data.
