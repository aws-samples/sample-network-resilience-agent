import { describe, it, expect } from 'vitest';
import { redact, redactAsn, redactCommunity } from '../redact';

describe('redact (off)', () => {
  it('returns input verbatim when flag is false', () => {
    expect(redact('vpc-abc12345 cidr 10.0.0.0/16', false)).toBe('vpc-abc12345 cidr 10.0.0.0/16');
  });

  it('handles empty / null / undefined safely', () => {
    expect(redact('', false)).toBe('');
    expect(redact(null, true)).toBe('');
    expect(redact(undefined, true)).toBe('');
  });
});

describe('redact (on) — AWS account IDs', () => {
  it('masks bare 12-digit account ID', () => {
    expect(redact('Account: 123456789012', true)).toBe('Account: ••••-••••-••••');
  });

  it('masks dashed account ID', () => {
    expect(redact('1234-5678-9012', true)).toBe('••••-••••-••••');
  });
});

describe('redact (on) — resource IDs', () => {
  it('preserves prefix for dxcon-', () => {
    expect(redact('dxcon-abc12345', true)).toBe('dxcon-••••••••');
  });

  it('preserves prefix for dxvif-', () => {
    expect(redact('VIF: dxvif-deadbeef', true)).toBe('VIF: dxvif-••••••••');
  });

  it('preserves prefix for vpc-', () => {
    expect(redact('vpc-0123456789abcdef', true)).toBe('vpc-••••••••');
  });

  it('preserves prefix for tgw-', () => {
    expect(redact('tgw-abc12345', true)).toBe('tgw-••••••••');
  });

  it('preserves prefix for vgw-', () => {
    expect(redact('vgw-abc12345', true)).toBe('vgw-••••••••');
  });

  it('preserves prefix for tgw-attach-', () => {
    expect(redact('tgw-attach-abc12345', true)).toBe('tgw-attach-••••••••');
  });

  it('preserves prefix for subnet-', () => {
    expect(redact('subnet-abcdef12', true)).toBe('subnet-••••••••');
  });

  it('preserves prefix for vpn-', () => {
    expect(redact('vpn-abc12345', true)).toBe('vpn-••••••••');
  });
});

describe('redact (on) — DXGW UUIDs', () => {
  it('masks bare UUID with shape preserved', () => {
    expect(redact('12345678-1234-1234-1234-123456789abc', true)).toBe(
      '••••••••-••••-••••-••••-••••••••••••',
    );
  });
});

describe('redact (on) — CIDRs and IPs', () => {
  it('masks IPv4 CIDR', () => {
    expect(redact('10.0.0.0/16', true)).toBe('••.••.••.••/••');
  });

  it('masks bare IPv4', () => {
    expect(redact('Tunnel IP: 52.10.20.30', true)).toBe('Tunnel IP: ••.••.••.••');
  });
});

describe('redact (on) — ASN', () => {
  it('masks ASN: number', () => {
    expect(redact('ASN: 65001', true)).toBe('ASN: ••••••');
  });

  it('masks AS prefix', () => {
    expect(redact('AS 64512', true)).toBe('AS ••••••');
  });

  it('does not mask unrelated digits', () => {
    expect(redact('1Gbps × 4 connections', true)).toBe('1Gbps × 4 connections');
  });
});

describe('redact (on) — combined', () => {
  it('handles a multi-line node label with several identifiers', () => {
    const input = 'DX Connection\nMy-Conn\ndxcon-abc12345 (1Gbps)\nState: available';
    expect(redact(input, true)).toBe(
      'DX Connection\nMy-Conn\ndxcon-•••••••• (1Gbps)\nState: available',
    );
  });

  it('masks several identifiers in one line', () => {
    expect(redact('Account 123456789012 owns vpc-deadbeef in 10.1.2.0/24', true)).toBe(
      'Account ••••-••••-•••• owns vpc-•••••••• in ••.••.••.••/••',
    );
  });
});

describe('redact (on) — account legend context', () => {
  it('masks a bare 12-digit homeAccountId', () => {
    expect(redact('987654321098', true)).toBe('••••-••••-••••');
  });

  it('does not mask free-text account names (no pattern match)', () => {
    expect(redact('my-production-account', true)).toBe('my-production-account');
  });

  it('does not mask short account alias strings', () => {
    expect(redact('GovTech SG Prod', true)).toBe('GovTech SG Prod');
  });

  it('masks cross-account owner IDs in comma-separated list', () => {
    const ids = ['111122223333', '444455556666'];
    const masked = ids.map((id) => redact(id, true));
    expect(masked).toEqual(['••••-••••-••••', '••••-••••-••••']);
  });

  it('masks account ID embedded in parenthetical', () => {
    expect(redact('(123456789012)', true)).toBe('(••••-••••-••••)');
  });
});

describe('redactAsn', () => {
  it('returns the ASN verbatim when off', () => {
    expect(redactAsn(65000, false)).toBe('65000');
  });

  it('masks a bare ASN that the generic masker would miss', () => {
    // The generic masker only matches labelled ASNs ("ASN: 65000"), so BGP
    // AS-path entries need this dedicated path.
    expect(redact('65000', true)).toBe('65000');
    expect(redactAsn(65000, true)).toBe('••••••');
  });

  it('handles null and undefined', () => {
    expect(redactAsn(undefined, true)).toBe('');
    expect(redactAsn(null, true)).toBe('');
  });
});

describe('redactCommunity', () => {
  it('returns the community verbatim when off', () => {
    expect(redactCommunity('7224:8100', false)).toBe('7224:8100');
  });

  it('masks the ASN half but keeps the value half readable', () => {
    // 7224:8100 etc. carry the routing intent an operator needs to read.
    expect(redactCommunity('7224:8100', true)).toBe('••••••:8100');
  });

  it('fully masks a community that is not in asn:value form', () => {
    expect(redactCommunity('NO_EXPORT', true)).toBe('••••••••');
  });

  it('handles empty input', () => {
    expect(redactCommunity(undefined, true)).toBe('');
  });
});
