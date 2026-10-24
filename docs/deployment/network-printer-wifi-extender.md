# Putting a LAN-only receipt printer on WiFi (TP-Link RE200)

A thermal printer with an Ethernet port but no WiFi — e.g. the Tyson TY-3018
(`Interface: USB & RS232 & LAN`, `ESC/POS`, 80mm, cash drawer `DC24V/1A`) — can
still be used from the app over the cafe's WiFi by hanging it off a WiFi
extender's LAN port. The app itself needs no special mode for this: it only ever
talks to `ip:port`, so once the printer has a **stable IP on the same subnet as
the till PC**, it is configured exactly like a cabled network printer.

This page covers the parts that actually go wrong: the extender's mode, the
printer's IP, and which machine has to be able to reach it.

## How the pieces connect

```
   ┌──────────┐   WiFi    ┌───────────────┐   Ethernet   ┌───────────────┐
   │  Router  │◄─────────►│ TP-Link RE200 │◄────────────►│ TY-3018 printer│
   │ (DHCP)   │           │ Range Extender│  (LAN port)  │  raw TCP :9100 │
   └────┬─────┘           └───────────────┘              └───────┬────────┘
        │ WiFi                                                   │ RJ11
        │                                                        ▼
   ┌────┴───────────────────────┐                        ┌──────────────┐
   │ Till PC                    │                        │ Cash drawer  │
   │  browser  → 127.0.0.1:9123 │                        └──────────────┘
   │  print connector ──────────┼──── TCP :9100 ─────────────────▲
   └────────────────────────────┘   (over the LAN, to the printer)
```

Two things follow from this picture, and both are load-bearing:

- **The print connector opens the socket, not the app server.** The browser
  calls the connector on `127.0.0.1:9123` (`src/lib/printing/client.ts`), and
  the connector connects to the printer (raw TCP in
  `public/windows/cafe-pos-print-connector.ps1`). So the machine that must
  reach the printer's IP is the **till PC running the connector** — not the
  server hosting the app, which may be somewhere else entirely.
- **In Range Extender mode the RE200 is a bridge.** The device on its LAN port
  joins the *main router's* network and gets its address from the router's DHCP.
  It is not behind a second NAT, so no port forwarding is involved.

## 1. Extender: Range Extender mode, not Access Point mode

The RE200's single Ethernet port changes meaning with the mode:

| Mode | What the Ethernet port is | Use here? |
|---|---|---|
| **Range Extender** | a wireless-to-wired adapter for a wired device | ✅ yes |
| Access Point | the *uplink* — expects a cable back to the router | ❌ no |

Set it up (Tether app, WPS, or `http://tplinkrepeater.net` in a browser),
join it to the cafe's WiFi, then plug the printer into its LAN port. Place the
extender where it still has a solid signal to the router — a receipt is a few
tens of KB, so bandwidth is irrelevant, but a marginal link shows up as a print
that times out (the connector gives the socket 8 seconds).

If the router has **AP/client isolation** ("guest mode", "AP isolation") enabled
on the SSID the extender joins, wireless clients can't talk to each other and
the till PC will never reach the printer. Turn it off for that SSID.

## 2. Printer: a fixed IP on the router's subnet

Generic LAN boards like the TY-3018's usually ship with DHCP **off** and a
factory static address (often `192.168.1.100`, sometimes `192.168.123.100`),
which will not match the cafe router's subnet unless you are lucky. Find out
what it actually has first — in the order below, because the first one is the
only one that doesn't depend on guessing the address:

- **Direct cable to a laptop** (most reliable). Unplug the printer from the
  extender and run the Ethernet cable straight into a laptop — any modern port
  is auto-MDIX, so no crossover cable is needed. Give the laptop a static
  `192.168.1.10 / 255.255.255.0`, then look for the printer:

  ```bash
  nmap -p 9100 --open 192.168.1.0/24    # anything answering on the raw-print port is it
  ```

  On Windows without nmap, "Advanced IP Scanner" does the same job. If the scan
  is empty, repeat with the laptop on `192.168.123.10` — that's the other common
  factory subnet. Once it answers, either open `http://<found-ip>` (many boards
  serve a config page; `admin`/`admin` is the usual login) or use the vendor
  utility to write the final settings.
- **Over USB, with the vendor utility.** The TY-3018 has USB and RS232 as well as
  LAN, and the generic Windows tools ("Printer Test Tool" / "POS Printer Set
  Tool" / XPrinter's setup tool) read *and* write the Ethernet parameters over
  USB. This works no matter what IP the board currently holds, which makes it
  the fallback when the direct-cable scan finds nothing. Some of these tools also
  have a LAN **Search** button that discovers the printer by broadcast even when
  its address is on a foreign subnet.
- **The router's DHCP client list.** If the board came up with DHCP on, plug it
  into the extender, power-cycle it, and look for the new client in the main
  router's lease table (the extender bridges, so the printer appears as a client
  of the *router*, not of the RE200). The Tether app's client list is a second
  place to look.
