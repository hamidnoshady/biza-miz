import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Electron packages this traced production tree, never the repository's
  // development node_modules. The custom WebSocket/background server is
  // bundled separately by scripts/build-desktop-runtime.mjs.
  output: "standalone",
  async headers() {
    const commonHeaders = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "X-DNS-Prefetch-Control", value: "off" },
      { key: "Permissions-Policy", value: "camera=(self), publickey-credentials-get=(self)" },
    ];
    return [
      {
        source: "/(.*)",
        headers: commonHeaders,
      },
      {
        source: "/(.*)",
        has: [
          {
            type: "header",
            key: "x-forwarded-proto",
            value: "https",
          },
        ],
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ];
  },
  /**
   * `unpdf` (the server-side PDF text extractor used by /api/ai/chat) ships
   * pdf.js with dynamic optional-worker imports that bundlers cannot fold in.
   * Keep both packages external so Node resolves them natively at runtime —
   * the import is lazy and only the chat route ever loads them.
   */
  /**
   * `sharp` (migration 0175 — deterministic crop/rotate/resize transforms)
   * ships prebuilt native bindings; webpack should never try to trace/bundle
   * those, same reasoning as unpdf/pdfjs-dist above.
   */
  serverExternalPackages: ["unpdf", "pdfjs-dist", "sharp"],
  /**
   * The AI console was slimmed down to the LiteLLM gateway settings only: the
   * platform's AI section is one page, and every user-level AI settings
   * surface is gone. Old bookmarks land on the pages that remain.
   */
  async redirects() {
    return [
      { source: "/platform/ai/gateway", destination: "/platform/ai", permanent: false },
      { source: "/platform/ai/prompts", destination: "/platform/ai", permanent: false },
      { source: "/dashboard/ai/settings", destination: "/ai", permanent: false },
      { source: "/ai/settings", destination: "/ai", permanent: false },
    ];
  },
  /**
   * Phase 34 — the OAuth discovery documents live at `/.well-known/…`, which is
   * where RFC 8414 and RFC 9728 say to look and where every MCP client goes
   * first. Next's app router will not serve a dot-prefixed route folder, so the
   * handlers live under `/api/well-known/*` and are rewritten into place here.
   *
   * Each document is exposed twice on purpose. RFC 9728 specifies the
   * *path-inserted* form for a resource that is not at the site root — for
   * `/api/mcp` that is `/.well-known/oauth-protected-resource/api/mcp` — while
   * many clients try the bare path. A 404 on either is indistinguishable from
   * "this server does not support OAuth", after which a connector fails to add
   * with no error anyone can see, so both are answered.
   */
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/well-known/oauth-protected-resource",
      },
      {
        source: "/.well-known/oauth-protected-resource/:path*",
        destination: "/api/well-known/oauth-protected-resource/:path*",
      },
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/well-known/oauth-authorization-server",
      },
      {
        source: "/.well-known/oauth-authorization-server/:path*",
        destination: "/api/well-known/oauth-authorization-server/:path*",
      },
    ];
  },
};

export default nextConfig;
