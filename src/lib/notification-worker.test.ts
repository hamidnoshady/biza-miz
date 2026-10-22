import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function worker() {
  const handlers: Record<string, (event: Record<string, unknown>) => void> = {};
  const storage = new Map<string, Response>();
  const showNotification = vi.fn();
  const close = vi.fn();
  const caches = {
    open: async () => ({
      match: async (key: string) => storage.get(key)?.clone(),
      put: async (key: string, value: Response) => {
        storage.set(key, value);
      },
    }),
  };
  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    caches,
    Response,
    URL,
    self: {
      addEventListener: (name: string, fn: (typeof handlers)[string]) => {
        handlers[name] = fn;
      },
      registration: { showNotification, getNotifications: async () => [{ close }] },
      location: { origin: "https://example.test" },
    },
  });
  async function fire(name: string, data: Record<string, unknown>) {
    const promises: Promise<unknown>[] = [];
    handlers[name]({ ...data, waitUntil: (promise: Promise<unknown>) => promises.push(promise) });
    await Promise.all(promises);
  }
  return { fire, showNotification, close };
}
describe("shared-device worker confidentiality", () => {
  it("never displays late private content after logout or another account's binding", async () => {
    const w = worker();
    await w.fire("message", { data: { type: "notification-binding", identity: "tenant:A" } });
    const payload = {
      identity: "tenant:A",
      title: "Private financial figure",
      body: "secret",
      url: "/accounting",
      tag: "fact",
      severity: "critical",
    };
    await w.fire("push", { data: { json: () => payload } });
    expect(w.showNotification).toHaveBeenLastCalledWith(
      payload.title,
      expect.objectContaining({ body: "secret", renotify: false, requireInteraction: false }),
    );
    await w.fire("message", { data: { type: "notification-binding", identity: null } });
    expect(w.close).toHaveBeenCalled();
    await w.fire("push", { data: { json: () => payload } });
    expect(w.showNotification).toHaveBeenLastCalledWith(
      "اعلان تازه",
      expect.objectContaining({ body: "برای مشاهده وارد حساب خود شوید." }),
    );
    await w.fire("message", { data: { type: "notification-binding", identity: "otherTenant:B" } });
    await w.fire("push", { data: { json: () => payload } });
    expect(w.showNotification).toHaveBeenLastCalledWith(
      "اعلان تازه",
      expect.not.objectContaining({ body: "secret" }),
    );
  });
});
