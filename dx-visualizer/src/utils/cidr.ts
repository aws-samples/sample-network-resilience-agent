// IP / CIDR range math, used by the BGP route filter to answer "which prefix
// carries this address?".
//
// Both address families run through BigInt so v4 and v6 share one code path. A
// lookup that silently skipped IPv6 would report "no route" for a v6 host, which
// an operator can't distinguish from "not advertised" — the one answer we must
// never give wrongly. (The summarization rule in `bestpractice-rules.ts` keeps
// its own v4-only helper on purpose: widening a *finding* to v6 is a rules
// behaviour change, not a display concern.)

export type IpFamily = 'ipv4' | 'ipv6';

export interface IpRange {
  family: IpFamily;
  /** First address of the block, inclusive. */
  start: bigint;
  /** Last address of the block, inclusive. */
  end: bigint;
  prefixLength: number;
  /** True when the block is a single address (/32 or /128). */
  isHost: boolean;
}

const BITS: Record<IpFamily, number> = { ipv4: 32, ipv6: 128 };

// Four dotted octets, nothing else — a partial address like "10.20" must NOT
// parse, or typing it mid-address would jump to a bogus range match instead of
// letting the substring filter narrow the list.
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(addr: string): bigint | null {
  const m = IPV4_RE.exec(addr);
  if (!m) return null;
  let v = 0n;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    v = (v << 8n) | BigInt(octet);
  }
  return v;
}

// Expand one side of a "::" split into its 16-bit groups. A trailing dotted quad
// (::ffff:192.0.2.1) counts as the final two groups.
function expandGroups(part: string): string[] | null {
  if (part === '') return [];
  const groups = part.split(':');
  const out: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.includes('.')) {
      if (i !== groups.length - 1) return null;
      const v4 = parseIpv4(g);
      if (v4 == null) return null;
      out.push(((v4 >> 16n) & 0xffffn).toString(16), (v4 & 0xffffn).toString(16));
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out.push(g);
  }
  return out;
}

function parseIpv6(addr: string): bigint | null {
  // Drop a zone id ("fe80::1%eth0") — it scopes the address, not the range.
  const pct = addr.indexOf('%');
  const s = pct === -1 ? addr : addr.slice(0, pct);
  if (!s.includes(':')) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = expandGroups(halves[0]);
  const tail = halves.length === 2 ? expandGroups(halves[1]) : [];
  if (!head || !tail) return null;
  const total = head.length + tail.length;
  let groups: string[];
  if (halves.length === 2) {
    // "::" stands for at least one all-zero group.
    if (total > 7) return null;
    groups = [...head, ...Array(8 - total).fill('0'), ...tail];
  } else {
    if (total !== 8) return null;
    groups = head;
  }
  let v = 0n;
  for (const g of groups) v = (v << 16n) | BigInt(Number.parseInt(g, 16));
  return v;
}

/**
 * Parse an address or CIDR block into an inclusive numeric range. Returns null
 * for anything that isn't a complete address, so callers can fall back to plain
 * text matching. A bare address is treated as a /32 or /128.
 */
export function parseIpRange(text: string): IpRange | null {
  const raw = text.trim();
  if (!raw) return null;
  const slash = raw.indexOf('/');
  const addrPart = slash === -1 ? raw : raw.slice(0, slash);
  const maskPart = slash === -1 ? undefined : raw.slice(slash + 1);
  if (maskPart !== undefined && !/^\d{1,3}$/.test(maskPart)) return null;

  const v4 = parseIpv4(addrPart);
  const addr = v4 ?? parseIpv6(addrPart);
  if (addr == null) return null;
  const family: IpFamily = v4 != null ? 'ipv4' : 'ipv6';

  const bits = BITS[family];
  const prefixLength = maskPart === undefined ? bits : Number(maskPart);
  if (prefixLength > bits) return null;
  const size = 1n << BigInt(bits - prefixLength);
  // Mask the host bits off so "10.20.5.7/24" is read the way a router reads it:
  // as the 10.20.5.0/24 block.
  const start = (addr / size) * size;
  return { family, start, end: start + size - 1n, prefixLength, isHost: prefixLength === bits };
}

/** True when the two blocks share at least one address. */
export function rangesOverlap(a: IpRange | null | undefined, b: IpRange | null | undefined): boolean {
  if (!a || !b || a.family !== b.family) return false;
  return a.start <= b.end && a.end >= b.start;
}

/** True when `outer` contains every address of `inner` (equal blocks included). */
export function rangeCovers(outer: IpRange | null | undefined, inner: IpRange | null | undefined): boolean {
  if (!outer || !inner || outer.family !== inner.family) return false;
  return outer.start <= inner.start && outer.end >= inner.end;
}
