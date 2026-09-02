import { describe, it, expect } from 'vitest';
import { parseBandwidthToBps, formatBps } from '../shared';

describe('parseBandwidthToBps', () => {
  it('parses the units AWS uses for connections and LAGs', () => {
    expect(parseBandwidthToBps('50Mbps')).toBe(50e6);
    expect(parseBandwidthToBps('1Gbps')).toBe(1e9);
    expect(parseBandwidthToBps('10Gbps')).toBe(10e9);
    expect(parseBandwidthToBps('100Gbps')).toBe(100e9);
  });

  it('parses Tbps — VIF rate limits and large LAGs reach 1.6Tbps', () => {
    // Regression: without a T case these returned undefined, which silently
    // hides the utilization bar rather than showing a percentage.
    expect(parseBandwidthToBps('1Tbps')).toBe(1e12);
    expect(parseBandwidthToBps('1.6Tbps')).toBe(1.6e12);
  });

  it('parses the fractional values in the DX rate-limit list', () => {
    expect(parseBandwidthToBps('1.2Gbps')).toBe(1.2e9);
    expect(parseBandwidthToBps('2.7Gbps')).toBeCloseTo(2.7e9, 0);
    expect(parseBandwidthToBps('1.5Tbps')).toBe(1.5e12);
  });

  it('is case-insensitive and tolerates a space before the unit', () => {
    // formatBps emits "1.00 Gbps" with a space; that output must round-trip.
    expect(parseBandwidthToBps('1.00 Gbps')).toBe(1e9);
    expect(parseBandwidthToBps('50 mbps')).toBe(50e6);
  });

  it('returns undefined for unparseable input rather than guessing', () => {
    expect(parseBandwidthToBps(undefined)).toBeUndefined();
    expect(parseBandwidthToBps('')).toBeUndefined();
    expect(parseBandwidthToBps('unknown')).toBeUndefined();
    expect(parseBandwidthToBps('10Gb')).toBeUndefined();
  });
});

describe('formatBps', () => {
  it('scales up to Tbps', () => {
    expect(formatBps(1.6e12)).toBe('1.60 Tbps');
    expect(formatBps(1e12)).toBe('1.00 Tbps');
  });

  it('formats the lower units', () => {
    expect(formatBps(1e9)).toBe('1.00 Gbps');
    expect(formatBps(50e6)).toBe('50.0 Mbps');
    expect(formatBps(5e3)).toBe('5 Kbps');
  });

  it('round-trips through parseBandwidthToBps', () => {
    // topology-builder formats a summed rate limit and CustomEdge parses it back,
    // so a lossy round-trip would corrupt the aggregate-edge denominator.
    for (const v of [50e6, 150e6, 1e9, 250e6, 1.6e12]) {
      expect(parseBandwidthToBps(formatBps(v))).toBe(v);
    }
  });
});

describe('VIF utilization denominator', () => {
  // Mirrors the effective-cap logic in CustomEdge: a VIF's ceiling is its rate
  // limit when set, else the port. This is the arithmetic behind the bug fix.
  const effectiveCap = (rateLimit?: string, port?: string) => {
    const r = parseBandwidthToBps(rateLimit);
    const p = parseBandwidthToBps(port);
    return r != null && p != null ? Math.min(r, p) : r ?? p;
  };
  const pct = (peakBps: number, rateLimit?: string, port?: string) => {
    const cap = effectiveCap(rateLimit, port);
    return cap && cap > 0 ? (peakBps / cap) * 100 : null;
  };

  it('reports a saturated rate-limited VIF as ~100%, not a fraction of the port', () => {
    // The reported bug: a 50Mbps VIF at its cap on a 10Gbps port read as 0.5%,
    // so the amber (50%) and red (80%) thresholds could never fire.
    expect(pct(50e6, undefined, '10Gbps')).toBeCloseTo(0.5, 1);
    expect(pct(50e6, '50Mbps', '10Gbps')).toBeCloseTo(100, 1);
  });

  it('still uses port bandwidth when no rate limit is set', () => {
    expect(pct(500e6, undefined, '1Gbps')).toBeCloseTo(50, 1);
  });

  it('can exceed 100% when a VIF is over its own cap', () => {
    // Real possibility: rate limits shape traffic but CloudWatch reports what
    // actually flowed, and the two are averaged over different windows.
    expect(pct(310e6, '200Mbps', '1Gbps')).toBeCloseTo(155, 0);
  });

  it('takes the min defensively if a rate limit exceeds its port', () => {
    // AWS guarantees rateLimit <= port bandwidth. If that were ever violated,
    // trusting the larger value would under-report utilization.
    expect(pct(1e9, '10Gbps', '1Gbps')).toBeCloseTo(100, 1);
  });

  it('handles a Tbps rate limit without losing the bar', () => {
    expect(pct(800e9, '1.6Tbps', '1.6Tbps')).toBeCloseTo(50, 1);
  });
});
