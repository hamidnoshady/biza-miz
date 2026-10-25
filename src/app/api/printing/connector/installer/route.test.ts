import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextResponse } from "next/server";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(async () => ({ session: { businessId: "biz-1" }, error: null })),
    withTenantScope: (
      handler: (request: NextRequest) => Promise<NextResponse>,
    ) => handler,
  };
});

// The tenant resolver needs Postgres; give the route a fixed label set so the
// origin-construction rules are what each test measures.
vi.mock("@/lib/host-resolution", () => ({
  listBusinessHostLabels: vi.fn(async () => ({ subdomain: "zaniziba", aliases: ["zaniziba-old"] })),
}));

import * as auth from "@/lib/auth";
import { listBusinessHostLabels } from "@/lib/host-resolution";
import { PERMISSIONS } from "@/lib/permissions";
import { GET } from "./route";

function installerRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://internal:3000/api/printing/connector/installer", { headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/printing/connector/installer", () => {
  it("downloads a private installer pinned to the browser-facing tenant origin", async () => {
    const request = installerRequest({
      host: "internal:3000",
      "x-forwarded-host": "rose.example.com",
      "x-forwarded-proto": "https",
    });

    const response = await GET(request);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.settingsManage);
    expect(response.headers.get("content-disposition")).toContain("Install-Bizamiz-Print-Connector.cmd");
    expect(response.headers.get("cache-control")).toContain("no-store");
    // Forwarded host is ignored unless the deployment explicitly trusts it;
    // the same host policy used by tenant routing decides the allowed origin.
    expect(body).toContain("$allowedOrigin = 'https://internal:3000'");
    // With no platform configuration, the payload comes from the origin the
    // installer was itself downloaded from — the same-machine guarantee.
    expect(body).toContain("$scriptUrl = 'https://internal:3000/windows/cafe-pos-print-connector.ps1'");
  });

  it("fails closed when no request host is available", async () => {
    const request = new NextRequest("https://example.com/api/printing/connector/installer");
    const response = await GET(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "installer_origin_unavailable" });
  });

  it("on a host-routed HTTPS deployment the payload comes from the stable platform apex — not the tenant host", async () => {
    // The zaniziba.app.eshobe.com regression: the connector payload must not
    // depend on the tenant subdomain's DNS.
    vi.stubEnv("ROOT_DOMAIN", "pos.example.com");
    const request = installerRequest({
      host: "zaniziba.pos.example.com",
      "x-forwarded-proto": "https",
    });

    const response = await GET(request);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("$allowedOrigin = 'https://zaniziba.pos.example.com'");
    expect(body).toContain("$scriptUrl = 'https://pos.example.com/windows/cafe-pos-print-connector.ps1'");
    // The tenant hostname never appears as a download address.
    expect(body).not.toContain("https://zaniziba.pos.example.com/windows/");
  });

  it("includes the business's alias origins in the connector's CORS set", async () => {
    vi.stubEnv("ROOT_DOMAIN", "pos.example.com");
    const request = installerRequest({
      host: "zaniziba.pos.example.com",
      "x-forwarded-proto": "https",
    });

    const response = await GET(request);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(listBusinessHostLabels).toHaveBeenCalledWith("biz-1");
    // Canonical subdomain and the rename alias, both server-verified.
    expect(body).toContain("$extraOrigins = @('https://zaniziba-old.pos.example.com')");
  });

  it("host routing aliases never replace the actual request origin as primary", async () => {
    vi.stubEnv("ROOT_DOMAIN", "pos.example.com");
    const request = installerRequest({
      host: "zaniziba.pos.example.com",
      "x-forwarded-proto": "https",
    });

    const body = await (await GET(request)).text();
    expect(body.indexOf("$allowedOrigin = 'https://zaniziba.pos.example.com'")).toBeGreaterThan(-1);
  });

  it("honours an explicit CONNECTOR_DOWNLOAD_BASE_URL over every other base", async () => {
    vi.stubEnv("ROOT_DOMAIN", "pos.example.com");
    vi.stubEnv("CONNECTOR_DOWNLOAD_BASE_URL", "https://downloads.example.com/cafe-pos");
    const request = installerRequest({
      host: "zaniziba.pos.example.com",
      "x-forwarded-proto": "https",
    });

    const body = await (await GET(request)).text();
    expect(body).toContain("$scriptUrl = 'https://downloads.example.com/cafe-pos/windows/cafe-pos-print-connector.ps1'");
  });

  it("an invalid CONNECTOR_DOWNLOAD_BASE_URL is a configuration error, not a manufactured URL", async () => {
    vi.stubEnv("CONNECTOR_DOWNLOAD_BASE_URL", "::not a url::");
    const request = installerRequest({
      host: "zaniziba.example.com",
      "x-forwarded-proto": "https",
    });

    const response = await GET(request);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "connector_download_unconfigured" });
  });

  it("plain-HTTP development keeps the request origin even with a root domain set", async () => {
    vi.stubEnv("ROOT_DOMAIN", "localtest.me");
    const request = installerRequest({
      host: "zaniziba.localtest.me:3000",
      "x-forwarded-proto": "http",
    });

    const body = await (await GET(request)).text();
    expect(body).toContain("$allowedOrigin = 'http://zaniziba.localtest.me:3000'");
    expect(body).toContain("$scriptUrl = 'http://zaniziba.localtest.me:3000/windows/cafe-pos-print-connector.ps1'");
  });

  it("pins the payload SHA-256 when the download is answered by this very deployment", async () => {
    // No platform env: download source is the request origin itself.
    const request = installerRequest({
      host: "localhost:3000",
      "x-forwarded-proto": "http",
    });

    const body = await (await GET(request)).text();
    expect(body).toMatch(/\$expectedSha256 = '[0-9A-F]{64}'/);
  });

  it("does not pin a byte-fingerprint for another deployment's copy of the payload", async () => {
    // A site install whose stable base is its separately-versioned central
    // server: byte-equality cannot be assumed, so structural checks carry it.
    vi.stubEnv("DEPLOYMENT_ROLE", "site");
    vi.stubEnv("PLATFORM_BASE_URL", "https://central.example.com");
    const request = installerRequest({
      host: "pos.cafe.example.com",
      "x-forwarded-proto": "https",
    });

    const body = await (await GET(request)).text();
    expect(body).toContain("$scriptUrl = 'https://central.example.com/windows/cafe-pos-print-connector.ps1'");
    expect(body).toContain("$expectedSha256 = ''");
  });
});
