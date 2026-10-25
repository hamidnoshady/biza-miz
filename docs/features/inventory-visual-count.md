# شمارش تصویری انبار — Visual stock count

Counting physical stock with a phone camera, a photo, or a video — classical
computer vision first, AI tagging as an explicit, metered second. Lives in
انبار ← انبارگردانی, next to the barcode scan field, feeding the same tally.

## The one-paragraph model

An item carries zero or more «برچسب تصویری» (**visual profiles**, table
`inventory_item_visual_profiles`, migration 0147): a reference photo of
*exactly one unit*, the box of that unit in it, and the features the pure
counting engine extracts. Counting a photo of the shelf then runs **entirely
in the browser** — `src/lib/vision/` is dependency-free TypeScript over an
RGBA buffer. The operator always confirms the number before it touches the
tally; the confirmed count, the method, the confidence and a small photo of
what was counted are stored as evidence (`inventory_count_scans`).

## The two counting engines (no AI, no network)

`src/lib/vision/count.ts` picks the strategy when the tag is saved, by
grading both engines against the very photo the operator tagged:

- **`color`** — Lab color-signature masking + morphology + connected
  components (`color.ts`, `morphology.ts`, `components.ts`). Units are
  counted as blobs; merged piles are split by area against the *median* blob
  area of the photo (self-calibrating: no distance/angle assumption), with
  the tag's own unit-area ratio as the anchor when the median is >2.2× it.
- **`round`** — gradient-direction Hough circles (`circles.ts`) with
  3×3-block voting, clustered by radius; the dominant equal-radius cluster is
  the row of identical cups/cans/plates. This is what handles the items color
  cannot: plain white cups on a pale shelf.

Grading is empirical (`buildProfileFromRegion`): the color engine must mask
the tagged unit without swallowing the frame (recall × coverage penalty), the
round engine must find a circle at the tag's own radius. A tag neither
engine can reproduce is rejected, not saved as a profile that would miscount.

## Tagging — manual and AI, one storage shape

- **Manual** — in the count dialog, tap one unit in a captured photo
  (`regionAtPoint`: the color region under the finger becomes the box), or
  box it with two taps. Saving runs the engine on the current photo
  immediately, so the operator sees the payoff at once.
- **AI** — «برچسب‌گذاری و شمارش با هوش مصنوعی» sends the photo (one-shot data
  URL, never persisted by the AI route) to the platform's vision model via
  `/api/ai/inventory-vision`, metered exactly like invoice OCR (reserve →
  settle → cancel-on-error). The model returns a count, a confidence, and the
  box of one exemplar; the box is offered as a saved profile with
  `source: 'ai'`, and the count can be applied directly with method
  `ai_vision`.

Both land in the same table and the same feature shape, so an AI-proposed tag
and a hand-tapped one are distinguishable (`source`) but interchangeable to
the engine.

## Sources: live camera, photo, video

`vision-count-dialog.tsx` shares one result surface across three sources
(TabBar: «دوربین زنده» / «از عکس» / «از ویدیو»):

- **Live camera** — `getUserMedia` preview with a ~1.1 s sampling loop; the
  count and its boxes overlay the viewfinder in real time («شمارش زنده»).
  The camera lifecycle (session counter, exact-then-ideal facing, torch,
  Persian error copy) follows `camera-barcode-scanner.tsx`'s proven shapes.
- **Photo** — a picked/captured image (`capture="environment"`), counted on
  the spot.
- **Video** — frames sampled every 0.9 s while playing; the confirmed number
  is the **median** over samples, with the representative frame (the latest
  frame whose count equals the median) as the evidence photo. Steady, slow
  pans over tall shelves are the intended use.

Overlay geometry is pure (`overlay.ts`): boxes are computed on the analysis
frame and mapped through the exact `object-cover`/`object-contain` transform
of the preview, so what is drawn sits on what was counted.

## What is stored, and what is not

- Reference photos and evidence photos are **inline JPEG data URLs** capped
  hard (app: 200 k chars ≈ 150 KB; DB CHECK: 220 k), the same storage
  decision as the business logo (0145) — the print-agent/offline story needs
  data that travels inside the row. Client downscales to ≤480 px (profiles)
  and ≤320 px (evidence) before upload.
- A count scan never posts a stock movement. The stock-counts API stays the
  only write path for the tally; the evidence row explains a tally line.
- The AI route persists nothing; profiles are saved by the operator's explicit
  confirm in the normal profiles API.

## Tenancy, roles, audit

- Both tables carry `business_id` and their `tenant_isolation` RLS policy in
  the same migration; `tenant-isolation.integration.test.ts` discovers them
  automatically. Routes additionally scope by the caller's **active branch**
  (`resolveActiveLocation`), so another branch's item id is a 404.
- Routes are owner/manager (`requireRole`), the same scope as the rest of
  انبارگردانی; the AI route uses `requireManager` like invoice OCR.
- Constraints are the API's backstop, proven in
  `integration/inventory-visual-count.integration.test.ts`: data-URL ceiling,
  method enum, confidence band, non-negative quantity, cascade-on-item-delete.

## Honest limits (by design, stated in the UI)

- The classical engine counts *one tagged SKU per photo*, best from
  overhead-ish angles with the items not buried. Confidence below 0.45 shows
  as «اطمینان کم — بازبینی کنید».
- A merged pile where every blob is a multiple of the unit relies on the
  tag's area ratio; the count is capped at confidence 0.72 on that path and
  the operator's edit is one tap away.
- These limits are why nothing is ever applied without confirmation — a
  wrong number in the tally must always be a human's decision, and the
  evidence row is what lets someone audit that decision later.

## Where things are

| Piece | Path |
| --- | --- |
| Pure CV engine + tests | `src/lib/vision/` (`count.ts`, `color.ts`, `circles.ts`, `components.ts`, `morphology.ts`, `overlay.ts`, `image.ts`, `count.test.ts`) |
| Browser glue (canvas I/O) | `src/lib/vision/browser.ts` |
| API contract + tests | `src/lib/inventory-visual-profiles.ts` / `.test.ts` |
| Routes | `src/app/api/inventory/visual-profiles/`, `src/app/api/inventory/visual-count-scans/` |
| AI vision (pure + service + route) | `src/lib/ai-inventory-vision.ts`, `src/lib/ai-inventory-vision-service.ts`, `src/app/api/ai/inventory-vision/` |
| UI | `src/app/dashboard/inventory/vision-count-panel.tsx`, `vision-count-dialog.tsx`, wired in `stock-counts-section.tsx` |
| Migration | `migrations/0147_inventory_visual_count.sql` |
| Integration test | `integration/inventory-visual-count.integration.test.ts` |
