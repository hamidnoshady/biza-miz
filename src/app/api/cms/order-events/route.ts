/**
 * `POST /api/cms/order-events` — CMS store order notifications (Phase G).
 *
 * Signed like `POST /api/cms/revalidate` (`x-eshobe-signature` over the raw body).
 * Body: `{ siteId, deliveryId, event, order }` where `event` is `order.paid`.
 */
import { NextResponse } from "next/server";

import { cmsWebhookSecret } from "@/lib/cms/config";
import { handleCmsStoreOrderWebhook, type CmsOrderEventNotice } from "@/lib/cms/order-ingest-service";
import { ESHOBE_SIGNATURE_HEADER, verifyEshobeSignature } from "@/lib/cms/webhook";
import type { CmsOrder } from "@/lib/cms/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const secret = cmsWebhookSecret(process.env);
  if (!secret) {
    return NextResponse.json({ error: "webhook not configured" }, { status: 503 });
  }

  const rawBody = await request.text();
  if (!verifyEshobeSignature(rawBody, request.headers.get(ESHOBE_SIGNATURE_HEADER), secret)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let notice: CmsOrderEventNotice;
  try {
    const parsed = JSON.parse(rawBody) as {
      siteId?: string;
      deliveryId?: string;
      event?: string;
      order?: CmsOrder;
    };
    if (
      typeof parsed.siteId !== "string" ||
      typeof parsed.deliveryId !== "string" ||
      typeof parsed.event !== "string" ||
      !parsed.order?.id
    ) {
      return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
    }
    notice = {
      siteId: parsed.siteId,
      deliveryId: parsed.deliveryId,
      event: parsed.event,
      order: parsed.order,
    };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  return handleCmsStoreOrderWebhook(notice);
}
