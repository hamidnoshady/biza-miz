/**
 * HTTP end-to-end check of the support ticket routes, tenant + platform.
 *
 * Seeds a business/user/admin, mints real session cookies (same JWT secret
 * the server uses), and exercises every route over HTTP against a running
 * `npm start` server. Manual smoke tool — not part of the test suite.
 *
 * Usage (server must already be running on PORT):
 *   JWT_SECRET=... PORT=3100 npx tsx scripts/http-smoke-support.ts
 */
import { randomUUID } from "node:crypto";
import { query, withTenant, withoutTenantScope } from "../src/lib/db";
import { signSession } from "../src/lib/auth-edge";
import { createSession } from "../src/lib/employee-service";
import { signPlatformSession } from "../src/lib/platform-auth-edge";

const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3100";
const SESSION_COOKIE = "pos_session";
const PLATFORM_COOKIE = "pos_platform_session";

async function main() {
  const suffix = randomUUID().slice(0, 8);
  const [biz] = (
    await query<{ id: string }>(`INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`, [
      `Http Smoke Cafe ${suffix}`,
      `http-smoke-${suffix}`,
    ])
  ).rows;
  const [loc] = (
    await query<{ id: string }>(`INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id`, [biz.id])
  ).rows;
  const [owner] = (
    await query<{ id: string }>(
      `INSERT INTO users (business_id, location_id, role, full_name, pin_hash) VALUES ($1, $2, 'owner', 'Http Owner', 'x') RETURNING id`,
      [biz.id, loc.id],
    )
  ).rows;
  const [admin] = (
    await withoutTenantScope("platform", () =>
      query<{ id: string }>(`INSERT INTO platform_admins (email, password_hash, full_name) VALUES ($1, 'x', 'Http Admin') RETURNING id`, [
        `http-smoke-${suffix}@example.com`,
      ]),
    )
  ).rows;

  // A tenant token must name a revocable session row; the server refuses one
  // that does not (#854 follow-up, third pass).
  const { session: ownerSession } = await withTenant(biz.id, () =>
    createSession(owner.id, biz.id, { locationId: loc.id, loginMethod: "password", deviceLabel: "http smoke" }),
  );
  const tenantToken = await signSession({
    sub: owner.id,
    role: "owner",
    businessId: biz.id,
    businessSlug: `http-smoke-${suffix}`,
    locationId: loc.id,
    fullName: "Http Owner",
    employeeSessionId: ownerSession.id,
  });
  const platformToken = await signPlatformSession({
    padmin: admin.id,
    role: "owner",
    fullName: "Http Admin",
    email: `http-smoke-${suffix}@example.com`,
  });

  const tenantCookie = `${SESSION_COOKIE}=${tenantToken}`;
  const platformCookie = `${PLATFORM_COOKIE}=${platformToken}`;

  async function call(path: string, init: RequestInit & { cookie?: string }) {
    const res = await fetch(`${BASE}${path}`, {
      // The middleware answers an unauthenticated /api/platform call with a
      // 307 to /platform/login; follow nothing so the check sees the redirect.
      redirect: "manual",
      ...init,
      headers: {
        "Content-Type": "application/json",
        // The middleware's CSRF guard requires a same-origin Origin on
        // mutating requests — a real browser sends one automatically.
        Origin: new URL(BASE).origin,
        ...(init.cookie ? { Cookie: init.cookie } : {}),
        ...(init.headers ?? {}),
      },
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* no body */
    }
    return { status: res.status, data: data as Record<string, unknown> };
  }

  // --- Tenant routes --------------------------------------------------------
  const created = await call("/api/support/tickets", {
    method: "POST",
    cookie: tenantCookie,
    body: JSON.stringify({
      subject: "HTTP تیکت آزمایشی",
      category: "billing",
      priority: "urgent",
      description: "شرح از طریق HTTP",
      attachment: null,
    }),
  });
  if (created.status !== 201) throw new Error(`create failed: ${created.status} ${JSON.stringify(created.data)}`);
  const ticket = (created.data.ticket ?? {}) as { id: string; status: string; subject: string };
  console.log("POST /api/support/tickets ->", created.status, ticket.id, ticket.status);

  const list = await call("/api/support/tickets?limit=50", { cookie: tenantCookie });
  if (list.status !== 200 || !Array.isArray((list.data.tickets as unknown[] | undefined))) throw new Error("list failed");
  console.log("GET /api/support/tickets ->", list.status, "count:", ((list.data.tickets as unknown[]) ?? []).length);

  const detail = await call(`/api/support/tickets/${ticket.id}`, { cookie: tenantCookie });
  if (detail.status !== 200) throw new Error("detail failed");
  console.log("GET /api/support/tickets/[id] ->", detail.status);

  const reply = await call(`/api/support/tickets/${ticket.id}/messages`, {
    method: "POST",
    cookie: tenantCookie,
    body: JSON.stringify({ body: "پاسخ کاربر از HTTP", attachment: null }),
  });
  if (reply.status !== 201) throw new Error("reply failed");
  console.log("POST /api/support/tickets/[id]/messages ->", reply.status);

  const close = await call(`/api/support/tickets/${ticket.id}`, {
    method: "PATCH",
    cookie: tenantCookie,
    body: JSON.stringify({ status: "closed" }),
  });
  if (close.status !== 200 || ((close.data.ticket as { status?: string } | undefined)?.status ?? "") !== "closed") {
    throw new Error("close failed");
  }
  console.log("PATCH /api/support/tickets/[id] ->", close.status, "closed");

  // Unauthenticated must fail.
  const anon = await call("/api/support/tickets", {});
  if (anon.status !== 401) throw new Error(`anon should 401, got ${anon.status}`);
  console.log("anonymous ->", anon.status);

  // --- Platform routes ------------------------------------------------------
  const platList = await call("/api/platform/support/tickets?limit=50", { cookie: platformCookie });
  if (platList.status !== 200 || !Array.isArray((platList.data.tickets as unknown[] | undefined))) throw new Error("platform list failed");
  console.log("GET /api/platform/support/tickets ->", platList.status, "count:", ((platList.data.tickets as unknown[]) ?? []).length, "stats:", JSON.stringify(platList.data.stats));

  const platDetail = await call(`/api/platform/support/tickets/${ticket.id}`, { cookie: platformCookie });
  if (platDetail.status !== 200) throw new Error("platform detail failed");
  console.log("GET /api/platform/support/tickets/[id] ->", platDetail.status, "messages:", ((platDetail.data.ticket as { messages?: unknown[] } | undefined)?.messages ?? []).length);

  const platReply = await call(`/api/platform/support/tickets/${ticket.id}/messages`, {
    method: "POST",
    cookie: platformCookie,
    body: JSON.stringify({ body: "پاسخ پشتیبانی از HTTP" }),
  });
  if (platReply.status !== 201) throw new Error("platform reply failed");
  console.log("POST /api/platform/support/tickets/[id]/messages ->", platReply.status);

  const platUpdate = await call(`/api/platform/support/tickets/${ticket.id}`, {
    method: "PATCH",
    cookie: platformCookie,
    body: JSON.stringify({ status: "resolved", priority: "high", assignedAdminId: admin.id }),
  });
  if (platUpdate.status !== 200) throw new Error("platform update failed");
  const updated = platUpdate.data.ticket as { status?: string; priority?: string; assignedAdminName?: string };
  console.log("PATCH /api/platform/support/tickets/[id] ->", platUpdate.status, updated.status, updated.priority, updated.assignedAdminName);

  // The middleware answers with a 307 → /platform/login; either is a denial.
  const platAnon = await call("/api/platform/support/tickets", {});
  if (platAnon.status !== 401 && platAnon.status !== 307) {
    throw new Error(`platform anon should be denied, got ${platAnon.status}`);
  }
  console.log("platform anonymous ->", platAnon.status);

  // Cleanup
  await query(`DELETE FROM businesses WHERE id = $1`, [biz.id]);
  await withoutTenantScope("platform", () => query(`DELETE FROM platform_admins WHERE id = $1`, [admin.id]));
  console.log("HTTP SMOKE PASSED");
}

main().catch((err) => {
  console.error("HTTP SMOKE FAILED:", err);
  process.exit(1);
});
