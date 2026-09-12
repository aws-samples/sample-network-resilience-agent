import { describe, it, expect } from 'vitest';
import { buildHtmlReport } from '../useExportReport';
import { analyzeTopology } from '../../engine/recommendation-engine';
import { getMockTopology } from '../../utils/mock-data';

/**
 * Resource-ID shape the `utils/redact.ts` masker recognises: a known prefix
 * followed by hex only.
 *
 * The bundled mock scenarios do not have that shape — `dxvif-high01`,
 * `tgw-high01-default-rtb` — because they are written to be readable. `h`, `i`,
 * `g` and `t` are not hex digits, so the masker correctly leaves them alone, and
 * a redaction test run against mock IDs would assert nothing at all while
 * appearing to pass. Same trap as `REAL_VALUES_TO_PURGE` in `sanitize.test.ts`:
 * the scan is substring-based, so a value that could never have matched proves
 * nothing about the values that can.
 */
const MOCK_ID_RE =
  /\b(dxcon|dxlag|dxvif|dxgw|vgw|vpc|tgw(?:-(?:attach|rtb|connect))?|vpn|cgw|subnet|eni|nat|igw|eigw|pcx|rtb)-[A-Za-z0-9-]+\b/g;

/**
 * Rewrites the mock topology's readable IDs into real-looking hex ones,
 * consistently, so cross-references inside the topology still line up.
 */
function makeIdRewriter() {
  const assigned = new Map<string, string>();
  const rewrite = (s: string): string =>
    s.replace(MOCK_ID_RE, (token, prefix: string) => {
      const existing = assigned.get(token);
      if (existing) return existing;
      // Sequential but hex-shaped, and wide enough that no two collide.
      const hex = (0xa1b2c3d4 + assigned.size * 0x10001).toString(16).slice(0, 8);
      const replacement = `${prefix}-${hex}`;
      assigned.set(token, replacement);
      return replacement;
    });
  return { rewrite, assigned };
}

/**
 * Deep string rewrite that understands the containers `TopologyData` uses.
 * `vifRoutes`, `vifUtilization` and friends are `Map`s, so a JSON round-trip
 * would silently drop exactly the sections this test most wants populated.
 */
function deepRewrite<T>(value: T, f: (s: string) => string): T {
  if (typeof value === 'string') return f(value) as T;
  if (value instanceof Map) {
    return new Map([...value].map(([k, v]) => [deepRewrite(k, f), deepRewrite(v, f)])) as T;
  }
  if (value instanceof Set) return new Set([...value].map((v) => deepRewrite(v, f))) as T;
  if (Array.isArray(value)) return value.map((v) => deepRewrite(v, f)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, deepRewrite(v, f)]),
    ) as T;
  }
  return value;
}

const LIVE = { kind: 'live' as const, scenario: null, primaryRegion: 'ap-southeast-1' };

function renderBoth() {
  const { rewrite, assigned } = makeIdRewriter();
  const topology = deepRewrite(getMockTopology('high'), rewrite);
  const assessment = analyzeTopology(topology);
  return {
    plain: buildHtmlReport(topology, assessment, null, 'light', { ...LIVE, redacted: false }),
    redacted: buildHtmlReport(topology, assessment, null, 'light', { ...LIVE, redacted: true }),
    realIds: [...assigned.values()],
  };
}

/** Every `class=` / `id=` attribute value, as a multiset, in document order. */
const attrsOf = (html: string) =>
  [...html.matchAll(/\s(?:class|id)="([^"]*)"/g)].map((m) => m[1]);

const tagsOf = (html: string) => [...html.matchAll(/<\/?([a-z][a-z0-9]*)/g)].map((m) => m[1]);

const idsIn = (html: string) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

describe('report redaction', () => {
  it('masks every real-looking resource ID that reached the unredacted file', () => {
    const { plain, redacted, realIds } = renderBoth();
    // Guard: if the rewriter stopped producing IDs the report renders, the scan
    // below would pass over an empty set.
    const leaked = realIds.filter((id) => plain.includes(id));
    expect(leaked.length).toBeGreaterThan(5);
    for (const id of leaked) {
      expect(redacted, `expected "${id}" to be masked`).not.toContain(id);
    }
  });

  it('masks the account ID everywhere it appears, including the sidebar', () => {
    const { plain, redacted } = renderBoth();
    const account = '123456789012';
    // Twice in the unredacted file: the sidebar sub-line and the header meta.
    expect(plain.split(account).length - 1).toBeGreaterThanOrEqual(2);
    expect(redacted).not.toContain(account);
  });

  it('masks IPs and CIDRs carried in rule descriptions', () => {
    const { plain, redacted } = renderBoth();
    // Blackhole and hybrid-route findings quote the prefix they found, so real
    // on-premises space reaches the file through free text rather than a field.
    const cidrs = [...plain.matchAll(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/\d{1,2})?\b/g)]
      .map((m) => m[0])
      // 0.0.0.0/0 is a route-table sentinel, not an address — the masker rewrites
      // it like any other CIDR, which is why it is excluded here rather than
      // asserted to survive.
      .filter((c) => c !== '0.0.0.0/0');
    expect(cidrs.length).toBeGreaterThan(0);
    expect(redacted).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}\b/);
  });

  it('leaves the markup untouched apart from the provenance chip', () => {
    // The redaction runs as one pass over the finished body HTML, so the thing
    // that could go wrong is the masker matching a class name or an element id
    // instead of the data — which would break the stylesheet and the anchors
    // silently, in the file the customer receives.
    const { plain, redacted } = renderBoth();
    expect(tagsOf(redacted)).toEqual(tagsOf(plain));
    const changed = attrsOf(plain).filter((a, i) => a !== attrsOf(redacted)[i]);
    expect(changed).toEqual(['prov unmasked']);
  });

  it('keeps every in-document link resolving after masking', () => {
    const { redacted } = renderBoth();
    const ids = idsIn(redacted);
    const hrefs = [...redacted.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.filter((h) => !ids.has(h))).toEqual([]);
  });

  it('does not mask the things the report exists to communicate', () => {
    const { redacted } = renderBoth();
    // SLA percentages, published finding IDs, the AWS docs link and the region
    // names all have to survive — a report whose numbers were masked would be
    // unreadable, and region names are not masked on the canvas either.
    expect(redacted).toContain('99.9%');
    expect(redacted).toMatch(/DX-(?:ARC|CFG|OPS)-\d\d/);
    expect(redacted).toContain('docs.aws.amazon.com/directconnect');
    expect(redacted).toContain('ap-southeast-1');
  });
});
