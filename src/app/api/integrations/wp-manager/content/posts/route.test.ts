import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Scheduling a post or page (#1215, P2-5). The dangerous half is not the write
 * itself but the two silent failures around it: a `future` post with no date
 * publishes on the next cron pass, and a date carried by an absolute-looking
 * string reaches WordPress an hour off if nobody pinned its shape. Both are
 * refused at this boundary.
 */
const m = vi.hoisted(() => ({
  connection: vi.fn(),
  getContent: vi.fn(),
  enqueue: vi.fn(),
  findCreate: vi.fn(),
  upsert: vi.fn(),
  audit: vi.fn(),
  client: vi.fn(),
  getPost: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: async () => ({ session: { businessId: "tenant", sub: "user" }, error: null }),
  withTenantScope: (fn: unknown) => fn,
}));
vi.mock("@/lib/integrations/connection-access", () => ({ getAccessibleConnection: m.connection }));
vi.mock("@/lib/integrations/connections-service", () => ({ wooClientFor: () => ({ wpUpsertPost: m.client, wpGetPost: m.getPost }) }));
vi.mock("@/lib/integrations/audit", () => ({ writeIntegrationAudit: m.audit }));
vi.mock("@/lib/integrations/wp-content-service", () => ({
  enqueueWpPostUpsert: m.enqueue,
  findWpContentCreateRequest: m.findCreate,
  getWpContent: m.getContent,
  upsertWpContent: m.upsert,
}));

import { POST } from "./route";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const FUTURE = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

function post(body: Record<string, unknown>) {
  return new Request("http://test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectionId: CONNECTION_ID, post_type: "post", ...body }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.connection.mockResolvedValue({
    id: CONNECTION_ID,
    provider: "woocommerce",
    status: "active",
    link_mode: "plugin",
    plugin_capabilities: { jobTypes: ["post_upsert"], postSchedule: true, contentTaxonomies: true },
  });
  m.getContent.mockResolvedValue(null);
  m.enqueue.mockResolvedValue("queued");
  m.audit.mockResolvedValue(undefined);
});

