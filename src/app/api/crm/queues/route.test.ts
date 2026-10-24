import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CRM_SECTION_KEYS } from "@/lib/crm-permissions";
import {
  CRM_QUEUE_KEYS,
  CRM_QUEUE_PRESENTATION,
  CRM_CUSTOMER_FILE_PREFIX,
  queueKeysForSection,
} from "@/lib/crm-shared";
import { crmQueueView } from "@/lib/crm-queue-views";

const mocks = vi.hoisted(() => ({ crmQueues: vi.fn() }));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: unknown) => handler,
  requirePermission: vi.fn(async () => ({
    session: { businessId: "tenant-a" },
    error: null,
  })),
}));

vi.mock("@/lib/crm-queues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crm-queues")>();
  return { ...actual, crmQueues: mocks.crmQueues };
});

import { GET } from "./route";

const CUSTOMER_ID = "8a86d451-f018-4bc9-bcb1-e04bcd96c91c";
const ACTIVITY_ID = "90b76d9e-c833-4ba6-8ee7-e3ff912f29d7";

function fixtureQueues() {
  return CRM_QUEUE_KEYS.map((key) => {
    const personQueue = ["at_risk_customers", "vip_follow_up"].includes(key);
    const activityQueue = ["overdue_follow_ups", "due_today"].includes(key);
    const items = personQueue || activityQueue
      ? [{
          id: personQueue ? CUSTOMER_ID : ACTIVITY_ID,
          title: "مشتری آزمون",
          subtitle: "پیگیری",
          href: `${CRM_CUSTOMER_FILE_PREFIX}${CUSTOMER_ID}`,
        }]
      : key === "possible_duplicates"
        ? [{ id: CUSTOMER_ID, title: "تکراری", subtitle: "مورد مشابه", href: "/crm/duplicates" }]
        : [];
    if (activityQueue) {
      items.push({
        id: `${ACTIVITY_ID}-no-customer`,
        title: "فعالیت بدون مشتری",
        subtitle: "پیگیری",
        href: "/crm/activities",
      });
    }
    return {
      key,
      ...CRM_QUEUE_PRESENTATION[key],
      count: items.length,
      items,
      view: crmQueueView(key),
    };
  });
}

function assertCanonicalHrefs(queues: Array<{ items: Array<{ href: string }>; view?: { href: string } | null }>) {
  for (const queue of queues) {
    for (const href of [queue.view?.href, ...queue.items.map((item) => item.href)]) {
      if (!href) continue;
      expect(href).toMatch(/^\/crm\/[a-z-]+(?:\/[^?#]*)?(?:\?[^#]*)?$/);
      expect(new URL(href, "https://crm.example").origin).toBe("https://crm.example");
      expect(decodeURIComponent(href)).not.toMatch(/=>|`|\$\{/);
      expect(href).not.toMatch(/%(?:3D|24|60|7B|7D)/i);
    }
  }
}

async function getQueues(path = "/api/crm/queues") {
  return GET(new NextRequest(`http://localhost${path}`));
}

describe("GET /api/crm/queues href contract", () => {
  beforeEach(() => {
    mocks.crmQueues.mockReset();
    mocks.crmQueues.mockResolvedValue(fixtureQueues());
  });

  it("returns exact customer destinations and canonical item/view hrefs without a section", async () => {
    const response = await getQueues();
    expect(response.status).toBe(200);
    const { queues } = await response.json();
    expect(queues).toHaveLength(CRM_QUEUE_KEYS.length);
    assertCanonicalHrefs(queues);

    for (const key of ["at_risk_customers", "vip_follow_up", "overdue_follow_ups", "due_today"] as const) {
      const queue = queues.find((entry: { key: string }) => entry.key === key)!;
      expect(queue.items[0].href).toBe(`/crm/persons/${CUSTOMER_ID}`);
    }
    for (const key of ["overdue_follow_ups", "due_today"] as const) {
      const queue = queues.find((entry: { key: string }) => entry.key === key)!;
      expect(queue.items[1].href).toBe("/crm/activities");
    }
    expect(mocks.crmQueues).toHaveBeenCalledWith("tenant-a");
  });

  it.each(CRM_SECTION_KEYS)("returns canonical hrefs for section=%s", async (section) => {
    const response = await getQueues(`/api/crm/queues?section=${encodeURIComponent(section)}`);
    expect(response.status).toBe(200);
    const { queues } = await response.json();
    expect(queues.map((queue: { key: string }) => queue.key)).toEqual(queueKeysForSection(section));
    assertCanonicalHrefs(queues);

    for (const queue of queues) {
      if (["at_risk_customers", "vip_follow_up", "overdue_follow_ups", "due_today"].includes(queue.key)) {
        expect(queue.items[0].href).toBe(`/crm/persons/${CUSTOMER_ID}`);
      }
    }
  });
});
