# چاپ و فاکتور — the printing section

Everything a business prints — receipts, invoices, kitchen tickets, labels —
goes through one model, one renderer and one section of the dashboard
(«تنظیمات» → «چاپ و فاکتور», `/dashboard/settings?tab=printers`).

## The idea in one paragraph

A **template is data**, not code: a paper, a handful of options, and an ordered
list of blocks. `src/lib/print-template.ts` defines that model, ships six
built-in templates written in it, and holds the one pure function
(`renderPrintTemplate`) that turns a template + a document into a complete HTML
page. Everything else — the gallery, the designer's live preview, the server's
ESC/POS raster, the A4 page image, the label — consumes that one string. There
is no second implementation of the layout anywhere, which is why "it looked
right in the preview" is a true statement about what prints.

Above the template sits **one resolver** and **one routing table**:

- `print_rules` (the «قوانین چاپ» tab) answers *which template and which
  printer each document type uses*;
- `src/lib/printing/plan.ts` `resolvePrintPlan()` is the only thing that reads
  them. Every print entry point — the till's receipt, the kitchen ticket, the
  retail invoice, a shelf label, a test print, the gallery's «چاپ نمونه» —
  calls that one function. Nothing else may decide a printer or a template, and
  nothing else may re-derive a fallback.

Three questions, three owners, and they never cross:

| Question | Owner | Where |
| --- | --- | --- |
| *How do we reach the hardware?* | **printer** | `printers.connection` — `{type:"windows",systemName}` / `{type:"network",ip,port}` and nothing else |
| *What does the page look like?* | **template** | `print_templates.layout` or a built-in in `print-template.ts` |
| *Which of each, for this document?* | **print rule** | `print_rules` (template + primary printer + fallback printer) |

## Hardware: one question, two answers

A printer is reached one of exactly two ways, and which one it is is the only
hardware question the product ever asks («چاپگر کجاست؟»):

| Connection | Reached by | Needs |
| --- | --- | --- |
| `windows` | the print backend → the Windows spooler (RAW), by queue name | the printer installed in Windows' «Printers & scanners» |
| `network` | the same backend → raw TCP to the printer's address (port 9100) | the printer on the café LAN |

That is the whole list. USB thermal printers install in Windows and are
`windows`; LAN/Wi-Fi ESC/POS printers are `network`. There is no WebUSB, no
raw device path, no driver-mode picker, no «چاپ با مرورگر» transport — those
were implementation details a restaurant employee should never have to
understand, and they are gone.

### Two products, two hardware backends, one target shape

"The same backend" above means one of two things depending on where the app
is running, decided automatically and invisibly to the operator:

| Product | Backend | Why |
| --- | --- | --- |
| Browser / cloud (`pos.<domain>` in a normal browser tab) | the Cafe POS Windows Print Connector, a small loopback helper installed once on the cashier's machine | a browser tab has no OS access of its own — it needs *something* on the machine to reach `winspool.drv` or a raw socket |
| **Desktop (Electron) app** | **`electron/native-printing.js`, called in-process from the main process** | the desktop app already **is** a Node/Electron process on the same Windows machine as the printer — it never needs a second, separate helper next to itself |

Both backends implement the identical `PrinterTarget` shape
(`src/lib/printing/types.ts`: `{type:"windows", systemName}` /
`{type:"network", ip, port}`) and the identical canonical error codes
(`src/lib/printing/errors.ts`), so every printer, template and route above
this line is unaware of which backend actually moved the bytes.
`src/lib/printing/client.ts` is the one place that picks: it prefers
`window.businessSuiteDesktop.printing` (exposed by `electron/preload.js`)
when present, and falls back to the loopback connector otherwise — see that
file's header comment. `connectorHealth()` reports the desktop bridge as
always "installed": there is nothing to install, since it ships inside the
app itself.