describe("scheduling validation", () => {
  it("refuses a future status with no date instead of letting the site publish it", async () => {
    const response = await POST(post({ status: "future", title: "تازه" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("scheduled_date_required");
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("refuses a date that has already passed", async () => {
    const response = await POST(post({ status: "future", title: "تازه", scheduledFor: "2020-01-01T00:00:00.000Z" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("scheduled_date_in_past");
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("refuses an unparseable date", async () => {
    const response = await POST(post({ status: "future", title: "تازه", scheduledFor: "فردا صبح" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_scheduled_date");
  });

  it("refuses a date on a post that is not being scheduled", async () => {
    m.getContent.mockResolvedValue({ status: "publish", remoteUpdatedAt: "2026-11-01T00:00:00.000Z" });
    const response = await POST(post({ title: "تازه", scheduledFor: FUTURE }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("scheduled_date_requires_future_status");
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("lets an already-scheduled post change only its date", async () => {
    m.getContent.mockResolvedValue({ status: "future", remoteUpdatedAt: "2026-11-01T00:00:00.000Z" });

    const response = await POST(post({ id: "55", expectedRemoteUpdatedAt: "2026-11-01T00:00:00.000Z", scheduledFor: FUTURE }));

    expect(response.status).toBe(200);
    expect(m.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      "post",
      "55",
      undefined,
      expect.objectContaining({ date_gmt: FUTURE.slice(0, 19) }),
    );
  });

  it("sends WordPress's own date_gmt, never the app's free-form instant", async () => {
    const response = await POST(post({ status: "future", title: "تازه", scheduledFor: FUTURE, requestId: REQUEST_ID }));

    expect(response.status).toBe(200);
    const patch = m.enqueue.mock.calls[0][4];
    expect(patch.date_gmt).toBe(FUTURE.slice(0, 19));
    expect(patch.scheduledFor).toBeUndefined();
    expect(patch.status).toBe("future");
  });

  it("accepts a plain save of a scheduled post that touches neither status nor date", async () => {
    m.getContent.mockResolvedValue({ status: "future", remoteUpdatedAt: "2026-11-01T00:00:00.000Z" });
    const response = await POST(post({ id: "55", expectedRemoteUpdatedAt: "2026-11-01T00:00:00.000Z", title: "عنوان تازه" }));

    expect(response.status).toBe(200);
    const patch = m.enqueue.mock.calls[0][4];
    expect(patch).toEqual({ title: "عنوان تازه" });
  });
});

describe("categories and tags", () => {
  beforeEach(() => {
    m.getContent.mockResolvedValue({ status: "draft", remoteUpdatedAt: "2026-11-01T00:00:00.000Z" });
  });

  it("sends term ids under the plugin's own field names", async () => {
    const response = await POST(post({ id: "55", expectedRemoteUpdatedAt: "2026-11-01T00:00:00.000Z", categories: [3, 4], tags: [9] }));

    expect(response.status).toBe(200);
    const patch = m.enqueue.mock.calls[0][4];
    expect(patch.post_category).toEqual([3, 4]);
    expect(patch.tags_input).toEqual([9]);
    expect(patch.categories).toBeUndefined();
  });

  it("saves terms on their own, with no text field touched", async () => {
    const response = await POST(post({ id: "55", expectedRemoteUpdatedAt: "2026-11-01T00:00:00.000Z", categories: [3] }));

    expect(response.status).toBe(200);
    expect(m.enqueue).toHaveBeenCalledWith(expect.anything(), "post", "55", undefined, { post_category: [3] });
  });

  it("refuses categories for a page instead of letting WordPress drop them", async () => {
    const response = await POST(post({ post_type: "page", requestId: REQUEST_ID, title: "برگه", categories: [3] }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("categories_not_supported_for_pages");
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("refuses names, fractions, zeros and over-long lists", async () => {
    const cases = [
      { categories: ["فرش"] },
      { tags: [1.5] },
      { tags: [0] },
      { categories: Array.from({ length: 21 }, (_, index) => index + 1) },
    ];
    for (const body of cases) {
      const response = await POST(post({ id: "55", expectedRemoteUpdatedAt: "2026-11-01T00:00:00.000Z", ...body }));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("invalid_terms");
    }
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("refuses an older plugin that cannot apply term lists", async () => {
    m.connection.mockResolvedValue({
      id: CONNECTION_ID,
      provider: "woocommerce",
      status: "active",
      link_mode: "plugin",
      plugin_capabilities: { jobTypes: ["post_upsert"] },
    });

    const response = await POST(post({ id: "55", expectedRemoteUpdatedAt: "2026-11-01T00:00:00.000Z", tags: [9] }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "plugin_taxonomies_unsupported", upgradeRequired: true });
    expect(m.enqueue).not.toHaveBeenCalled();
  });
});

describe("an older plugin is refused instead of publishing early", () => {
  it("answers plugin_schedule_unsupported when the plugin never advertised date_gmt", async () => {
    m.connection.mockResolvedValue({
      id: CONNECTION_ID,
      provider: "woocommerce",
      status: "active",
      link_mode: "plugin",
      plugin_capabilities: { jobTypes: ["post_upsert"] },
    });

    const response = await POST(post({ status: "future", title: "تازه", scheduledFor: FUTURE, requestId: REQUEST_ID }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "plugin_schedule_unsupported", upgradeRequired: true });
    expect(m.enqueue).not.toHaveBeenCalled();
  });
});

describe("REST mode carries the schedule the same way", () => {
  beforeEach(() => {
    m.connection.mockResolvedValue({ id: CONNECTION_ID, provider: "woocommerce", status: "active", link_mode: "rest_api" });
    m.client.mockResolvedValue({ id: 77, type: "post", status: "future", date_gmt: FUTURE.slice(0, 19) });
  });

  it("writes date_gmt to wp/v2 and mirrors what came back", async () => {
    const response = await POST(post({ status: "future", title: "تازه", scheduledFor: FUTURE, requestId: REQUEST_ID }));

    expect(response.status).toBe(200);
    const [endpoint, body] = m.client.mock.calls[0];
    expect(endpoint).toBe("posts");
    expect(body).toEqual({ title: "تازه", status: "future", date_gmt: FUTURE.slice(0, 19) });
    expect(m.upsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "77", status: "future", date_gmt: FUTURE.slice(0, 19) }),
    );
  });
});

describe("REST mode term fields", () => {
  beforeEach(() => {
    m.connection.mockResolvedValue({ id: CONNECTION_ID, provider: "woocommerce", status: "active", link_mode: "rest_api" });
    m.client.mockResolvedValue({ id: 77, type: "post", status: "draft" });
  });

  it("uses wp/v2's own field names for the same ids", async () => {
    const response = await POST(post({ requestId: REQUEST_ID, title: "تازه", categories: [3], tags: [9, 10] }));

    expect(response.status).toBe(200);
    const [, body] = m.client.mock.calls[0];
    expect(body.categories).toEqual([3]);
    expect(body.tags).toEqual([9, 10]);
    // The plugin's field names must never reach wp/v2.
    expect(body.post_category).toBeUndefined();
    expect(body.tags_input).toBeUndefined();
  });
});

/**
 * The featured image (#1215, P2-5). WordPress keeps it as `_thumbnail_id` meta,
 * so the id has to arrive intact and only travel to a plugin that can apply it
 * — a save that silently drops the image is the failure this field exists to
 * prevent.
 */
describe("featured image", () => {
  const VERSION = "2026-11-06T09:00:00.000Z";
  beforeEach(() => {
    // A version-checked save reads the mirror (plugin mode) or the store (REST);
    // both have to agree with `expectedRemoteUpdatedAt` or the save is refused.
    m.getContent.mockResolvedValue({ status: "draft", remoteUpdatedAt: VERSION });
    m.getPost.mockResolvedValue({ modified_gmt: "2026-11-06T09:00:00" });
    m.connection.mockResolvedValue({
      id: CONNECTION_ID,
      provider: "woocommerce",
      status: "active",
      link_mode: "plugin",
      plugin_capabilities: { jobTypes: ["post_upsert"], featuredMedia: true },
    });
  });

  it("queues the attachment id and is not an empty patch on its own", async () => {
    const response = await POST(post({ id: "77", expectedRemoteUpdatedAt: VERSION, featuredMediaId: 501 }));

    expect(response.status).toBe(200);
    const [, , , , payload] = m.enqueue.mock.calls[0];
    expect(payload).toMatchObject({ featured_media: 501 });
  });

  it("clears the thumbnail with 0 rather than refusing the save", async () => {
    const response = await POST(post({ id: "77", expectedRemoteUpdatedAt: VERSION, featuredMediaId: 0 }));
    expect(response.status).toBe(200);
    const [, , , , payload] = m.enqueue.mock.calls[0];
    expect(payload).toMatchObject({ featured_media: 0 });
  });

  it("refuses an id it cannot trust instead of coercing it to zero", async () => {
    for (const bad of ["501", -1, 1.5, 2_147_483_648, true]) {
      const response = await POST(post({ id: "77", expectedRemoteUpdatedAt: VERSION, featuredMediaId: bad }));
      expect(response.status, String(bad)).toBe(400);
      expect((await response.json()).error).toBe("invalid_featured_media");
    }
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("refuses the field on a plugin that cannot apply it, before queueing anything", async () => {
    m.connection.mockResolvedValue({
      id: CONNECTION_ID,
      provider: "woocommerce",
      status: "active",
      link_mode: "plugin",
      plugin_capabilities: { jobTypes: ["post_upsert"] },
    });
    const response = await POST(post({ id: "77", expectedRemoteUpdatedAt: VERSION, featuredMediaId: 501 }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "plugin_featured_media_unsupported", upgradeRequired: true });
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("sends featured_media to wp/v2 in REST mode", async () => {
    m.connection.mockResolvedValue({
      id: CONNECTION_ID,
      provider: "woocommerce",
      status: "active",
      link_mode: "rest_api",
      plugin_capabilities: null,
    });
    m.client.mockResolvedValue({ id: 77, type: "post", modified: VERSION });

    const response = await POST(post({ id: "77", expectedRemoteUpdatedAt: VERSION, featuredMediaId: 501 }));
    expect(response.status).toBe(200);
    expect(m.client.mock.calls[0][1]).toMatchObject({ featured_media: 501 });
  });
});
