/**
 * A link in a remote conversation opens in this device's browser only when it
 * means the same thing here as on the host. `localhost` and private addresses
 * name the other machine's network, so they must never reach this one's browser.
 */
export function isPublicWebLink(href: string): boolean {
  let url: URL;
  try { url = new URL(href); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host.includes(".") && !host.includes(":")) return false;
  if (host === "localhost" || host === "home.arpa" || /\.(localhost|local|internal|lan|home|home\.arpa|intranet)$/.test(host)) return false;
  if (host.includes(":")) return !/^(::1?$|f[cd]|fe[89ab]|::ffff:)/.test(host);
  const octets = host.split(".");
  if (octets.length !== 4 || !octets.every((part) => /^\d+$/.test(part))) return !/^[\d.]+$/.test(host) && !/^0x/.test(host);
  const [a, b] = octets.map(Number);
  return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224);
}

/** The port of a link that means the host itself: `localhost` there is a web
 * app running on that machine, which only a preview can reach from here. */
export function hostLocalPort(href: string): number | null {
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:" || !url.port) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127(\.\d{1,3}){3}$/.test(host) ? Number(url.port) : null;
}
