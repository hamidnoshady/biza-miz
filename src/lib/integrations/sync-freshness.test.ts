import { describe, expect, it } from "vitest";
import {
  assessDomainFreshness,
  domainForEntityType,
  domainForTopic,
  noDomainTraffic,
  SYNC_DOMAINS,
  SYNC_DOMAIN_SOURCES,
} from "./sync-freshness";

const NOW = new Date("2026-11-02T12:00:00Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();
const WARN = 180_000; // three one-minute cycles

const grade = (rows: Parameters<typeof assessDomainFreshness>[0]) =>
  assessDomainFreshness(rows, NOW, { warnAfterMs: WARN });
const byDomain = (rows: Parameters<typeof assessDomainFreshness>[0]) =>
  Object.fromEntries(grade(rows).map((entry) => [entry.domain, entry]));

describe("domain mapping (issue #1206 P1)", () => {
  it("names every entity type the outbox can carry for a domain", () => {
    expect(domainForEntityType("stock")).toBe("stock");
    expect(domainForEntityType("price")).toBe("prices");
    expect(domainForEntityType("product_publish")).toBe("products");
    expect(domainForEntityType("refund_create")).toBe("orders");
    expect(domainForEntityType("media_create")).toBe("content");
    expect(domainForEntityType("taxonomy_ensure")).toBe("content");
    // Not a domain: the probe observes the pipeline, it moves no data.
    expect(domainForEntityType("cron_probe")).toBeNull();
  });

  it("maps store topics by family, and leaves the probe's own traffic alone", () => {
    expect(domainForTopic("order.updated")).toBe("orders");
    expect(domainForTopic("refund.created")).toBe("orders");
    expect(domainForTopic("product.deleted")).toBe("products");
    expect(domainForTopic("customer.updated")).toBe("customers");
    expect(domainForTopic("post.updated")).toBe("content");
    expect(domainForTopic("plugin.ping")).toBeNull();
  });

  it("covers all six domains the issue names", () => {
    expect([...SYNC_DOMAINS]).toEqual(["products", "stock", "prices", "orders", "customers", "content"]);
    for (const domain of SYNC_DOMAINS) {
      expect(SYNC_DOMAIN_SOURCES[domain].outbound.length + SYNC_DOMAIN_SOURCES[domain].inbound.length).toBeGreaterThan(0);
    }
  });
});

describe("assessDomainFreshness (issue #1206 P1)", () => {
  it("reports every domain, including the silent ones — omission looks like health", () => {
    const entries = grade({ outbound: [], inbound: [] });
    expect(entries.map((entry) => entry.domain)).toEqual([...SYNC_DOMAINS]);
    expect(entries.every((entry) => entry.state === "never")).toBe(true);
  });

  it("does not call a quiet shop stale: no traffic today is not a fault", () => {
    // Nothing has moved for a day, and nothing is waiting: that is a shop with
    // no orders, not a broken pipeline.
    const orders = byDomain({
      outbound: [{ entity_type: "orders_export", backlog: 0, oldest: null, last_sent: ago(24 * 3600) }],
      inbound: [{ event_topic: "order.updated", last_processed: ago(24 * 3600) }],
    }).orders;
    expect(orders.state).toBe("ok");
    expect(orders.reason).toBe("no_backlog");
    expect(orders.lastExchangeAt).toBe(ago(24 * 3600));
  });

  it("calls a domain delayed only when work is waiting and not moving", () => {
    const stock = byDomain({
      outbound: [{ entity_type: "stock", backlog: 4, oldest: ago(600), last_sent: ago(1200) }],
      inbound: [],
    }).stock;
    expect(stock.state).toBe("delayed");
    expect(stock.reason).toBe("backlog_not_draining");
    expect(stock.backlog).toBe(4);
    expect(stock.oldestBacklogSeconds).toBe(600);
  });

  it("keeps a fresh backlog ok — it is draining, not stuck", () => {
    const stock = byDomain({
      outbound: [{ entity_type: "stock", backlog: 2, oldest: ago(20), last_sent: ago(60) }],
      inbound: [],
    }).stock;
    expect(stock.state).toBe("ok");
    expect(stock.reason).toBe("backlog_draining");
  });

  it("grades one domain on its own evidence, never on another's", () => {
    // Products are stalled; orders are fine and must stay fine.
    const picture = byDomain({
      outbound: [
        { entity_type: "product_update", backlog: 9, oldest: ago(900), last_sent: ago(900) },
        { entity_type: "order_status", backlog: 0, oldest: null, last_sent: ago(30) },
      ],
      inbound: [{ event_topic: "order.updated", last_processed: ago(25) }],
    });
    expect(picture.products.state).toBe("delayed");
    expect(picture.orders.state).toBe("ok");
    expect(picture.prices.state).toBe("never");
  });

  it("takes the latest exchange across both directions, and the oldest backlog per domain", () => {
    const picture = byDomain({
      outbound: [
        { entity_type: "catalogue_export", backlog: 1, oldest: ago(500), last_sent: ago(400) },
        { entity_type: "product_publish", backlog: 1, oldest: ago(700), last_sent: ago(50) },
      ],
      inbound: [{ event_topic: "product.updated", last_processed: ago(10) }],
    }).products;
    expect(picture.lastExchangeAt).toBe(ago(10));
    expect(picture.backlog).toBe(2);
    expect(picture.oldestBacklogSeconds).toBe(700);
  });

  it("says «waiting, never sent» when a domain has a backlog but no exchange yet", () => {
    const customers = byDomain({
      outbound: [{ entity_type: "customer_export", backlog: 1, oldest: ago(30), last_sent: null }],
      inbound: [],
    }).customers;
    expect(customers.state).toBe("never");
    expect(customers.reason).toBe("backlog_not_sent_yet");
  });

  it("has a shape the overview can hand to a client that has no rows", () => {
    const all = noDomainTraffic();
    expect(all).toHaveLength(SYNC_DOMAINS.length);
    expect(all.every((entry) => entry.state === "never" && entry.backlog === 0)).toBe(true);
  });
});
