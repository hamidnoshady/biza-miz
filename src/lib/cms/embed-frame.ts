/**
 * Will the CMS admin let this dashboard frame it? The browser answers that question only
 * by drawing a broken-frame icon — no event, no message — so the edit modal asks first,
 * from the headers the CMS sends on `/admin`, and turns a refusal into a sentence the
 * operator can act on (`cms_frame_blocked`: list this origin in the CMS's
 * `ADMIN_EMBED_ORIGINS`).
 *
 * Pure. `undefined` means "cannot tell" and never blocks the modal.
 */
export function frameAncestorsAllow(
  headers: { csp?: string | null; xFrameOptions?: string | null },
  parentOrigin: string,
  frameOrigin: string,
): boolean | undefined {
  let parent: URL;
  try {
    parent = new URL(parentOrigin);
  } catch {
    return undefined;
  }

  const directive = (headers.csp ?? "")
    .split(",")
    .flatMap((policy) => policy.split(";"))
    .map((part) => part.trim())
    .filter((part) => /^frame-ancestors\s/i.test(part) || /^frame-ancestors$/i.test(part));

  if (directive.length > 0) {
    // Several policies intersect: every one must allow the parent.
    return directive.every((part) => {
      const sources = part.split(/\s+/).slice(1);
      return sources.some((source) => sourceMatches(source, parent, frameOrigin));
    });
  }

  // `X-Frame-Options` only applies without `frame-ancestors`, and has no origin list.
  const xfo = (headers.xFrameOptions ?? "").trim().toLowerCase();
  if (xfo === "deny") return false;
  if (xfo === "sameorigin") return parent.origin === frameOrigin;
  return true;
}

function sourceMatches(source: string, parent: URL, frameOrigin: string): boolean {
  const value = source.trim();
  if (value === "*") return true;
  if (value.toLowerCase() === "'self'") return parent.origin === frameOrigin;
  if (value.toLowerCase() === "'none'") return false;
  if (/^[a-z][a-z0-9+.-]*:$/i.test(value)) return parent.protocol === value.toLowerCase();
  const match = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:]+)(?::(\d+|\*))?\/?$/i.exec(value);
  if (!match) return false;
  const [, scheme, wildcard, host, port] = match;
  if (scheme && `${scheme.toLowerCase()}:` !== parent.protocol) return false;
  const parentHost = parent.hostname.toLowerCase();
  const sourceHost = host.toLowerCase();
  if (wildcard ? !parentHost.endsWith(`.${sourceHost}`) : parentHost !== sourceHost) return false;
  if (port && port !== "*") {
    const parentPort = parent.port || (parent.protocol === "https:" ? "443" : "80");
    if (port !== parentPort) return false;
  }
  return true;
}