- **Self-test slip — but check what the button actually does first.** On many of
  these boards, powering on with **FEED** held prints a configuration slip with
  the IP and MAC; on others, including some TY-3018 firmware, that same gesture
  is a **factory reset** and nothing prints. If a reset is what happens, don't
  repeat it — you have simply put the board back on its factory defaults, so try
  the first method above against `192.168.1.100`. Variants worth one attempt
  each: release FEED the moment printing starts rather than holding it, and
  hold FEED with the paper cover open, power on, then close the cover.

Then give it a stable address, either way round:

- **Static on the printer** — set it with the vendor's Windows utility over USB
  (a "Printer Test Tool" / "POS Printer Set Tool" style app), or, on boards that
  have a web page, by temporarily putting a PC on the printer's factory subnet
  and opening `http://<factory-ip>`. Pick an address inside the router's subnet
  but **outside its DHCP pool** (e.g. `192.168.1.50` when the pool starts at
  `.100`).
- **DHCP + reservation** — turn DHCP on at the printer, then reserve that IP to
  the printer's MAC in the router. The MAC is on the self-test slip, on the
  printer's own label, or in the router's lease table next to the address it
  handed out.

Either way the point is the same: **the IP must not move.** The app stores the
address you type; a printer that picks up a different lease next week stops
printing with no other symptom.

Leave the port at **9100** — that is the raw-print port the connector writes
to (`resolvedPort()` defaults to it), and the one the connector's network
discovery looks for.

## 3. Verify from the till PC before touching the app

Run these on the machine that will run the print connector (the till PC):

```bash
ping 192.168.1.50                      # the printer's IP
```

```bash
# Linux/macOS: is the raw-print port open?
nc -vz 192.168.1.50 9100
```

```powershell
# Windows equivalent
Test-NetConnection 192.168.1.50 -Port 9100
```

If the port test fails, stop here — nothing in the app can fix a printer the
till PC cannot reach.

## 4. Install the Windows print connector on the till PC

In the POS, open «تنظیمات → چاپ و فاکتور → چاپگرها», click **«دانلود و نصب رابط
چاپ ویندوز»**, and open the downloaded file once. It needs no Node.js, command
line, administrator account, or manual configuration. It listens on
`127.0.0.1:9123` (loopback only), starts immediately, and starts automatically
at each Windows login. Persian/RTL receipt rasterization stays on the app
server; the connector only delivers the finished bytes on the till's local
network — see [`docs/deployment/deployment-local-network.md`](deployment-local-network.md).

## 5. Register the printer in the app

**تنظیمات ← چاپ و فاکتور ← چاپگرها** (`/dashboard/settings`, printers tab; needs
the settings-manage permission) — or the **Hardware** step of the setup wizard
on a fresh install, which is the same screen. The printer belongs to the
**active branch**, so switch branches first if the business has several.

Add a printer («افزودن چاپگر») and pick **«چاپگر شبکه»** in the first step. In the
second step the connector sweeps the local subnets; a printer with a fixed IP
that answers on 9100 appears in the list with its address. If it does not,
«چاپگرتان پیدا نشد؟» opens «اتصال پیشرفته» where the address from step 2 and
port `9100` can be typed by hand.

Then: name it (e.g. `چاپگر صندوق`), set its job to `رسید مشتری` (or `آشپزخانه`
for a kitchen printer), paper width `۸۰ میلی‌متر` (the TY-3018's label says
`Paper Width: 80mm`), and make it the default for that job. Finish with
**«چاپ آزمایشی و ذخیره»** — the wizard prints before it saves, so a wrong
address is caught here. If a drawer is wired into the printer's RJ11 socket,
enable «بازکردن کشوی پول» in the same dialog (the drawer is kicked through the
printer, so it rides the same connection).

## Reading the two failure messages

The test buttons distinguish the two halves of the path, and the distinction is
the whole diagnostic:

| Message | Meaning | Fix |
|---|---|---|
| «رابط چاپ روی این کامپیوتر نصب نیست…» | the browser never reached the connector | the connector isn't running on *this* machine (reinstall from the «چاپگرها» tab) |
| «به چاپگر شبکه دسترسی نیست…» | the connector ran, but its socket to `ip:9100` failed | wrong/changed IP, printer asleep or off, weak extender link, AP isolation |

A useful consequence: the first message never implicates the extender, and the
second one always points at the network between the till PC and the printer.

## Notes

- **USB is not an alternative here.** A network printer must be reachable by
  IP — the connector opens a TCP socket to it. Going through the extender's
  LAN port is exactly the supported shape. (A USB-only thermal printer is
  instead installed as a Windows queue and registered as «چاپگر ویندوز».)
- **One connector per till.** Each till PC runs its own connector and prints to
  whatever IPs its branch's printers carry; nothing about the printer config is
  per-PC.
- **Kitchen printers work the same way** — a second extender or a cabled run to
  the kitchen printer, its own fixed IP, `kind: آشپزخانه`.
