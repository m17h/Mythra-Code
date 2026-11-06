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
  if (host === "localhost" || /\.(localhost|local|internal|lan|home|intranet)$/.test(host)) return false;
  if (host.includes(":")) return !/^(::1?$|f[cd]|fe[89ab]|::ffff:)/.test(host);
  const octets = host.split(".");
  if (octets.length !== 4 || !octets.every((part) => /^\d+$/.test(part))) return !/^[\d.]+$/.test(host) && !/^0x/.test(host);
  const [a, b] = octets.map(Number);
  return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224);
}
