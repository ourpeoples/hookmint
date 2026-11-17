import net from "node:net";

/**
 * True only for addresses that are globally routable on the public internet. Everything private, loopback,
 * link-local (including the 169.254.169.254 cloud metadata address), shared (CGNAT), documentation, multicast
 * or reserved is false, as is anything that does not parse. IPv6 forms that embed an IPv4 address (mapped,
 * NAT64, 6to4) are judged by the IPv4 address inside them, so they cannot be used to sneak past the IPv4 rules.
 */
export function isPublicAddress(input: string): boolean {
  const v = net.isIP(input);
  if (v === 4) return isPublicV4(input.split(".").map(Number) as [number, number, number, number]);
  if (v === 6) return isPublicV6(input);
  return false;
}

function isPublicV4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 shared (CGNAT)
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // 192.0.0.0/24 IETF, 192.0.2.0/24 documentation
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay (deprecated)
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  if (a >= 224) return false; // multicast and reserved, includes 255.255.255.255
  return true;
}

/** Parses an IPv6 address into eight 16-bit groups, or null. Handles "::" and a trailing dotted IPv4. */
export function parseV6(addr: string): number[] | null {
  if (addr.includes("%")) return null; // zone ids are never expected from DNS
  let s = addr.toLowerCase();
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (tail) {
    const o = tail[1].split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    s = s.slice(0, -tail[1].length) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if ((halves.length === 1 && fill !== 0) || fill < 0 || (halves.length === 2 && fill < 1)) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

function isPublicV6(addr: string): boolean {
  const g = parseV6(addr);
  if (!g) return false;
  const v4 = (hi: number, lo: number) => isPublicV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && g[5] === 0xffff) return v4(g[6], g[7]); // ::ffff:a.b.c.d  IPv4-mapped
  if (zeros(0, 6)) return false; // ::, ::1, and the deprecated IPv4-compatible form
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && zeros(2, 6)) return v4(g[6], g[7]); // 64:ff9b::/96 NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return false; // 64:ff9b:1::/48 local-use NAT64
  if (g[0] === 0x2002) return v4(g[1], g[2]); // 2002::/16 6to4: the IPv4 address is in groups 1 and 2
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // documentation
  if (g[0] === 0x2001 && g[1] >= 0x10 && g[1] <= 0x2f) return false; // ORCHID and similar
  if (g[0] === 0x100 && zeros(1, 4)) return false; // 100::/64 discard
  return g[0] >= 0x2000 && g[0] <= 0x3fff; // global unicast only; fc00::/7, fe80::/10, fec0::/10, ff00::/8 all fall outside
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".corp", ".intranet", ".invalid", ".test", ".example", ".onion"];

/** Names that can never be public. A quick, clear refusal before any lookup; the address check still decides the rest. */
export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h || h === "localhost" || h.indexOf(".") === -1) return true; // single-label names resolve through local search domains
  return BLOCKED_SUFFIXES.some((s) => h.endsWith(s));
}