**Desktop native printing is implementation + unit/logic tests only.**
`electron/native-printing.js`'s pure logic (Windows-printer JSON parsing,
error classification, the RAW-print PowerShell script text, subnet
derivation) is covered by `src/lib/native-printing.test.ts` with every
side-effecting call (PowerShell, TCP sockets, network interfaces) injected as
a fake. It has **not** been exercised against a real Windows spooler, a real
installed printer queue, or a real network thermal printer in this
environment (no Windows host is available here) — a hardware verification
pass on an actual Windows machine is required before this path is trusted as
the desktop build's primary printing backend in production.

### The delivery flow

```
POS / Order / Kitchen
   │ document type + the document's own data (+ optional printerId / templateId)
   ▼
authenticated app server  (POST /api/printing/print)
   │ resolvePrintPlan(branch, document type, ids)
   │   → rule template (or saved default, or built-in) + the printer it routes
   │   → refuses, with a canonical code, when there is no usable pair
   │ renders the canonical document (Persian shaping, the planned template,
   │ the plan's paper) and packs it into ESC/POS bytes — or a page image
   ▼
browser or desktop app  (src/lib/printing/client.ts)
   │ forwards the bytes + the resolved target to whichever backend is present
   ▼
   ├── Cafe POS Windows connector (browser/cloud, 127.0.0.1:9123, exact-origin)
   │      ├── windows  → native winspool.drv, RAW
   │      └── network  → TCP, port 9100
   └── electron/native-printing.js (desktop app, in-process, no loopback hop)
          ├── windows  → native winspool.drv, RAW (same technique, called directly)
          └── network  → TCP, port 9100 (a plain Node socket)
   ▼
physical printer
```

The split follows what each side actually has. The **app server** owns
authorization, the saved printer, templates and the Chromium raster pipeline
(Persian/RTL text needs a real browser engine — see `src/lib/escpos.ts`; it is
never rendered as ESC/POS text-mode). The **cashier's machine** owns the
hardware: the local connector (browser/cloud) or the desktop app's own
process (desktop) is the only thing that enumerates Windows queues, sweeps
the café LAN for printers, and sends bytes to a device.

Because of that split the server never accepts a hardware address from a
browser, and never accepts *markup* either: a print job is an **intent** — a
document type, the document's own data, and optionally a printer or template
id. `html` is not a job type the endpoint knows, so a hand-edited request can
neither aim the server at an arbitrary IP or queue, nor make its Chromium
render something the product did not build, nor print through another
branch's printer (ids are resolved inside the caller's active location, so
another branch's row simply does not exist). The server does not scan the
café LAN, ever — network discovery runs on the cashier's own machine, never
on the server.

Two more consequences of the split worth stating plainly, because they are
what an operator sees:

- **Provenance is recorded.** Every job writes a `print_jobs` row with the
  printer, the `template_id`/`template_key` and the **template version** that
  produced it, plus the route (`rule`, `fallback`, `only`, …) and the printer a
  fallback replaced. The rules screen's «فعالیت اخیر» is that table.
- **A job always ends.** The server stamps `sending`; the browser (the only
  side that can talk to the spooler) closes the row as `handed_off` or
  `failed` with a canonical error code — on refusal, on connector failure, on
  abort, on timeout. Any row still `sending` after
  `SENDING_STALE_AFTER_SECONDS` (120 s) is swept to `failed`/`job_timeout` when
  history is read, so «در حال ارسال» can never be a permanent state.

### The Windows connector (browser / cloud)

`public/windows/cafe-pos-print-connector.ps1` — protocol v3, dependency-free
Windows PowerShell, installed per-user from «چاپگرها → افزودن چاپگر» with one
click (the authenticated installer is built by `src/lib/windows-print-connector.ts`
and served from `/api/printing/connector/installer`). It:

- binds only to `127.0.0.1:9123` — never exposed to the LAN;
- accepts browser requests only from the exact Cafe POS origin(s) baked into
  the installer (the tenant origin first, plus any rename aliases — all of
  them verified by the server, normalised before comparison, never a wildcard);
