# cms-store-order-contract/v1

Wire shape between **eshobe-cms** (store checkout) and **cafe-restaurant-pos**
(accounting import). Namespace: `cms-store-order-contract/v1`.

## Ingest endpoint (platform)

`POST /api/cms/order-events` on the tenant deployment.

| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `x-eshobe-signature` | `sha256=<hex>` HMAC-SHA256 over the **raw body** (same scheme as `POST /api/cms/revalidate`) |

Secret: platform `ESHOBE_CMS_WEBHOOK_SECRET` (= CMS `PAYLOAD_SECRET`).

## Body (`order-paid-notice`)

See `fixtures/order-paid-notice.json`. Required fields:

- `siteId` — CMS site UUID (maps to `eshobe_cms_connections.site_id`)
- `deliveryId` — unique per delivery attempt (idempotency key with connection)
- `event` — must be `order.paid`
- `order` — full store order document (`status` must be `paid`)

## Poll fallback (platform)

When no direct webhook is used, the platform polls `GET /api/platform/events` and
uses `fixtures/order-paid-platform-event.json` as the event slice shape, then
fetches the order by `data.orderId` with the site API key.

## Refunds

Not in v1. Cancel/refund after import is handled separately on the platform.
