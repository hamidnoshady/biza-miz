import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  cspMode,
  generateNonce,
  TELEGRAM_WEB_FRAME_ANCESTORS,
  CSP_REPORT_GROUP,
  CSP_REPORT_PATH,
  KB_VIDEO_FRAME_SOURCES,
  cmsFrameSources,
  contentSecurityPolicy,
  cspReportingEndpoints,
  sameOriginSocketSources,
  staticSecurityHeaders,
  telegramFrameAncestorsDirective,
} from "./security-headers";
import { kbVideoSource } from "./knowledge";

describe("security-headers", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("cspMode defaults to report-only", () => {
    delete process.env.CSP_MODE;
    expect(cspMode()).toBe("report-only");

    process.env.CSP_MODE = "off";
    expect(cspMode()).toBe("off");

    process.env.CSP_MODE = "enforce";
    expect(cspMode()).toBe("enforce");
  });

  it("generateNonce produces a 32-character hex string", () => {
    const nonce = generateNonce();
    expect(typeof nonce).toBe("string");
    expect(nonce.length).toBe(32);
    expect(/^[0-9a-f]+$/.test(nonce)).toBe(true);
  });

  it("contentSecurityPolicy includes nonce and frame-ancestors", () => {
    const csp = contentSecurityPolicy("test-nonce", { https: false });
    expect(csp).toContain("'nonce-test-nonce'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("upgrade-insecure-requests");

    const cspHttps = contentSecurityPolicy("test-nonce", { https: true });
    expect(cspHttps).toContain("upgrade-insecure-requests");

    const reportOnly = contentSecurityPolicy("test-nonce", { https: true, reportOnly: true });
    expect(reportOnly).not.toContain("upgrade-insecure-requests");
  });

  it("allows only Telegram Web to frame Mini App sessions, while retaining DENY elsewhere", () => {
    const regularPage = contentSecurityPolicy("nonce", { https: true });
    expect(regularPage).toContain("frame-ancestors 'none'");
    expect(regularPage).not.toContain("web.telegram.org");

    const miniApp = contentSecurityPolicy("nonce", { https: true, telegramMiniApp: true });
    expect(miniApp).toContain("frame-ancestors 'self' https://web.telegram.org");
    expect(miniApp).not.toContain("webk.telegram.org");
    expect(miniApp).not.toContain("weba.telegram.org");
    expect(miniApp).not.toMatch(/frame-ancestors[^;]*\*/);

    expect(staticSecurityHeaders({ https: true })["X-Frame-Options"]).toBe("DENY");
    expect(staticSecurityHeaders({ https: true, telegramMiniApp: true })["X-Frame-Options"]).toBeUndefined();
    expect(telegramFrameAncestorsDirective()).toBe("frame-ancestors 'self' https://web.telegram.org");
    expect(TELEGRAM_WEB_FRAME_ANCESTORS).toEqual(["https://web.telegram.org"]);
  });

  it("allows connected website media over HTTP(S) without widening scripts or connections", () => {
    const csp = contentSecurityPolicy("test-nonce", { https: false });
    expect(csp).toContain("img-src 'self' data: blob: http: https:");
    expect(csp).not.toContain("script-src http:");
    expect(csp).not.toContain("connect-src http: https:");
  });

  it("lets the sandboxed print-template preview carry its font as a data URI, and nothing wider", () => {
    const csp = contentSecurityPolicy("test-nonce", { https: true });
    expect(csp).toContain("font-src 'self' data:;");
    expect(csp).not.toContain("font-src 'self' data: https:");
    expect(csp).toContain("script-src 'self' 'nonce-test-nonce' 'strict-dynamic'");
  });

  it("allows only the loopback print-connector origins in connect-src", () => {
    process.env.NEXT_PUBLIC_PRINT_CONNECTOR_URL = "http://localhost:9555";
    const csp = contentSecurityPolicy("test-nonce", { https: true });
    expect(csp).toContain("http://127.0.0.1:9123");
    expect(csp).toContain("http://localhost:9123");
    expect(csp).toContain("http://localhost:9555");

    process.env.NEXT_PUBLIC_PRINT_CONNECTOR_URL = "https://attacker.example";
    expect(contentSecurityPolicy("test-nonce", { https: true })).not.toContain("attacker.example");
  });

  it("frames only the configured CMS origins, and nothing malformed", () => {
    expect(
      cmsFrameSources({
        ESHOBE_CMS_URL: "https://cms.example.com/some/path",
        CMS_EMBED_ORIGINS: "https://cms2.example.com, javascript:alert(1), not a url, ftp://x.example, https://cms.example.com",
      }),
    ).toEqual(["https://cms.example.com", "https://cms2.example.com"]);
    expect(cmsFrameSources({})).toEqual([]);

    const prev = process.env.ESHOBE_CMS_URL;
    process.env.ESHOBE_CMS_URL = "https://cms.example.com";
    try {
      const csp = contentSecurityPolicy("test-nonce", { https: true });
      expect(csp).toContain("frame-src 'self' https://cms.example.com");
      // Still no wildcard framing, and the dashboard itself stays unframeable.
      expect(csp).not.toMatch(/frame-src[^;]*\*/);
      expect(csp).toContain("frame-ancestors 'none'");
    } finally {
      if (prev === undefined) delete process.env.ESHOBE_CMS_URL;
      else process.env.ESHOBE_CMS_URL = prev;
    }
    // With no CMS configured: this origin and the knowledge-base video players,
    // exactly — nothing else may be framed.
    expect(contentSecurityPolicy("test-nonce", { https: true })).toContain(
      `frame-src 'self' ${KB_VIDEO_FRAME_SOURCES.join(" ")};`,
    );
  });

  it("frames exactly the embed players kbVideoSource produces, so knowledge-base videos survive enforcement", () => {
    const embedOrigins = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.aparat.com/v/abc123",
      "https://vimeo.com/123456",
    ]
      .map((url) => kbVideoSource(url))
      .map((source) => {
        expect(source?.kind).toBe("embed");
        return new URL(source!.src).origin;
      });
    expect([...new Set(embedOrigins)].sort()).toEqual([...KB_VIDEO_FRAME_SOURCES].sort());

    const csp = contentSecurityPolicy("test-nonce", { https: true });
    const frameSrc = csp.split("; ").find((part) => part.startsWith("frame-src "));
    for (const origin of embedOrigins) expect(frameSrc).toContain(origin);
    // A direct video file plays in <video>, which needs media-src, not a frame.
    expect(csp).toContain("media-src 'self' blob: https:");
    expect(csp).not.toMatch(/frame-src[^;]*\*/);
  });

  it("drops plain-HTTP image and media sources on an HTTPS page, and keeps them for a local HTTP deployment", () => {
    const https = contentSecurityPolicy("test-nonce", { https: true });
    expect(https).toContain("img-src 'self' data: blob: https:;");
    expect(https).toContain("media-src 'self' blob: https:;");
    expect(https).not.toMatch(/(img|media)-src[^;]*\bhttp:/);

    const http = contentSecurityPolicy("test-nonce", { https: false });
    expect(http).toContain("img-src 'self' data: blob: http: https:;");
    expect(http).toContain("media-src 'self' blob: http: https:;");
  });

  it("allows WebSockets to this origin only — never the bare ws:/wss: schemes", () => {
    const connectSrc = (host?: string | null, https = true) =>
      contentSecurityPolicy("test-nonce", { https, host })
        .split("; ")
        .find((part) => part.startsWith("connect-src "))!;

    const hosted = connectSrc("Acme.POS.example.com");
    expect(hosted).toContain("wss://acme.pos.example.com");
    expect(hosted.split(" ")).not.toContain("ws:");
    expect(hosted.split(" ")).not.toContain("wss:");

    // The desktop serves http://127.0.0.1:{port}; the port is part of the origin.
    expect(connectSrc("127.0.0.1:3000", false)).toContain("ws://127.0.0.1:3000");
    expect(connectSrc("[::1]:3000", false)).toContain("ws://[::1]:3000");

    // No host: 'self' alone, which is stricter, not wider.
    expect(connectSrc(null)).toMatch(/^connect-src 'self' http:\/\/127\.0\.0\.1:9123/);
    expect(connectSrc("")).not.toContain("ws");

    // A forged Host header must not be able to smuggle in a directive or a source.
    for (const forged of [
      "evil.example; script-src *",
      "evil.example *",
      "evil.example/path",
      "evil.example,other.example",
      "\"evil.example\"",
      "evil.example:99999999",
    ]) {
      const directive = connectSrc(forged);
      expect(directive, forged).not.toContain("evil.example");
      expect(sameOriginSocketSources(forged), forged).toEqual([]);
    }
  });

  it("reports violations to the collector, with report-to only where the Reporting API can deliver", () => {
    const http = contentSecurityPolicy("test-nonce", { https: false });
    expect(http).toContain(`report-uri ${CSP_REPORT_PATH}`);
    // A browser that understands report-to ignores report-uri, and will not
    // post to a non-trustworthy (plain-HTTP LAN) endpoint — so not here.
    expect(http).not.toContain("report-to");

    const https = contentSecurityPolicy("test-nonce", { https: true, reportOnly: true });
    expect(https).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(https).toContain(`report-to ${CSP_REPORT_GROUP}`);
    expect(cspReportingEndpoints()).toBe(`${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`);
    expect(CSP_REPORT_PATH).toBe("/api/csp-report");
  });

  it("staticSecurityHeaders respects https parameter", () => {
    const headersHttp = staticSecurityHeaders({ https: false });
    expect(headersHttp["Permissions-Policy"]).toContain("camera=(self)");
    expect(headersHttp["Permissions-Policy"]).toContain("publickey-credentials-get=(self)");
    expect(headersHttp["Permissions-Policy"]).toContain("loopback-network=(self)");
    expect(headersHttp["Permissions-Policy"]).toContain("local-network-access=(self)");
    expect(headersHttp["Strict-Transport-Security"]).toBeUndefined();

    const headersHttps = staticSecurityHeaders({ https: true });
    expect(headersHttps["Strict-Transport-Security"]).toBe("max-age=31536000; includeSubDomains");
  });
});
