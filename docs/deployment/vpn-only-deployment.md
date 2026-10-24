# VPN-Only Deployment

Running the POS app locally (on-site in a cafe) means keeping its primary data on your own hardware. By default, `docker-compose.local.yml` is meant to be run strictly on a private network, and exposes plain HTTP over LAN. 

However, **Zero Public Exposure** via a VPN (WireGuard or Tailscale) combined with Caddy for HTTPS is the recommended security posture (Phase 24 Wave 4).

## 1. Network Posture (No Port Forwarding)

You do **not** need to open any inbound ports on your router to sync with the central server (VPS). 
- Server sync operates entirely via outbound HTTPS requests (`/api/server-sync/push` and `/pull`) initiated by the site laptop.
- The router’s NAT handles the return traffic.
- Never forward port 3000, 80, or 443 on your cafe's public IP to the POS machine.

## 2. Using WireGuard or Tailscale

Install a mesh VPN like Tailscale, or a pure WireGuard tunnel, on the site laptop and on staff devices (tablets, phones, till PCs) that need to access the POS.
- When running `docker-compose.local.yml`, bind the exposed Caddy ports specifically to the VPN interface address by setting `BIND_ADDR` in your `.env`:
  `BIND_ADDR=100.x.y.z` (for Tailscale) or your WireGuard IP.
- This ensures that even if an attacker connects to the cafe's open WiFi, they cannot reach the POS interface.

## 3. Caddy & HTTPS (Local TLS)

The local stack includes a Caddy container that provides `tls internal` HTTPS for `pos.cafe.lan` (or your chosen `POS_LOCAL_HOST`).

- Edit your `.env` and configure `POS_LOCAL_HOST` (e.g. `pos.cafe.lan`) and `ALLOW_INSECURE_LAN=0`.
- To allow devices to connect, they must resolve `pos.cafe.lan` to the laptop's VPN IP. You can configure this in your VPN's DNS settings (e.g., Tailscale MagicDNS).
- Caddy will generate a local Root CA. You must install this Root Certificate on each phone, tablet, and till that connects to the POS to avoid browser security warnings. 

## 4. Why HTTPS on LAN?

Without HTTPS, WebAuthn (biometric login, FaceID, Windows Hello) is entirely disabled by the browser. A `Secure` session cookie is dropped over HTTP, breaking session isolation. Mobile browsers also require a secure HTTPS context before they expose the camera used by the barcode / QR reader, so open the trusted Caddy hostname rather than a raw `http://` LAN IP. HTTPS is mandatory for biometric logins and mobile scanning even on a private network.
