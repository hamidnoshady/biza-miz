# Product Management adapter discovery (ESH-167)

Status: **partial implementation**, not the epic's acceptance. This is a map
of existing entry points and known gaps, not a claim that all operations are
available from the shared workspace. No duplicate product data models or sync
contracts were introduced.

## Catalogue entry and domain boundaries

Retail eligibility comes from `RETAIL_CATALOGUE_INDUSTRIES` in
`src/lib/industries.ts`. `catalogueAdapterFor` maps every member to its native
catalogue entry. A new retail industry requires an explicit adapter at type-check
time. `/accounting/products` reads jewelry pieces and watch models/physical
units from their native branch APIs and embeds the existing automotive stock
manager. Automotive creation embeds the native acquisition flow. Jewelry's
price page reads the native gold-rate board; the watch reports page uses the
native warranty/repair report. These are partial adapters, not a complete set of
operations. Variant APIs remain restricted to the five variant workspace trades;
broadening this guard without replacing those implementations would be unsafe.

| Industry | Existing catalogue / stock entry | Native supporting operations | Shared workspace status |
| --- | --- | --- | --- |
| Jewelry | `/accounting/jewelry`; `/api/jewelry/items` | Gold rates `/api/jewelry/prices`; consignment, reports and weighted-item services | Native weighted list and read-only gold-rate board; create, editable pricing, attributes and reports still need shared-page work; labels use the printing catalogue. |
| Watch | `/accounting/watch`; `/api/watch/items`, `/api/watch/units` | Serialized unit, warranty, repair, reservation and return APIs | Native model/serial list with basic detail and native warranty/repair reports; creation, pricing, attributes and richer detail still need shared-page work; labels use the printing catalogue. |
| Accessories | `/accounting/products`; `/api/accessories/items` | `trade-goods-service`, variant report API | Existing variant workspace; needs epic UX and safety review. |
| Cosmetics | `/accounting/products`; `/api/cosmetics/items` | Batch/expiry inventory and `/accounting/cosmetics` specialist operations | Existing variant workspace; batch/FEFO and label experience need review. |
| Wholesale | `/accounting/products`; `/api/wholesale/items` | Trade-goods and price-list services | Existing variant workspace; conversion and bulk pricing need review. |
| Tools & Fittings | `/accounting/products`; `/api/tools-fittings/items` | Trade-goods and variant report API | Existing variant workspace; technical attributes need review. |
| Haberdashery | `/accounting/products`; `/api/haberdashery/items` | Trade-goods and variant report API | Existing variant workspace; attributes and label experience need review. |
| Automotive | `/accounting/automotive`; `/api/automotive/vehicles` | `automotive-service`, stock, reservations, sales and trade-ins | Native stock board and acquisition flow embedded at shared list/new URLs; pricing, attributes, reports, and guided-form improvements still needed; labels use the printing catalogue. |

The specialists' operation pages remain reachable at their existing URLs.
Food Service and service/project industries do not have this catalogue entry.

## Page/API audit and follow-up

* The variant-oriented pages (`products`, `new`, `prices`, `attributes` and
  `reports`) retain the five-trade `requireProductWorkspace` guard and native
  API mapping. `requireProductWorkspaceForApi` guards shared product APIs;
  specialist APIs retain their own guards. Do not widen these guards until the
  specialist implementations and permission mapping exist.
* The barcode-templates page now presents the existing capability-filtered
  printing catalogue for all eight retail trades, with industry samples and
  paper information. Native catalogue read permissions control access;
  `settings.manage` gates saved designs and template/rule writes, and
  `printing.execute` gates sample printing. Readers without settings access
  see built-in previews only. Printer test jobs still use the existing generic
  sample rather than the trade-specific preview data; the page explains this,
  and unsaved designs cannot be test-printed from this product view. Actual
  specialist item-label support and matching preview/test content still need
  verification before epic acceptance. Existing branch weight-encoding patterns are
  offered separately, only to previously supported variant trades with both
  read permissions and only when patterns already exist; failed loading is
  reported, not treated as empty. Their mutation permissions and branch
  isolation remain in force. There is no weight-capability assumption or
  deletion of existing data. A canonical capability for **new** weight-scale
  setup is still needed; this increment does not claim it exists.
* Optional capabilities such as barcode, repairs and batch/expiry must come from
  `industry-profile.ts`; barcode capability alone does not mean weight encoding
  is supported. No new capability assumptions are made in this increment.
* Watch model and jewelry piece creation now commit the native item and its
  required attributes in one tenant transaction, so validation/database failures
  cannot leave an orphan item. Real PostgreSQL regression tests exercise commit
  and rollback. The existing item event remains best-effort as before.
* The shared list is still missing richer specialist detail, stock movement and
  channel information; the native acquisition form does not yet meet the epic's
  draft/review requirements. The jewelry gold-rate board is read-only. The
  existing gold-rate upsert replaces the day's row (and clears buy-back rate if
  omitted), so safe editing, history and conflict handling need dedicated work
  before treating it as an audited shared price editor.
* Variant pricing and attributes currently use the shared variant-oriented services;
  jewelry gold pricing and automotive vehicle permissions must remain native.
  Catalogue row controls now use the actual stock, metadata and integration
  permissions; metadata writes additionally require `inventory.adjust` along
  with the existing `menu.edit`. The new-product nav entry requires
  `inventory.adjust`. Remaining screens, audit/history, conflict handling and
  stable attribute options still require the full epic review.
* Import must continue through the universal reconciliation work (ESH-99 and
  ESH-166); Woo/CMS mappings and acknowledgement semantics must remain unchanged.
  No new publication or offline capability is implied here.
* The route tests cover eligibility, permission checks and native entry selection, but do not
  replace database, integration, full responsive/RTL, accessibility, or visual
  screenshot QA across the eight industries. Those remain required before
  marking the epic done.
