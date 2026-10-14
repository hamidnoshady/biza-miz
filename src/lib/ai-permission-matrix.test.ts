/**
 * Issue #812 §11 — the AI permission matrix, asserted rather than documented.
 *
 * The issue requires that every remaining AI API has an *explicit, correct*
 * permission guard. `api-guards.test.ts` proves a guard exists; this file pins
 * which one, which is the half that actually matters — a route that answers
 * `requireManager()` when it should answer `requirePermission(PERMISSIONS.aiUse)`
 * passes the existence check and fails the boundary.
 *
 * Three rules the matrix encodes:
 *
 *  1. Ordinary chat and the assistant's read surfaces ride on `ai.use` plus the
 *     underlying domain permissions. Using the assistant is not a management
 *     capability.
 *  2. Every write to the management surfaces takes a named AI capability —
 *     `ai.manage` for memory, `ai.automations.manage` for the automation engine,
 *     `ai.widgets.manage` for widgets. `requireManager()` on a write here would
 *     make "manager" the definition of AI administration, which is a role
 *     deciding a capability.
 *  3. The Superadmin control plane (`/api/platform/ai/*`) takes a *platform*
 *     capability and never a tenant permission, because it changes what every
 *     business's assistant does.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const API_ROOT = "src/app/api";

/** Every route.ts under the AI surface, as a path relative to the repo root. */
function aiRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "route.ts") out.push(full);
    }
  };
  walk(join(API_ROOT, "ai"));
  return out.sort();
}

const routes = aiRoutes();

