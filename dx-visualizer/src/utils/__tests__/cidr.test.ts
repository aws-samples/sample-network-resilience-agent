import { describe, it, expect } from 'vitest';
import { parseIpRange, rangeCovers, rangesOverlap } from '../cidr';

describe('parseIpRange', () => {
  it('treats a bare IPv4 address as a /32', () => {
    const r = parseIpRange('10.20.5.7')!;
    expect(r.family).toBe('ipv4');
    expect(r.prefixLength).toBe(32);
    expect(r.isHost).toBe(true);
    expect(r.start).toBe(r.end);
  });

  it('derives the inclusive bounds of an IPv4 block', () => {
    const r = parseIpRange('10.20.0.0/16')!;
    expect(r.start).toBe(parseIpRange('10.20.0.0')!.start);
    expect(r.end).toBe(parseIpRange('10.20.255.255')!.start);
  });

  it('masks host bits off, the way a router reads the prefix', () => {
    // An operator pastes a host address with a mask; that names the block.
    expect(parseIpRange('10.20.5.7/24')!.start).toBe(parseIpRange('10.20.5.0/24')!.start);
    expect(parseIpRange('10.20.5.7/24')!.end).toBe(parseIpRange('10.20.5.255')!.start);
  });

  it('handles the default route as the whole v4 space', () => {
    const r = parseIpRange('0.0.0.0/0')!;
    expect(r.start).toBe(0n);
    expect(r.end).toBe(2n ** 32n - 1n);
    expect(rangeCovers(r, parseIpRange('203.0.113.9'))).toBe(true);
  });

  it('parses IPv6 in compressed, full, and loopback forms', () => {
    expect(parseIpRange('2001:db8::/32')!.family).toBe('ipv6');
    expect(parseIpRange('2001:0db8:0000:0000:0000:0000:0000:0001')!.start)
      .toBe(parseIpRange('2001:db8::1')!.start);
    expect(parseIpRange('::1')!.start).toBe(1n);
    expect(parseIpRange('::/0')!.end).toBe(2n ** 128n - 1n);
  });

  it('parses an IPv4-mapped IPv6 address', () => {
    expect(parseIpRange('::ffff:192.0.2.1')!.family).toBe('ipv6');
    expect(parseIpRange('::ffff:192.0.2.1')!.start).toBe(0xffffc0000201n);
  });

  it('drops an IPv6 zone id — it scopes the address, not the range', () => {
    expect(parseIpRange('fe80::1%eth0')!.start).toBe(parseIpRange('fe80::1')!.start);
  });

  it('defaults a bare IPv6 address to /128', () => {
    const r = parseIpRange('2001:db8::1')!;
    expect(r.prefixLength).toBe(128);
    expect(r.isHost).toBe(true);
  });

  it('rejects a partial address so substring filtering still works', () => {
    // The panel falls back to text matching on null. If "10.20" parsed as a
    // range, typing mid-address would jump to a bogus match.
    expect(parseIpRange('10.20')).toBeNull();
    expect(parseIpRange('10.')).toBeNull();
    expect(parseIpRange('10.20.0')).toBeNull();
  });

  it('rejects malformed addresses rather than guessing', () => {
    expect(parseIpRange('')).toBeNull();
    expect(parseIpRange('256.1.1.1')).toBeNull();
    expect(parseIpRange('10.0.0.1/33')).toBeNull();
    expect(parseIpRange('2001:db8::/129')).toBeNull();
    expect(parseIpRange('10.0.0.1/x')).toBeNull();
    expect(parseIpRange('2001::db8::1')).toBeNull();
    expect(parseIpRange('2001:db8:zzzz::1')).toBeNull();
    expect(parseIpRange('7224:7100')).toBeNull();
  });

  it('rejects an IPv6 literal with the wrong group count', () => {
    expect(parseIpRange('2001:db8:1:2:3:4:5')).toBeNull();
    expect(parseIpRange('2001:db8:1:2:3:4:5:6:7')).toBeNull();
    // "::" must stand for at least one zero group.
    expect(parseIpRange('1:2:3:4:5:6:7::8')).toBeNull();
  });

  it('does not read a BGP community as an address', () => {
    // "7224:7100" is two colon-separated integers — it must not become a v6 range,
    // or filtering by community would silently switch to a range lookup.
    expect(parseIpRange('7224:8100')).toBeNull();
    expect(parseIpRange('65000:1234')).toBeNull();
  });
});

describe('rangesOverlap', () => {
  it('matches a host address against the block that carries it', () => {
    expect(rangesOverlap(parseIpRange('10.20.0.0/16'), parseIpRange('10.20.5.7'))).toBe(true);
    expect(rangesOverlap(parseIpRange('10.21.0.0/16'), parseIpRange('10.20.5.7'))).toBe(false);
  });

  it('matches a block query against the more-specifics inside it', () => {
    expect(rangesOverlap(parseIpRange('10.20.5.0/24'), parseIpRange('10.20.0.0/16'))).toBe(true);
  });

  it('is exclusive at the block boundary', () => {
    expect(rangesOverlap(parseIpRange('10.20.0.0/24'), parseIpRange('10.20.1.0'))).toBe(false);
    expect(rangesOverlap(parseIpRange('10.20.0.0/24'), parseIpRange('10.20.0.255'))).toBe(true);
  });

  it('never crosses address families', () => {
    // ::ffff:0:0/96 numerically contains small v4 values; a cross-family match
    // would report v4 routes for a v6 lookup.
    expect(rangesOverlap(parseIpRange('10.20.0.0/16'), parseIpRange('2001:db8::1'))).toBe(false);
    expect(rangesOverlap(parseIpRange('::/0'), parseIpRange('10.20.5.7'))).toBe(false);
  });

  it('returns false for unparseable input instead of throwing', () => {
    expect(rangesOverlap(null, parseIpRange('10.0.0.1'))).toBe(false);
    expect(rangesOverlap(parseIpRange('10.0.0.0/8'), null)).toBe(false);
  });
});

describe('rangeCovers', () => {
  it('requires full containment, unlike overlap', () => {
    const outer = parseIpRange('10.20.0.0/16');
    expect(rangeCovers(outer, parseIpRange('10.20.5.0/24'))).toBe(true);
    // The /24 does not cover the /16 it sits inside.
    expect(rangeCovers(parseIpRange('10.20.5.0/24'), outer)).toBe(false);
  });

  it('counts an identical block as covering', () => {
    // Looking up an exact advertised prefix must name that prefix as the match.
    expect(rangeCovers(parseIpRange('10.20.0.0/16'), parseIpRange('10.20.0.0/16'))).toBe(true);
  });

  it('covers across v6 prefix lengths', () => {
    expect(rangeCovers(parseIpRange('2001:db8::/32'), parseIpRange('2001:db8:1::1'))).toBe(true);
    expect(rangeCovers(parseIpRange('2001:db9::/32'), parseIpRange('2001:db8:1::1'))).toBe(false);
  });
});