- enumerates installed queues via `Win32_Printer` (`GET /printers/windows`);
- discovers network printers by scanning its own IPv4 /24 subnets for an open
  9100, windowed and deduplicated (`POST /printers/network/discover`);
- probes a target (`POST /printers/probe`);
- delivers raw bytes through the native `winspool.drv` `WritePrinter` API or a
  TCP socket (`POST /print/raw`), returning canonical error codes
  (`printer_not_found`, `network_unreachable`, …) — never raw exceptions;
- answers `GET /health` with its protocol version, release, the full
  allowed-origin set and print-subsystem status, so both the installer and
  the browser can tell installed / outdated / wrong-origin apart.

Reinstalling is also the upgrade path: the installer stops the previous
connector (including the pre-v3 «print agent» spelling), replaces the script,
and only reports success for a health answer at or above the minimum protocol
version. It starts now and at every Windows login; no Node.js, no admin
account, no command line. Running it again is a safe repair.

#### Where the payload comes from

The installer's two addresses are deliberately independent:

- the connector's **allowed origin(s)** — the tenant's browser origin, needed
  by CORS. On a host-routed deployment these are the session business's own
  DNS labels (current subdomain plus rename aliases, read from the database),
  and the route refuses outright when the request's Host names anything else;
  on single-café installs it is simply the one origin the kiosk is browsed
  on. Nothing is ever fabricated as `{label}.{domain}` from the request;
