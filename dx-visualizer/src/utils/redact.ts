import { useTopologyStore } from '../store/topology-store';

const BULLET = '•';
const repeat = (n: number) => BULLET.repeat(n);

// Token-targeted maskers. Each preserves its prefix/shape so the diagram
// still reads as "this is a VPC / VIF / connection" without leaking the
// identifier itself. Order matters: more specific patterns (UUID, prefixed
// resource IDs) must run before broader ones (bare IPv4) so a stray digit
// run inside a UUID isn't masked twice.
const MASKERS: { re: RegExp; replace: (m: string) => string }[] = [
  // Bare DXGW UUID — must run before the account-ID masker, otherwise the
  // 12-digit account regex grabs the UUID's first 12 digits.
  {
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    replace: () => `${repeat(8)}-${repeat(4)}-${repeat(4)}-${repeat(4)}-${repeat(12)}`,
  },

  // Prefixed AWS resource IDs. Handles dxcon-, dxvif-, dxgw-, vgw-, vpc-,
  // tgw- (plus tgw-attach-/tgw-rtb-/tgw-connect-), vpn-, cgw-, subnet-,
  // eni-, nat-, igw-, eigw-, pcx-, rtb-, core-network-, cnpx-. Run before
  // the account-ID masker so a hex suffix like "vpc-123456789012" doesn't
  // get half-masked.
  {
    re: /\b(dx(?:con|vif|gw)|vgw|vpc|tgw(?:-(?:attach|rtb|connect))?|vpn|cgw|subnet|eni|nat|igw|eigw|pcx|rtb|core-network|cnpx)-[0-9a-f]+\b/gi,
    replace: (m) => {
      const i = m.lastIndexOf('-');
      return `${m.slice(0, i + 1)}${repeat(8)}`;
    },
  },

  // 12-digit AWS account ID, with or without dashes (1234-5678-9012 or 123456789012).
  { re: /\b\d{4}-?\d{4}-?\d{4}\b/g, replace: () => `${repeat(4)}-${repeat(4)}-${repeat(4)}` },

  // IPv4 CIDR.
  {
    re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}\b/g,
    replace: () => `${repeat(2)}.${repeat(2)}.${repeat(2)}.${repeat(2)}/${repeat(2)}`,
  },

  // Bare IPv4.
  {
    re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    replace: () => `${repeat(2)}.${repeat(2)}.${repeat(2)}.${repeat(2)}`,
  },

  // ASN — only when explicitly labeled "ASN: 12345" / "AS 12345" so we
  // don't munge unrelated numbers like bandwidth or tunnel counts.
  {
    re: /\b(ASN[:\s]*|AS\s+)(\d{1,10})\b/g,
    replace: (m) => {
      const idx = m.search(/\d/);
      return `${m.slice(0, idx)}${repeat(6)}`;
    },
  },
];

export function redact(input: string | undefined | null, on: boolean): string {
  if (!on || !input) return input ?? '';
  return MASKERS.reduce((s, { re, replace }) => s.replace(re, replace), input);
}

// Hook variant — components subscribe to the store flag once and get a
// stable function back. The closure over `on` means React rerenders the
// component when the flag flips, which is exactly what we want.
export function useRedact(): (s: string | undefined | null) => string {
  const on = useTopologyStore((s) => s.redactMode);
  return (s: string | undefined | null) => redact(s, on);
}