describe("issue #812 §11 — the AI permission matrix", () => {
  it("found the AI routes to check", () => {
    expect(routes.length).toBeGreaterThan(20);
  });

  it("guards every tenant AI route on a capability, never on a bare role list", () => {
    for (const route of routes) {
      const src = readFileSync(route, "utf8");
      // A bare `requireManager()`/`requireOwner()` on an AI route is the thing
      // this file exists to catch: it lets a role decide a capability, so the
      // next role added silently inherits AI administration.
      expect(src, `${route} guards on a role list, not a capability`).not.toMatch(/requireManager\(\)|requireOwner\(\)/);
      // A capability, or the ownership shape `api-guards.test.ts` already
      // whitelists: a conversation and its input requests reach tenant scope
      // only through the caller's own `actorUserId`, so ownership IS the
      // authorization there and a role list would be the wrong question.
      expect(src, `${route} names no permission at all`).toMatch(
        /requirePermission\(|requireAnyPermission\(|requireMember\(|ownsConversation\(|actorUserId/,
      );
    }
  });

  it("keeps ordinary chat on ai.use — using the assistant is not administering it", () => {
    for (const route of [
      "src/app/api/ai/chat/route.ts",
      "src/app/api/ai/search/route.ts",
      "src/app/api/ai/widgets/[id]/run/route.ts",
    ]) {
      const src = readFileSync(route, "utf8");
      expect(src, `${route} must be reachable on ai.use`).toMatch(/PERMISSIONS\.aiUse/);
      // …and must not additionally demand a management capability, which would
      // lock the assistant away from the members it is built for.
      expect(src, `${route} must not demand a management capability`).not.toMatch(
        /PERMISSIONS\.(aiManage|aiAutomationsManage)/,
      );
    }
  });

  it("takes the named management capability on every management write", () => {
    const expected: Record<string, string> = {
      "src/app/api/ai/memory/route.ts": "aiManage",
      "src/app/api/ai/config/route.ts": "aiManage",
      "src/app/api/ai/automations/route.ts": "aiAutomationsManage",
      "src/app/api/ai/automations/[id]/route.ts": "aiAutomationsManage",
      "src/app/api/ai/automations/[id]/preview/route.ts": "aiAutomationsManage",
      "src/app/api/ai/automations/[id]/run/route.ts": "aiAutomationsManage",
    };
    for (const [route, permission] of Object.entries(expected)) {
      const src = readFileSync(route, "utf8");
      expect(src, `${route} must take ${permission}`).toMatch(new RegExp(`PERMISSIONS\\.${permission}`));
    }
  });

  it("guards a workspace widget with the intersection, not a management key", () => {
    // §11 — there is no `ai.widgets.manage` any more, and there does not need to
    // be: a widget is a saved prompt that runs with its creator's OWN
    // permissions, and the service refuses any widget whose requiredPermissions
    // the caller does not already hold. That is a stronger boundary than a
    // dedicated key would be, because it holds per widget rather than per member
    // and it fails closed on an unknown permission.
    //
    // So the assertion here is the intersection itself, not a key: the routes
    // take `ai.use` and hand the caller's effective set to the service, which
    // is what actually decides.
    for (const route of [
      "src/app/api/ai/widgets/route.ts",
      "src/app/api/ai/widgets/[id]/route.ts",
      "src/app/api/ai/widgets/[id]/run/route.ts",
    ]) {
      const src = readFileSync(route, "utf8");
      expect(src, `${route} must be reachable on ai.use`).toMatch(/PERMISSIONS\.aiUse/);
      expect(src, `${route} must pass the caller's effective permissions through`).toMatch(
        /membership\.permissions/,
      );
    }
    const lib = readFileSync("src/lib/ai-widgets.ts", "utf8");
    expect(lib, "a widget may never out-grow its creator").toContain("widget_permission_widening");
    expect(lib).toMatch(/requiredPermissions\.some\(\(?\s*permission\s*\)?\s*=>/);
  });

  it("leaves usage reporting readable to whoever may see it, writable to nobody", () => {
    // §12: usage/cost attribution is a read surface for `ai.usage.view` or
    // `ai.manage` — a member who is spending the assistant's budget is entitled
    // to see it. There is no write half at all: usage is written by settlement.
    const usage = readFileSync("src/app/api/ai/usage/route.ts", "utf8");
    expect(usage).toMatch(/requireAnyPermission\(\s*PERMISSIONS\.aiUsageView,\s*PERMISSIONS\.aiManage\s*\)/);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(usage, `usage must not be writable via ${method}`).not.toContain(`export const ${method}`);
    }
  });

  it("applies a manual write through the caller's own authority, not a management key", () => {
    // §1/§12: `proposals/apply` is a manual write. It re-checks the underlying
    // domain permission per action at apply time, so `ai.manage` on the route is
    // the assistant's own boundary and never a substitute for the caller's.
    const apply = readFileSync("src/app/api/ai/proposals/apply/route.ts", "utf8");
    expect(apply).toMatch(/PERMISSIONS\.aiUse/);
    expect(apply).toMatch(/requirePermission|authorizeAction|currentPermissions/);
  });

  it("leaves the platform control plane on platform capabilities, never tenant ones", () => {
    const platform = [
      "src/app/api/platform/ai/modes/route.ts",
      "src/app/api/platform/ai/prompts/route.ts",
      "src/app/api/platform/ai/agents/route.ts",
      "src/app/api/platform/ai/research/route.ts",
    ];
    for (const route of platform) {
      const src = readFileSync(route, "utf8");
      expect(src, `${route} must take a platform capability`).toMatch(/requirePlatformCapability\("/);
      expect(src, `${route} must not be reachable on a tenant permission`).not.toMatch(
        /requirePermission|requireManager|PERMISSIONS\./,
      );
    }
  });

  it("no longer carries the retired AI permissions anywhere", () => {
    // §4/§11: the tenant Agent Builder and the tenant knowledge manager are
    // gone, and the widget surface turned out to be protected by an intersection
    // rather than a key. An advertised capability that gates nothing is a
    // permission a reviewer stops trusting, so all three keys are gone.
    const retired = ["ai.agents.manage", "ai.knowledge.manage", "ai.widgets.manage"];
    for (const route of routes) {
      const src = readFileSync(route, "utf8");
      for (const key of retired) {
        expect(src, `${route} still references the retired ${key}`).not.toContain(key);
      }
    }
    for (const file of ["src/lib/permission-registry.ts", "src/lib/permissions.ts"]) {
      const src = readFileSync(file, "utf8");
      for (const key of retired) {
        expect(src, `${file} still declares the retired ${key}`).not.toContain(key);
      }
    }
  });
});