- the **download URL** — where the tenant-neutral connector file is fetched
  from. Resolved (in `src/lib/printing/connector-release.ts`) as:
  `CONNECTOR_DOWNLOAD_BASE_URL` → the platform base (`PLATFORM_BASE_URL` /
  `POS_DOMAIN` / `ROOT_DOMAIN`'s apex) on HTTPS requests → the request origin
  itself (localhost, desktop, café-laptop installs). It is intentionally
  *not* each tenant's subdomain: a hostname the browser could reach via DoH
  can still fail the Windows system resolver the installer uses, and tenants
  must never need per-tenant DNS work just to install printing.

The payload path is public (`/windows/…` is session-less in middleware — the
installer carries no cookie) and identical for every tenant. Downloads are
retried, error-classified (DNS/TLS/timeout/HTTP status), size- and
marker-checked, HTML rejected, PowerShell-parsed, and SHA-256-verified when
the serving deployment can vouch for the bytes. Failures land in a friendly
dialog with the technical trail in
`%LOCALAPPDATA%\CafePOS\PrintConnector\install.log` (no credentials — the
installer never holds any). Port 9123 conflicts are diagnosed by owner
process: another Cafe POS connector is replaced, a foreign program is named
in the message.

### Page printing does not open a dialog

A4 and A5 documents are rendered to a page image and handed to the Windows
printer driver. The browser print dialog is not used anywhere in this feature —
not for receipts, not for invoices, not as a fallback. A branch with no
configured printer gets `printer_not_configured` instead of a second print
window.

### Purposes and papers

A printer's **purpose** says what job it exists for, and its **paper** says
what it is loaded with. The write boundary (`printer-input.ts`) refuses any
combination the hardware matrix below does not contain, and the API refuses
the same combinations when a rule names a printer:

| Purpose | Papers | Transport | Notes |
| --- | --- | --- | --- |
| `receipt` | `thermal80`, `thermal58` | windows or network | may own the cash drawer |
| `kitchen` | `thermal80`, `thermal58` | windows or network | priceless, big, bold |
| `document` | `a4`, `a5` | **windows only** | page jobs go through the Windows driver; a raw 9100 socket cannot carry a page |
| `label` | `label57x40` (or a thermal roll) | windows or network | a sticker on a receipt printer is a label-sized raster |

Refusing at write time is deliberate: a printer saved with a paper its purpose
cannot carry is a printer that fails later, at the counter.

### Legacy printers

Rows written by the old five-transport model are normalised in
`src/lib/printing/types.ts`: `system` → `windows`, `network` (and pre-transport
rows with an address) → `network`. Everything else (`usb`, `webusb`,
`browser`, and the setup wizard's pre-transport stubs) is flagged
`needsReconnect` with its identity preserved, so the settings screen shows
«این چاپگر باید دوباره متصل شود» and the operator re-pairs in one pass.
Migration 0155 performs the same mapping in the database; new writes go
through a parser (`src/lib/printing/printer-input.ts`) that accepts only the
canonical model.

## The pieces

| File | What it is |
| --- | --- |
| `src/lib/print-template.ts` | Papers, the block model, the six built-ins, `parsePrintTemplate` (the write boundary) and `renderPrintTemplate` (the only renderer). Pure. |
| `src/lib/printing/plan.ts` | **The one resolver.** `resolvePrintPlan()` loads the branch's printers, rules, templates and branding and answers "what prints, where, with which template revision". Server-only. |
| `src/lib/printing/routing.ts` | The compatibility matrix the resolver and both write boundaries share (`purposeForDocument`, `paperAllowedForPurpose`, `printerClassFor`, `printerAcceptsDocument/Paper`) plus `resolvePrinter` when no rule names one. Pure. |
| `src/lib/printing/printer-columns.ts` | The one `SELECT` list for a printer row — so every reader agrees on which columns exist. Pure. |
| `src/lib/print-sample.ts` | The sample document every preview and test print uses. Pure. |
| `src/lib/print-templates-service.ts` | The branch's own saved templates (`print_templates`, migration 0145). |
| `src/lib/business-logo.ts` | Logo validation + the stored record. Pure. |
| `src/lib/printing/types.ts` | The canonical connection model, the legacy normalisation and target validation. Pure. |
| `src/lib/printing/printer-input.ts` | The one parser both printer routes write through (canonical model only). Pure. |
| `src/lib/printing/errors.ts` | The canonical error codes and their Persian sentences. Pure. |
| `src/lib/printing/render-service.ts` | The server half: plan + document → template → HTML → PNG → ESC/POS bytes (or a page image). Refuses an unusable printer with its canonical code before rendering anything. Server-only. |
| `src/lib/printing/chromium.ts` | HTML → PNG with the embedded Vazirmatn font (server-side). Server-only. |
| `src/lib/printing/raster.ts` | PNG → grayscale decode. Pure. |
| `src/lib/printing/client.ts` | The browser's printing client: connector calls, intent-only jobs, progress phases, and closing the history row on every terminal path. No browser-dialog fallback exists. |
| `src/app/api/printing/print` | The one hardware job endpoint: printerId in, canonical bytes + target out. |
| `src/app/api/printing/test-draft` | The add-printer wizard's test print before the printer is saved: renders the sample for a purpose + paper, validating both with the same matrix the write boundary uses. |
| `src/app/api/printing/jobs` | Print history: closes a job (`handed_off` / `failed` + code) and sweeps stale `sending` rows to `failed` on read. |
| `src/app/api/settings/print-rules` | The routing table's only writer: validates the template (of this branch, of this document type) and the printers (owned, active, compatible) with the same predicates the resolver uses. |
| `src/app/api/printing/connector/installer` | Authenticated per-origin Windows connector installer download. |
| `src/lib/printing/connector-release.ts` | Protocol/release versions, allowed-origin normalisation and the download-base resolution (the file above depends on both halves of this contract). Pure. |
| `src/lib/printing/connector-payload.ts` | Runtime SHA-256 fingerprint of the shipped payload for installer integrity pinning. Server-only. |
| `public/windows/cafe-pos-print-connector.ps1` | The browser/cloud Windows hardware gateway: queue discovery, LAN discovery, probe, RAW/TCP delivery. |
| `electron/native-printing.js` | The desktop app's own hardware gateway — the same queue discovery/LAN discovery/probe/RAW-TCP delivery, called directly from the Electron main process. No separate install. |
| `electron/main.js` / `electron/preload.js` | Wire `native-printing.js` to `window.businessSuiteDesktop.printing` over IPC (`desktop:print-*` handlers). |
| `src/lib/desktop-bridge.ts` | The one typed shape of `window.businessSuiteDesktop`, shared by the printing client and the Local Devices panel. |
| `src/lib/native-printing.test.ts` | Unit/logic coverage of `native-printing.js`'s pure decision logic and injected-collaborator dispatch — no real Windows/printer/network dependency. |
| `src/app/(app)/settings/printing/**` | The section, in three tabs: **چاپگرها** (hardware only), **قالب‌ها** (appearance + logo), **قوانین چاپ** (routing). The printers panel is shared with the setup wizard. |

## Papers

`thermal58`, `thermal80`, `a4`, `a5`, `label57x40`. A paper knows its width in
millimetres, whether it is a roll / a cut sheet / a label, its default margin,
and — for the roll kinds — the pixel width the ESC/POS raster is screenshotted
at (58mm → 372px, 80mm → 512px; sheets 794/559px as page images). Adding
another paper is one entry in `PAPERS`; nothing else has a paper list.

The printer's paper, not the template's, decides the physical raster width:
whatever is actually loaded in the printer is what the job is rendered for,
while the template still decides the layout (`paperOverride` in
`renderPrintTemplate`).

## The six built-in templates

They are code, never rows, so a business can never break one. A shop
**duplicates** one to get a template it can edit.

1. **فیش فروش ۸۰ میلی‌متری** — the standard café/restaurant receipt.
2. **فیش فشردهٔ ۵۸ میلی‌متری** — the same document tightened for a small roll.
3. **فاکتور رسمی A4** — ruled seven-column table, buyer block with economic
   code, two signature slots, optional two-copy printing.
4. **فاکتور A5 (پیک و تحویل)** — half-sheet delivery invoice.
5. **سفارش آشپزخانه ۸۰ میلی‌متری** — large, bold, priceless, carrying the
   branch's own name so a rail with two kitchens says whose ticket it is.
6. **برچسب ۵۷×۴۰ میلی‌متری** — the shelf label: branch, item, its trade fields
   («قیمت», «رنگ», …) and a real, scannable EAN-13 barcode drawn as SVG. Labels
   are templates like everything else — there is no private label renderer left.

## Designing a template

Every template — a receipt, an invoice, a kitchen ticket, a label — is edited in
the same designer, and the same normalisation runs on save. Blocks that the
runtime cannot honour are not offered: the `qr` block exists in the model and
the renderer draws it when a document supplies a payload (the server generates
the image itself, `withQrCode`), but no document produces one yet, so it is not
in the designer's add list (`HIDDEN_BLOCK_TYPES`).

The designer is deliberately **not** a free-positioning canvas. A receipt is one
column on a fixed-width roll and an invoice is a header/table/totals stack; free
positioning on either only lets somebody build something that prints wrong. So
the editor is a reorderable list of blocks — each one can be hidden, aligned,
resized, bolded, and (for the items table) given its own columns — beside a
live preview at true paper size. That is workable with a keyboard, on a touch
screen and on a phone, and it cannot produce a template the renderer refuses.

Everything written is normalised by `parsePrintTemplate` first, so a stored
`layout` can only contain blocks, columns and option values the renderer
understands. Out-of-range numbers are clamped, unknown columns dropped, custom
text truncated.

## The logo

Uploaded from the «قالب‌ها» tab, stored in `settings` under
`business.logo` as a **data URL** (`src/lib/business-logo.ts`). Inline rather
than a file path because the server renders receipts in a headless browser —
anything the page needs has to travel inside the HTML. Hard 256 KB cap, four
allowed types, byte-signature checked, and an SVG carrying `<script>` is
refused outright.

## Pairing a printer (the operator's path)

The «چاپگرها» tab lists the branch's printers as cards — name, purpose,
connection, target, status (probed through the connector when the page opens,
never on an interval), default badge — with **Test print** and **Edit**. All
configuration lives inside the add/edit dialog:

1. **چاپگر کجاست؟** — «چاپگر ویندوز» (on this computer; recommended for USB)
   or «چاپگر شبکه» (LAN/Wi-Fi).
2. **انتخاب چاپگر** — Windows: the connector lists the installed queues.
   Network: it sweeps the local subnets; manual IP/port appears only behind
   «چاپگرتان پیدا نشد؟». If the connector is missing, the same step installs
   it with one click («اتصال این کامپیوتر»).
3. **این چاپگر چه کاری انجام می‌دهد؟** — name, purpose (receipt / kitchen /
   **invoice A4-A5** / **label**), and the paper that purpose can carry
   (a roll width, a sheet size, the label roll); cash drawer (thermal
   receipt printers only) and default-for-its-purpose.

   The dialog asks about **hardware only**. A printer owns no template —
   which layout a document gets is a print rule, and the wizard says so.

A test print runs before or during save («چاپ آزمایشی و ذخیره»), so a wrong
pairing is caught here — never discovered as a failed print at the counter.
The first-run setup wizard's hardware step embeds the *same* panel
(`printers-panel.tsx`); there is exactly one way to pair a printer.

Printing is best-effort by contract: a failed receipt print never invalidates
a completed sale. The POS shows a non-destructive warning with «چاپ دوباره».

## Cash drawer

The drawer hangs off the receipt printer, exactly as the ESC/POS `ESC p`
command expects: a printer configured with «بازکردن کشوی پول» kicks it after
a receipt (the POS kicks it whenever a payment includes cash). Drawer test
lives in the printer's Edit dialog. There is deliberately no separate
"cash drawer connection" architecture.

## Rules and defaults

Routing lives in one table (`print_rules`, one row per document type per
branch) and resolves in this order — the leftmost thing that exists wins:

| Template | Printer |
| --- | --- |
| 1. the template explicitly requested (a gallery test print) | 1. the printer explicitly requested |
| 2. the rule's saved template (`template_id`) | 2. the rule's printer |
| 3. the rule's built-in template (`template_key`) | 3. the rule's fallback printer (the primary is gone/incompatible) |
| 4. a saved template marked default for the document type | 4. the branch's only compatible printer for that document |
| 5. the `templateKey` a pre-0211 printer row still carries (transition read — see `legacyBehaviorOf`) | 5. the last printer that printed this document type |
| 6. the built-in for the document type that fits the printer's paper | 6. the default printer for that purpose — otherwise `printer_not_configured` |
| 7. the built-in for the document type | |

A rule that names a printer which is inactive, disconnected or incompatible
does **not** silently print somewhere else: the primary is refused with its
code, and only the rule's own fallback is used (recorded as `route: "fallback"`
with the replaced printer's name). A saved template's `is_default` flag is
what the resolver uses when the rule names no template, so the gallery's
«پیش‌فرض» badge is a promise about the till: the templates API keeps exactly
one default per document type per branch (`clearDefault` runs before every
write that sets one).

One default printer per purpose per branch is enforced transactionally in
`/api/settings/printers` and by a partial unique index
(`idx_printers_one_default_per_purpose`); the resolver never has to choose
between two.

## The printer row

Since migration 0211 the `printers` table answers behaviour from **relational
columns** — `kind` (purpose), `printer_class`, `paper`, `paper_width_mm`,
`supports_drawer`, `supports_cut`, `is_default`, `is_active` — and the
`connection` jsonb holds the hardware target and nothing else. The duplicate
`printers.fallback_printer_id` is gone (`print_rules` owns fallback), any
`connection.templateKey` was promoted into the branch's rule exactly once, and
the behavioural jsonb keys were stripped. `printer-columns.ts` is the single
`SELECT` list, so a reader cannot accidentally depend on a column that another
reader does not have. The one remaining transition read
(`legacyBehaviorOf`) is isolated in `types.ts` with a removal note.

## Errors

Every failure maps to one canonical code (`connector_not_installed`,
`connector_outdated`, `printer_not_found`, `printer_configured`,
`printer_inactive`, `printer_unavailable`, `incompatible_printer`,
`template_not_found`, `template_invalid`, `printer_offline`,
`network_unreachable`, `print_failed`, `render_failed`, `job_timeout`,
`reconnect_required`, …) defined in `src/lib/printing/errors.ts`, each with
its Persian sentence. Screens show the sentence, never the raw exception —
technical detail goes to the server log and the connector's own log file
(`%LOCALAPPDATA%\CafePOS\PrintConnector\connector.log`: startup, version,
print attempts, spooler/TCP failures, probe failures — never receipt
content).

**Chromium for rendering.** The server renders with `playwright-core` against
an existing browser: `PRINT_CHROMIUM_PATH` (or `PDF_CHROMIUM_PATH`) if set,
otherwise the machine's own Chrome/Edge/Chromium is auto-detected
(`src/lib/printing/chromium.ts`).

## Testing

`src/lib/printing/plan.test.ts` pins the resolver — precedence, refusals
(`printer_not_found` / `printer_inactive` / `reconnect_required` /
`incompatible_printer` / `template_invalid` / `printer_unavailable`), the
fallback route and the template that actually renders.
`src/lib/printing/render-service.test.ts` pins the render pipeline, including
the regression that matters most: **production HTML is byte-identical to the
template preview's** for the same template and document, branding included.
`src/lib/print-template.test.ts` renders every built-in and asserts on the
output string: Persian digits, Toman amounts, no Gregorian dates, escaped item
names, the ruled table's columns, two-copy pages on a sheet but never on a
roll, and that `starterTemplate` cannot alias the preset it copied.
`escpos.test.ts` pins the byte stream (raster packing, cut, drawer kick,
58/80mm widths); `printing/raster.test.ts` the PNG decode; `printing/types.test.ts`
and `printing/printer-input.test.ts` the model and its write boundary;
`printing/render-service.test.ts` the render pipeline; `printing/client.test.ts`
the browser client (both backends, via the desktop-bridge branch);
`windows-print-connector*.test.ts` the browser/cloud connector/installer
contract; `native-printing.test.ts` the desktop app's own hardware gateway
(unit/logic only — see "Two products, two hardware backends" above for why a
real-Windows verification pass is still outstanding); `api/printing/**` the
route security model; and
`integration/printer-connection-migration.integration.test.ts` migration 0155
on a real database.

## Adding to the model

- **A new block type** — add it to `BlockType`/`BLOCK_LABELS` and render it in
  `renderBlock`. The parser and the designer's add list both read
  `BLOCK_LABELS` (minus `HIDDEN_BLOCK_TYPES`); add it to the hidden list
  instead if the runtime has no data for it yet.
- **A new paper** — one entry in `PAPERS`, then decide which purposes may carry
  it in `PAPERS_FOR_PURPOSE` (`routing.ts`).
- **A new built-in template** — one entry in `BUILT_IN_TEMPLATES`; the gallery,
  the rules screen's template list, the paper filter and the resolver all read
  from it.
- **A new document type** — `DocType` in `print-template.ts`,
  `purposeForDocument`/`DOC_TYPE_LABELS` in `routing.ts`, a bridge in
  `document-bridge.ts`, and a case in `printDocumentDataFor` — then a rule per
  branch can route it. Nothing else decides where it prints.
