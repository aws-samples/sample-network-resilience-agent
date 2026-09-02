import type { TopologyData } from '../types/topology';
import type { DxVirtualInterface, VifRoute } from '../types/aws-resources';
import type { Recommendation, NodeAnnotation, ResiliencyLevel } from '../types/recommendations';
import { parseBandwidthToBps, formatBps } from '../utils/shared';

type RuleResult = { annotations: NodeAnnotation[]; recommendation: Recommendation | null };

// --- BGP route helpers (ListVirtualInterfaceRoutes) ---------------------------
// These back the route-hygiene rules below. Every caller must treat missing
// route data as "unknown" and fall back to guidance — routes are only present
// when the user enabled the BGP Routes overlay AND the role carries
// directconnect:ListVirtualInterfaceRoutes.

function vifLabel(vif: DxVirtualInterface): string {
  return vif.virtualInterfaceName || vif.virtualInterfaceId;
}

// A routing domain is keyed by raw gateway ID, but a bare DXGW UUID means
// nothing to a reader — resolve it to the gateway's name where we have one.
function domainLabel(topology: TopologyData, domainId: string): string {
  const dxgw = topology.dxGateways.find((g) => g.directConnectGatewayId === domainId);
  if (dxgw?.directConnectGatewayName) return dxgw.directConnectGatewayName;
  const vgw = topology.vpnGateways.find((g) => g.vpnGatewayId === domainId);
  if (vgw?.tags?.Name) return vgw.tags.Name;
  return domainId;
}

// A "routing domain" is the gateway a VIF terminates on: VIFs sharing one
// DXGW (or VGW) serve the same set of VPCs, so they're the redundant peers
// whose route sets should match. Public VIFs have no gateway and are excluded.
function groupVifsByRoutingDomain(topology: TopologyData): Map<string, DxVirtualInterface[]> {
  const groups = new Map<string, DxVirtualInterface[]>();
  for (const vif of topology.virtualInterfaces) {
    if (vif.virtualInterfaceType === 'public') continue;
    const domain = vif.directConnectGatewayId ?? vif.virtualGatewayId;
    if (!domain) continue;
    const list = groups.get(domain) ?? [];
    list.push(vif);
    groups.set(domain, list);
  }
  return groups;
}

const DEFAULT_ROUTES = new Set(['0.0.0.0/0', '::/0']);

// IPv4 CIDR → [firstAddr, lastAddr] as unsigned 32-bit numbers, or null if the
// string isn't a parseable IPv4 CIDR (IPv6 included — containment math for v6
// needs BigInt and the summarization check deliberately skips it rather than
// risk a wrong answer).
function ipv4Range(cidr: string): [number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((o) => o > 255)) return null;
  const mask = Number(m[5]);
  if (mask > 32) return null;
  const base = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const size = mask === 0 ? 0x100000000 : 2 ** (32 - mask);
  const start = (base & (mask === 0 ? 0 : (-1 << (32 - mask)) >>> 0)) >>> 0;
  return [start, start + size - 1];
}

// True when `inner` is fully contained in `outer` and they aren't the same block.
function isCoveredBy(inner: string, outer: string): boolean {
  if (inner === outer) return false;
  const a = ipv4Range(inner);
  const b = ipv4Range(outer);
  if (!a || !b) return false;
  return b[0] <= a[0] && b[1] >= a[1];
}

// Prefixes that are redundant because a less-specific prefix in the same set
// already covers them. A real summarization finding: the covering route makes
// the covered ones unnecessary, and each one still counts against the
// 100-prefix limit.
function findCoveredPrefixes(routes: VifRoute[]): string[] {
  const cidrs = [...new Set(routes.map((r) => r.cidr).filter(Boolean))];
  const covered: string[] = [];
  for (const inner of cidrs) {
    if (DEFAULT_ROUTES.has(inner)) continue;
    if (cidrs.some((outer) => !DEFAULT_ROUTES.has(outer) && isCoveredBy(inner, outer))) {
      covered.push(inner);
    }
  }
  return covered;
}

function prefixSet(routes: VifRoute[]): Set<string> {
  return new Set(routes.map((r) => r.cidr).filter(Boolean));
}

function summarizeList(items: string[], max = 6): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} (+${items.length - max} more)`;
}

// AWS Direct Connect SLA preconditions that can't be detected via API:
// both the 99.9% (Multi-Site Non-Redundant) and 99.99% (Multi-Site Redundant)
// tiers require an Enterprise Support plan, and the 99.99% tier additionally
// requires a Well-Architected Review with a Solutions Architect. Surfaced as
// attestation-style (info) so users know to verify before claiming the SLA.
// Source: https://aws.amazon.com/directconnect/sla/
export function ruleEnterpriseSupportRequired(
  topology: TopologyData,
  currentLevel: ResiliencyLevel,
  targetLevel?: ResiliencyLevel,
): RuleResult {
  const levels: ResiliencyLevel[] = [currentLevel];
  if (targetLevel) levels.push(targetLevel);
  const appliesToTier = levels.some((l) => l === 'high' || l === 'maximum');
  if (!appliesToTier) return { annotations: [], recommendation: null };
  if (topology.connections.length === 0 && topology.virtualInterfaces.length === 0) {
    return { annotations: [], recommendation: null };
  }

  return {
    annotations: [],
    recommendation: {
      id: 'bp-enterprise-support',
      ruleId: 'enterprise-support-required',
      category: 'bestpractice',
      severity: 'info',
      title: 'Verify Enterprise Support plan is in place',
      description:
        'Required for the 99.9% and 99.99% Direct Connect SLAs. See https://aws.amazon.com/directconnect/sla/',
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

export function ruleWellArchitectedReviewRequired(
  topology: TopologyData,
  currentLevel: ResiliencyLevel,
  targetLevel?: ResiliencyLevel,
): RuleResult {
  const levels: ResiliencyLevel[] = [currentLevel];
  if (targetLevel) levels.push(targetLevel);
  const appliesToTier = levels.includes('maximum');
  if (!appliesToTier) return { annotations: [], recommendation: null };
  if (topology.connections.length === 0 && topology.virtualInterfaces.length === 0) {
    return { annotations: [], recommendation: null };
  }

  return {
    annotations: [],
    recommendation: {
      id: 'bp-well-architected-review',
      ruleId: 'well-architected-review-required',
      category: 'bestpractice',
      severity: 'info',
      title: 'Verify Well-Architected Review has been completed',
      description:
        'Required for the 99.99% Direct Connect SLA, in addition to Enterprise Support. See https://aws.amazon.com/directconnect/sla/',
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: BFD general guidance ---
// BFD state is not available from the AWS API, so this is shown as general guidance
// in the recommendation panel without node badges.
export function ruleBfdGuidance(topology: TopologyData): RuleResult {
  if (topology.connections.length === 0 && topology.virtualInterfaces.length === 0) {
    return { annotations: [], recommendation: null };
  }

  return {
    annotations: [],
    recommendation: {
      id: 'bp-bfd-guidance',
      ruleId: 'bfd-guidance',
      category: 'bestpractice',
      severity: 'info',
      title: 'Ensure Bidirectional Forwarding Detection (BFD) is Enabled',
      description: 'Without BFD, failover relies on BGP hold timers, which can take up to 90 seconds to detect a link failure. BFD reduces detection to under a second. Configure BFD with a minimum interval of 300 ms and a liveness-detection multiplier of 3, and disable BGP graceful restart so BFD-driven failover is not delayed. BFD status is not available via the AWS API — verify it is enabled on your customer router configuration. See https://repost.aws/knowledge-center/enable-bfd-direct-connect',
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: VIF in DOWN state (BGP not established) ---
export function ruleVifDown(topology: TopologyData): RuleResult {
  const downVifs: string[] = [];

  for (const vif of topology.virtualInterfaces) {
    // Check if VIF state itself is down
    const vifDown = vif.virtualInterfaceState !== 'available';
    // Check if all BGP peers are down
    const allBgpDown = vif.bgpPeers.length > 0 &&
      vif.bgpPeers.every((p) => p.bgpStatus !== 'up');

    if (vifDown || allBgpDown) {
      downVifs.push(vif.virtualInterfaceName || vif.virtualInterfaceId);
      // Status is shown on the edge in Live Status mode — no node badge needed
    }
  }

  if (downVifs.length === 0) return { annotations: [], recommendation: null };

  return {
    annotations: [],
    recommendation: {
      id: 'bp-vif-down',
      ruleId: 'vif-down',
      category: 'bestpractice',
      severity: 'critical',
      title: 'Virtual Interface(s) in DOWN State',
      description: `BGP is down on ${downVifs.join(', ')} — no traffic can flow over ${downVifs.length === 1 ? 'this path' : 'these paths'}. Check the BGP configuration, VLAN tagging, and physical connectivity.`,
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: Connection in non-available state ---
export function ruleConnectionNotAvailable(topology: TopologyData): RuleResult {
  const badConns: string[] = [];

  for (const conn of topology.connections) {
    if (conn.connectionState !== 'available') {
      badConns.push(conn.connectionName || conn.connectionId);
      // Status is shown on the edge in Live Status mode — no node badge needed
    }
  }

  if (badConns.length === 0) return { annotations: [], recommendation: null };

  return {
    annotations: [],
    recommendation: {
      id: 'bp-connection-not-available',
      ruleId: 'connection-not-available',
      category: 'bestpractice',
      severity: 'critical',
      title: 'Direct Connect Connection(s) Not Available',
      description: `${badConns.length} connection(s) are not in "available" state: ${badConns.join(', ')}. These connections are not passing traffic. Check the AWS Console for provisioning status or errors.`,
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: No VPN backup for DX ---
export function ruleNoVpnBackup(topology: TopologyData): RuleResult {
  // Only relevant if DX connections exist
  if (topology.connections.length === 0 && topology.virtualInterfaces.length === 0) {
    return { annotations: [], recommendation: null };
  }

  // Check if any VPN connections exist as a backup path
  if (topology.vpnConnections.length > 0) {
    return { annotations: [], recommendation: null };
  }

  return {
    annotations: [],
    recommendation: {
      id: 'bp-no-vpn-backup',
      ruleId: 'no-vpn-backup',
      category: 'bestpractice',
      severity: 'warning',
      title: 'No Site-to-Site VPN Backup',
      description: 'No Site-to-Site VPN connections detected alongside Direct Connect. AWS recommends configuring a VPN connection as a backup path so that if Direct Connect is entirely unavailable (e.g., fiber cut or location outage), traffic can fail over to the internet-based VPN tunnel. Note: a VPN backup does not improve the Direct Connect SLA — it only provides a failover path, useful for budget-constrained deployments that can\'t justify a second Direct Connect.',
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: SLA tier awareness (guidance-only) ---
export function ruleSlaAwareness(topology: TopologyData): RuleResult {
  if (topology.connections.length === 0 && topology.virtualInterfaces.length === 0) {
    return { annotations: [], recommendation: null };
  }

  return {
    annotations: [],
    recommendation: {
      id: 'bp-sla-awareness',
      ruleId: 'sla-awareness',
      category: 'bestpractice',
      severity: 'info',
      title: 'Understand Direct Connect SLA tiers',
      description: 'AWS publishes three Direct Connect SLA tiers: Single Connection (95%), Multi-Site Non-Redundant / High Resiliency (99.9%, 2+ locations), and Multi-Site Redundant / Maximum Resiliency (99.99%, 2+ locations with 2+ devices each). Only the Maximum Resiliency model qualifies for the highest SLA. See https://aws.amazon.com/directconnect/sla/',
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: Resiliency Toolkit recommendation (guidance-only) ---
export function ruleResiliencyToolkit(topology: TopologyData): RuleResult {
  if (topology.connections.length === 0 && topology.virtualInterfaces.length === 0) {
    return { annotations: [], recommendation: null };
  }

  return {
    annotations: [],
    recommendation: {
      id: 'bp-resiliency-toolkit',
      ruleId: 'resiliency-toolkit',
      category: 'bestpractice',
      severity: 'info',
      title: 'Use the Direct Connect Resiliency Toolkit for production workloads',
      description: 'For production or mission-critical workloads, implement the High Resiliency or Maximum Resiliency model using the AWS Direct Connect Resiliency Toolkit so traffic keeps flowing during a maintenance event. The Development and Test model is a more cost-efficient fit for non-production workloads. See https://docs.aws.amazon.com/directconnect/latest/UserGuide/resiliency_toolkit.html and https://docs.aws.amazon.com/directconnect/latest/UserGuide/dx-maintenance.html',
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: Consistent BGP prefix advertisement (guidance-only) ---
export function ruleConsistentPrefixAdvertisement(topology: TopologyData): RuleResult {
  // Only relevant when there are 2+ VIFs (something to compare against).
  if (topology.virtualInterfaces.length < 2) {
    return { annotations: [], recommendation: null };
  }

  // Evidence-based path: with real route data we can compare the prefixes AWS
  // *accepted* from each redundant VIF and report the actual divergence.
  const routes = topology.vifRoutes;
  if (routes && routes.size > 0) {
    // Report per routing domain against the domain's full prefix set (the union
    // across its VIFs), not pairwise. A star comparison against an arbitrary
    // reference VIF listed the same prefixes once per pair and, when the
    // reference was itself the deficient VIF, blamed every sibling in turn —
    // N-1 lines describing one problem. "VIF x is missing these" is one line
    // per VIF and says which router to fix.
    const domainFindings: string[] = [];
    let comparedPairs = 0;
    for (const [domain, vifs] of groupVifsByRoutingDomain(topology)) {
      const withRoutes = vifs.filter((v) => routes.has(v.virtualInterfaceId));
      if (withRoutes.length < 2) continue;
      comparedPairs += withRoutes.length - 1;

      const sets = withRoutes.map((v) => ({
        label: vifLabel(v),
        set: prefixSet(routes.get(v.virtualInterfaceId)!.accepted),
      }));
      const union = new Set<string>();
      for (const { set } of sets) for (const cidr of set) union.add(cidr);

      const short = sets
        .map(({ label, set }) => ({ label, missing: [...union].filter((c) => !set.has(c)) }))
        .filter((s) => s.missing.length > 0);
      if (short.length === 0) continue;

      const perVif = short.map(
        ({ label, missing }) =>
          `${label} is missing ${missing.length} of ${union.size} (${summarizeList(missing, 5)})`,
      );
      domainFindings.push(`On ${domainLabel(topology, domain)} — ${perVif.join('; ')}`);
    }

    if (domainFindings.length > 0) {
      return {
        annotations: [],
        recommendation: {
          id: 'bp-consistent-prefix-advertisement',
          ruleId: 'consistent-prefix-advertisement',
          category: 'bestpractice',
          severity: 'warning',
          title: 'Redundant VIFs are not receiving the same prefixes',
          description: `BGP route data shows redundant Virtual Interfaces in the same routing domain accepting different prefix sets, so the failover path does not have the same reachability as the primary. Each VIF below is compared against every prefix its routing domain receives, and is listed with what it does not carry: ${domainFindings.join('. ')}. Add the missing prefixes on the customer router behind each VIF listed, or confirm the difference is intentional traffic engineering. Click Route diff on the Direct Connect Gateway to see, prefix by prefix, which other VIFs carry it and which prefixes have no backup path at all.`,
          additionalNodes: [],
          additionalEdges: [],
        },
      };
    }

    if (comparedPairs > 0) {
      return {
        annotations: [],
        recommendation: {
          id: 'bp-consistent-prefix-advertisement',
          ruleId: 'consistent-prefix-advertisement',
          category: 'bestpractice',
          severity: 'info',
          title: 'Redundant VIFs receive matching prefix sets',
          description: `Verified from BGP route data: every pair of redundant Virtual Interfaces compared (${comparedPairs}) accepts an identical set of prefixes, so a failover preserves reachability. Re-check after any on-premises routing policy change.`,
          additionalNodes: [],
          additionalEdges: [],
        },
      };
    }
  }

  // No route data (overlay off, permission missing, or imported v1 snapshot) —
  // fall back to guidance.
  return {
    annotations: [],
    recommendation: {
      id: 'bp-consistent-prefix-advertisement',
      ruleId: 'consistent-prefix-advertisement',
      category: 'bestpractice',
      severity: 'info',
      title: 'Advertise the same prefixes across redundant VIFs',
      description: 'Validate that the same BGP prefixes are learned and advertised across redundant Virtual Interfaces. Asymmetric advertisement leaves the failover path with different reachability and can cause traffic blackholes during a failover. Enable the BGP Routes overlay (requires directconnect:ListVirtualInterfaceRoutes) to check this automatically, or verify from your customer router.',
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: VIF route symmetry & prefix summarization (guidance-only) ---
export function ruleVifRouteSymmetry(topology: TopologyData): RuleResult {
  if (topology.virtualInterfaces.length === 0) {
    return { annotations: [], recommendation: null };
  }

  // With real prefixes we can detect routes made redundant by a less-specific
  // route in the same set — concrete, actionable summarization findings.
  const routes = topology.vifRoutes;
  if (routes && routes.size > 0) {
    const findings: string[] = [];
    for (const vif of topology.virtualInterfaces) {
      const entry = routes.get(vif.virtualInterfaceId);
      if (!entry) continue;
      const covered = findCoveredPrefixes(entry.accepted);
      if (covered.length > 0) {
        findings.push(`${vifLabel(vif)}: ${summarizeList(covered)}`);
      }
    }

    if (findings.length > 0) {
      return {
        annotations: [],
        recommendation: {
          id: 'bp-vif-route-symmetry',
          ruleId: 'vif-route-symmetry',
          category: 'bestpractice',
          severity: 'warning',
          title: 'Redundant specific prefixes — summarize to protect the 100-prefix limit',
          description: `BGP route data shows prefixes that are already covered by a less-specific prefix accepted on the same Virtual Interface. Each one still consumes one of the 100 prefixes AWS accepts per BGP session, so removing them buys headroom without changing reachability: ${findings.join('; ')}. Advertise the aggregate only, unless the more-specific routes exist for deliberate traffic engineering.`,
          additionalNodes: [],
          additionalEdges: [],
        },
      };
    }
  }

  return {
    annotations: [],
    recommendation: {
      id: 'bp-vif-route-symmetry',
      ruleId: 'vif-route-symmetry',
      category: 'bestpractice',
      severity: 'info',
      title: 'Summarize prefixes and keep VIF routing symmetric',
      description: 'Route summarization — advertising individual /24s will exhaust the 100-prefix limit rapidly. Consolidate into aggregate prefixes. All VIFs attached to the same DXGW or VGW serving the same routing domain should advertise and receive identical prefix sets with consistent BGP attributes (local preference, AS_PATH length, etc.) unless traffic manipulation is required. Enable the BGP Routes overlay (requires directconnect:ListVirtualInterfaceRoutes) to check summarization automatically, or verify from your customer router.',
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: LAG min-links guidance (guidance-only) ---
export function ruleLagMinLinks(topology: TopologyData): RuleResult {
  if (topology.lags.length === 0) {
    return { annotations: [], recommendation: null };
  }

  return {
    annotations: [],
    recommendation: {
      id: 'bp-lag-min-links',
      ruleId: 'lag-min-links',
      category: 'bestpractice',
      severity: 'info',
      title: 'Configure LAG min-links — a LAG is not a resiliency mechanism',
      description: 'A LAG is a bandwidth aggregation mechanism, not a resiliency mechanism — all member connections terminate on the same AWS device at the same location. Configure the min-links parameter to define the minimum number of active members required for the LAG to remain operational. Without min-links, a severely degraded LAG continues forwarding traffic at reduced capacity rather than triggering failover to a redundant path. Set min-links to n/2 + 1 (majority) to force clean failover before congestion occurs, or to 1 when external redundancy can absorb the full traffic load.',
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: BGP route limit ---
// The quota is "100 each for IPv4 and IPv6" per BGP session on private and
// transit VIFs — not 100 pooled across both:
//   https://docs.aws.amazon.com/directconnect/latest/UserGuide/limits.html
// So the count MUST be bucketed per address family. Pooling mis-scores
// dual-stack VIFs in both directions: 60 v4 + 60 v6 reads critical when both
// families are healthy, and 95 v4 + 3 v6 reads "well under" when v4 is three
// prefixes from teardown.
//
// Two sources give us the accepted count, in preference order:
//   1. ListVirtualInterfaceRoutes — exact routes, each carrying addressFamily.
//   2. CloudWatch VirtualInterfaceBgpPrefixesAccepted — carries the documented
//      IpAddressFamily dimension, split out in cloudwatch-dx.ts.
// Routes with no addressFamily (v1 snapshots, older mocks) count as IPv4: it is
// the overwhelmingly common family, and the alternative — dropping them — would
// under-report a session that is actually near teardown.
//
// We warn above the hard limit, caution near it, and confirm "met" when healthy.
// Public VIFs have a higher published limit (1000) and are excluded from this check.
const BGP_ROUTE_HARD_LIMIT = 100;
const BGP_ROUTE_CAUTION_THRESHOLD = 80;

type FamilyCounts = { ipv4?: number; ipv6?: number };

// Per-family accepted counts for one VIF, or undefined when neither source has
// data. Exact routes win over the metric.
function acceptedByFamily(topology: TopologyData, vifId: string): FamilyCounts | undefined {
  const routes = topology.vifRoutes?.get(vifId)?.accepted;
  if (routes) {
    const counts: FamilyCounts = {};
    for (const r of routes) {
      const fam = r.addressFamily === 'ipv6' ? 'ipv6' : 'ipv4';
      counts[fam] = (counts[fam] ?? 0) + 1;
    }
    return counts;
  }

  const metric = topology.bgpPrefixMetrics?.get(vifId);
  if (!metric) return undefined;
  if (metric.byFamily) {
    const counts: FamilyCounts = {};
    if (metric.byFamily.ipv4?.accepted !== undefined) counts.ipv4 = metric.byFamily.ipv4.accepted;
    if (metric.byFamily.ipv6?.accepted !== undefined) counts.ipv6 = metric.byFamily.ipv6.accepted;
    if (counts.ipv4 !== undefined || counts.ipv6 !== undefined) return counts;
  }
  // Pooled-only metric (pre-split snapshot, or the dimension was absent). Treat
  // it as IPv4 rather than discarding it — a single-family VIF is the common
  // case, and this is the same number the rule used before per-family existed.
  return metric.accepted === undefined ? undefined : { ipv4: metric.accepted };
}

export function ruleBgpRouteLimit(topology: TopologyData): RuleResult {
  const applicableVifs = topology.virtualInterfaces.filter(
    (v) => v.virtualInterfaceType === 'private' || v.virtualInterfaceType === 'transit',
  );
  if (applicableVifs.length === 0) {
    return { annotations: [], recommendation: null };
  }

  const over: string[] = [];
  const near: string[] = [];
  const healthy: Array<{ id: string; count: number }> = [];
  const unknown: string[] = [];

  for (const vif of applicableVifs) {
    const counts = acceptedByFamily(topology, vif.virtualInterfaceId);
    const label = `${vif.virtualInterfaceName || vif.virtualInterfaceId}`;
    if (!counts) {
      unknown.push(label);
      continue;
    }

    // Each family is judged against its own 100-prefix budget. A VIF is
    // reported at its worst family, and dual-stack VIFs name the family so the
    // reader knows which side to summarize.
    const families = (['ipv4', 'ipv6'] as const).filter((f) => counts[f] !== undefined);
    const isDualStack = families.length > 1;
    const worst = families.reduce(
      (acc, f) => ((counts[f] ?? 0) > (counts[acc] ?? 0) ? f : acc),
      families[0] ?? 'ipv4',
    );
    const peak = counts[worst] ?? 0;
    const detail = isDualStack
      ? `${label} (${peak} accepted on ${worst === 'ipv4' ? 'IPv4' : 'IPv6'})`
      : `${label} (${peak} accepted)`;

    if (peak >= BGP_ROUTE_HARD_LIMIT) {
      over.push(detail);
    } else if (peak >= BGP_ROUTE_CAUTION_THRESHOLD) {
      near.push(detail);
    } else {
      healthy.push({ id: label, count: peak });
    }
  }

  if (over.length > 0) {
    return {
      annotations: [],
      recommendation: {
        id: 'bp-bgp-route-limit',
        ruleId: 'bgp-route-limit',
        category: 'bestpractice',
        severity: 'critical',
        title: 'BGP route limit reached — session at risk of teardown',
        description: `The following VIFs are at or above the 100-prefix limit for on-premises → AWS advertisement: ${over.join(', ')}. The quota is 100 prefixes each for IPv4 and IPv6, counted per address family — exceeding it on either family causes BGP session teardown and network disconnection. Summarize or filter on-premises routes immediately. See https://docs.aws.amazon.com/directconnect/latest/UserGuide/limits.html`,
        additionalNodes: [],
        additionalEdges: [],
      },
    };
  }

  if (near.length > 0) {
    return {
      annotations: [],
      recommendation: {
        id: 'bp-bgp-route-limit',
        ruleId: 'bgp-route-limit',
        category: 'bestpractice',
        severity: 'warning',
        title: 'BGP routes approaching the 100-prefix limit',
        description: `The following VIFs are within 20 prefixes of the 100-prefix hard limit, which applies separately to IPv4 and IPv6: ${near.join(', ')}. Plan summarization now so on-premises growth does not trigger a BGP session teardown. See https://docs.aws.amazon.com/directconnect/latest/UserGuide/limits.html`,
        additionalNodes: [],
        additionalEdges: [],
      },
    };
  }

  if (healthy.length > 0 && unknown.length === 0) {
    const max = healthy.reduce((m, h) => Math.max(m, h.count), 0);
    return {
      annotations: [],
      recommendation: {
        id: 'bp-bgp-route-limit',
        ruleId: 'bgp-route-limit-ok',
        category: 'bestpractice',
        severity: 'info',
        title: 'BGP routes within the 100-prefix limit',
        description: `All ${healthy.length} private/transit VIF${healthy.length > 1 ? 's are well under' : ' is well under'} the 100-prefix hard limit — peak observed is ${max} prefix${max === 1 ? '' : 'es'} accepted from on-premises on any single address family (the quota is 100 each for IPv4 and IPv6).`,
        additionalNodes: [],
        additionalEdges: [],
      },
    };
  }

  return {
    annotations: [],
    recommendation: {
      id: 'bp-bgp-route-limit',
      ruleId: 'bgp-route-limit',
      category: 'bestpractice',
      severity: 'info',
      title: 'Keep BGP routes under 100 per session',
      description: `Private and transit Virtual Interfaces accept at most 100 routes per BGP session from on-premises to AWS — 100 each for IPv4 and IPv6, counted separately. CloudWatch prefix metrics were not available for ${unknown.length === 1 ? 'this VIF' : `these ${unknown.length} VIFs`} (${unknown.join(', ')}) — verify the count directly on your customer router and summarize routes if needed. See https://docs.aws.amazon.com/directconnect/latest/UserGuide/limits.html`,
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// How long a tunnel has held its current state, from VgwTelemetry.LastStatusChange.
// A tunnel down for months is a different finding from one that dropped minutes
// ago — the first is an abandoned backup path, the second may be mid-recovery.
// Returns undefined when the field is absent (older snapshots, mocks) or when
// the timestamp is in the future, which would otherwise render as "-3 days".
function formatDownDuration(iso?: string): string | undefined {
  if (!iso) return undefined;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  const ms = Date.now() - then;
  if (ms < 0) return undefined;
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `down ${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `down ${hours} hour${hours === 1 ? '' : 's'}`;
  const mins = Math.max(1, Math.floor(ms / 60_000));
  return `down ${mins} minute${mins === 1 ? '' : 's'}`;
}

// --- Rule: VPN tunnel redundancy (detectable) ---
export function ruleVpnTunnelRedundancy(topology: TopologyData): RuleResult {
  if (topology.vpnConnections.length === 0) {
    return { annotations: [], recommendation: null };
  }

  const degraded: string[] = [];
  for (const vpn of topology.vpnConnections) {
    const upTunnels = vpn.tunnels.filter((t) => t.status === 'UP').length;
    if (upTunnels < 2) {
      // Name how long each down tunnel has been down, when AWS told us.
      const durations = vpn.tunnels
        .filter((t) => t.status !== 'UP')
        .map((t) => formatDownDuration(t.lastStatusChange))
        .filter((d): d is string => !!d);
      const detail = durations.length > 0 ? `, ${durations.join(', ')}` : '';
      degraded.push(`${vpn.vpnConnectionId} (${upTunnels}/2 tunnels UP${detail})`);
    }
  }

  if (degraded.length === 0) return { annotations: [], recommendation: null };

  return {
    annotations: [],
    recommendation: {
      id: 'bp-vpn-tunnel-redundancy',
      ruleId: 'vpn-tunnel-redundancy',
      category: 'bestpractice',
      severity: 'warning',
      title: 'Ensure both VPN tunnels are UP for redundancy',
      description: `Each Site-to-Site VPN connection provides two tunnels for redundancy. The following connection(s) do not have both tunnels UP: ${degraded.join(', ')}. Investigate the customer gateway configuration and the tunnel health to restore redundancy.`,
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: blackholed routes ---
// A blackhole route silently discards traffic for its prefix. On a TGW route
// table it usually means the attachment a prefix pointed at is gone; in a VPC
// route table it means the target (NAT gateway, ENI, peering) no longer exists.
// Either way the topology looks connected and the traffic dies. Both fields are
// already fetched and rendered — nothing scored them until now.
export function ruleBlackholeRoutes(topology: TopologyData): RuleResult {
  const tgwOffenders: string[] = [];
  for (const tables of topology.tgwRouteTables.values()) {
    for (const entry of tables) {
      const holes = entry.routes.filter((route) => route.state === 'blackhole');
      if (holes.length === 0) continue;
      const label =
        entry.routeTable.tags?.Name || entry.routeTable.transitGatewayRouteTableId;
      // Name a couple of prefixes so the finding is actionable, not just a count.
      const sample = holes.slice(0, 3).map((h) => h.destinationCidrBlock).join(', ');
      tgwOffenders.push(
        `${label}: ${holes.length} blackholed (${sample}${holes.length > 3 ? ', …' : ''})`,
      );
    }
  }

  const vpcOffenders: string[] = [];
  for (const tables of topology.vpcRouteTables.values()) {
    for (const rt of tables) {
      const holes = rt.routes.filter((route) => route.state === 'blackhole');
      if (holes.length === 0) continue;
      const label = rt.tags?.Name || rt.routeTableId;
      const sample = holes
        .slice(0, 3)
        .map((h) => h.destinationCidrBlock || h.destinationIpv6CidrBlock || h.destinationPrefixListId || '?')
        .join(', ');
      vpcOffenders.push(
        `${label}: ${holes.length} blackholed (${sample}${holes.length > 3 ? ', …' : ''})`,
      );
    }
  }

  if (tgwOffenders.length === 0 && vpcOffenders.length === 0) {
    return { annotations: [], recommendation: null };
  }

  const parts: string[] = [];
  if (tgwOffenders.length > 0) parts.push(`Transit Gateway route tables — ${tgwOffenders.join('; ')}`);
  if (vpcOffenders.length > 0) parts.push(`VPC route tables — ${vpcOffenders.join('; ')}`);

  return {
    annotations: [],
    recommendation: {
      id: 'bp-blackhole-routes',
      ruleId: 'blackhole-routes',
      category: 'bestpractice',
      severity: 'warning',
      title: 'Blackhole routes are silently discarding traffic',
      description: `A blackhole route matches traffic and then drops it — the path looks configured but nothing gets through, and it produces no error anywhere. Found in: ${parts.join('. ')}. A blackhole normally means the attachment or target a prefix pointed at was deleted while the route remained. Delete the stale routes, or re-point them at a live attachment. Pay particular attention to any blackholed prefix that covers on-premises space: that is a hybrid outage waiting for the next failover.`,
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: VPC route tables with no path to on-premises ---
// A VPC can be attached to a TGW or have a VGW and still not use it: unless a
// route table actually points at the gateway, subnets using that table have no
// route to on-prem. Silent when no VPC route tables were fetched.
export function ruleVpcNoHybridRoute(topology: TopologyData): RuleResult {
  // Only meaningful when hybrid connectivity exists at all.
  if (topology.connections.length === 0 && topology.vpnConnections.length === 0) {
    return { annotations: [], recommendation: null };
  }
  if (topology.vpcRouteTables.size === 0) return { annotations: [], recommendation: null };

  const offenders: string[] = [];
  let checked = 0;

  for (const [vpcId, tables] of topology.vpcRouteTables.entries()) {
    for (const rt of tables) {
      // Only tables that actually carry traffic: the main table (default for any
      // unassociated subnet) or one with explicit subnet associations. An
      // orphaned table routes nothing, so it is not a finding.
      if (!rt.isMain && rt.associatedSubnetIds.length === 0) continue;
      checked++;
      const hasHybridTarget = rt.routes.some(
        (route) =>
          !!route.transitGatewayId ||
          !!route.coreNetworkArn ||
          // vgw-* on gatewayId is a virtual private gateway; igw-* is not hybrid.
          (!!route.gatewayId && /^vgw-/i.test(route.gatewayId)),
      );
      if (!hasHybridTarget) {
        const label = rt.tags?.Name || rt.routeTableId;
        offenders.push(`${label} in ${vpcId}${rt.isMain ? ' (main)' : ''}`);
      }
    }
  }

  if (checked === 0 || offenders.length === 0) {
    return { annotations: [], recommendation: null };
  }

  return {
    annotations: [],
    recommendation: {
      id: 'bp-vpc-no-hybrid-route',
      ruleId: 'vpc-no-hybrid-route',
      category: 'bestpractice',
      severity: 'info',
      title: 'Some VPC route tables have no route toward on-premises',
      description: `${offenders.length === 1 ? 'This in-use route table has' : `These ${offenders.length} in-use route tables have`} no route pointing at a Transit Gateway, virtual private gateway, or Cloud WAN core network: ${offenders.join(', ')}. Subnets using ${offenders.length === 1 ? 'it' : 'them'} cannot reach on-premises regardless of how healthy the Direct Connect path is — the attachment exists but the subnet never routes to it. This is expected for deliberately isolated subnets (public tiers, egress-only workloads); confirm each one is intentional rather than a missed route entry.`,
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: DX gateway route propagation into TGW route tables ---
// A TGW route table only learns on-prem prefixes if the DX gateway attachment
// is set to propagate into it. Without propagation the table looks plausible and
// the attachment looks healthy, but nothing routes to on-prem — the classic
// silent blackhole that only shows up during a failover.
//
// Requires the propagation data (ec2:GetTransitGatewayRouteTablePropagations, a
// Get* action not covered by ec2:Describe*). `propagations === undefined` means
// not fetched or denied, so those tables are skipped entirely — we never report
// "propagation missing" from missing data.
export function ruleDxgwPropagationEnabled(topology: TopologyData): RuleResult {
  // Only meaningful when DX actually reaches a TGW via a transit VIF.
  const hasTransitVif = topology.virtualInterfaces.some(
    (v) => v.virtualInterfaceType === 'transit',
  );
  if (!hasTransitVif) return { annotations: [], recommendation: null };

  const missing: string[] = [];
  const pending: string[] = [];
  let checked = 0;

  for (const tables of topology.tgwRouteTables.values()) {
    for (const entry of tables) {
      if (!entry.propagations) continue; // unknown, not empty
      checked++;
      const dxProps = entry.propagations.filter((p) =>
        /direct-connect|dxgw/i.test(p.resourceType),
      );
      const label =
        entry.routeTable.tags?.Name ||
        entry.routeTable.transitGatewayRouteTableId ||
        'route table';
      if (dxProps.length === 0) {
        missing.push(label);
      } else if (dxProps.every((p) => p.state !== 'enabled')) {
        pending.push(`${label} (${dxProps.map((p) => p.state).join(', ')})`);
      }
    }
  }

  if (checked === 0) return { annotations: [], recommendation: null };

  if (missing.length > 0 || pending.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(
        `no Direct Connect gateway attachment propagates into ${missing.join(', ')}`,
      );
    }
    if (pending.length > 0) {
      parts.push(`propagation is not yet enabled on ${pending.join(', ')}`);
    }
    return {
      annotations: [],
      recommendation: {
        id: 'bp-dxgw-propagation',
        ruleId: 'dxgw-propagation',
        category: 'bestpractice',
        severity: 'warning',
        title: 'Enable Direct Connect gateway route propagation on TGW route tables',
        description: `AWS recommends enabling route propagation for Direct Connect gateway attachments so on-premises prefixes are learned dynamically. In this topology, ${parts.join('; and ')}. Without propagation the route table can look healthy while carrying no path to on-premises — traffic silently blackholes, typically discovered only during a failover. Enable propagation for the Direct Connect gateway attachment on the affected route table(s), or confirm the prefixes are intentionally installed as static routes.`,
        additionalNodes: [],
        additionalEdges: [],
      },
    };
  }

  return {
    annotations: [],
    recommendation: {
      id: 'bp-dxgw-propagation',
      ruleId: 'dxgw-propagation-ok',
      category: 'bestpractice',
      severity: 'info',
      title: 'Direct Connect gateway route propagation is enabled',
      description: `All ${checked} checked Transit Gateway route table${checked === 1 ? ' has' : 's have'} an enabled Direct Connect gateway propagation, so on-premises prefixes are learned dynamically rather than depending on static routes.`,
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: BGP session instability (flap history) ---
// DescribeVirtualInterfaces reports the BGP state right now, so a session that
// dropped 11 times last week looks identical to one that has been solid for a
// year. The AWS/DX VirtualInterfaceBgpStatus metric carries the history.
// Silent when the metric was never fetched (it is billed per metric retrieved,
// so it is on-demand only) — never imply stability we did not measure.
const BGP_FLAP_WARN_THRESHOLD = 3;

export function ruleBgpSessionStability(topology: TopologyData): RuleResult {
  const stability = topology.bgpStability;
  if (!stability || stability.size === 0) return { annotations: [], recommendation: null };

  const flapping: Array<{ label: string; count: number; window: number; lastAt?: string }> = [];
  for (const vif of topology.virtualInterfaces) {
    const s = stability.get(vif.virtualInterfaceId);
    if (!s || s.flapCount === 0) continue;
    flapping.push({
      label: vif.virtualInterfaceName || vif.virtualInterfaceId,
      count: s.flapCount,
      window: s.windowDays,
      lastAt: s.lastFlapAt,
    });
  }

  if (flapping.length === 0) {
    // Only claim stability over the window we actually sampled.
    const windows = [...new Set([...stability.values()].map((s) => s.windowDays))];
    const windowText = windows.length === 1 ? `${windows[0]} days` : 'the sampled window';
    return {
      annotations: [],
      recommendation: {
        id: 'bp-bgp-session-stability',
        ruleId: 'bgp-session-stability-ok',
        category: 'bestpractice',
        severity: 'info',
        title: 'BGP sessions stable over the sampled window',
        description: `No BGP session drops were observed on ${stability.size === 1 ? 'the monitored VIF' : `all ${stability.size} monitored VIFs`} over the last ${windowText}. Note this reflects only the sampled window — CloudWatch retains 5-minute data for 63 days, so older events are not visible at this resolution.`,
        additionalNodes: [],
        additionalEdges: [],
      },
    };
  }

  flapping.sort((a, b) => b.count - a.count);
  const worst = flapping[0].count;
  const detail = flapping
    .map((f) => {
      const when = f.lastAt ? `, last ${f.lastAt.slice(0, 10)}` : '';
      return `${f.label} (${f.count} drop${f.count === 1 ? '' : 's'} in ${f.window}d${when})`;
    })
    .join(', ');

  return {
    annotations: [],
    recommendation: {
      id: 'bp-bgp-session-stability',
      ruleId: 'bgp-session-stability',
      category: 'bestpractice',
      // A single blip is worth noting; repeated drops mean the redundancy is
      // being exercised for real and something upstream is unhealthy.
      severity: worst >= BGP_FLAP_WARN_THRESHOLD ? 'warning' : 'info',
      title:
        worst >= BGP_FLAP_WARN_THRESHOLD
          ? 'BGP sessions are flapping — investigate before relying on failover'
          : 'BGP session drops observed in the sampled window',
      description: `The following virtual interface${flapping.length === 1 ? ' has' : 's have'} lost the BGP session at least once: ${detail}. A session that is currently "up" can still be unstable, and each drop is a real traffic interruption on that path. Check for physical-layer errors (ConnectionErrorCount, optical light levels), customer-router BGP timer or route-limit issues, and whether the drops correlate with AWS maintenance events. Repeated flaps mean your redundancy is absorbing failures that should be fixed at the source.`,
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: static-routes-only VPN cannot dynamically fail over ---
// A VPN configured with static routes has no BGP session, so it cannot withdraw
// or re-advertise prefixes when a path fails. That matters most where the app
// recommends a VPN as the DX backup (see ruleNoVpnBackup): a static VPN will not
// pick up traffic on its own. AWS recommends BGP Site-to-Site VPN for TGW
// attachments. Silent when no VPN reports the flag (older snapshots, mocks).
export function ruleVpnStaticRoutesOnly(topology: TopologyData): RuleResult {
  const staticVpns = topology.vpnConnections.filter((v) => v.staticRoutesOnly === true);
  if (staticVpns.length === 0) return { annotations: [], recommendation: null };

  const ids = staticVpns.map((v) => v.vpnConnectionId).join(', ');
  const hasDx = topology.connections.length > 0;

  return {
    annotations: [],
    recommendation: {
      id: 'bp-vpn-static-routes-only',
      ruleId: 'vpn-static-routes-only',
      category: 'bestpractice',
      severity: 'warning',
      title: 'Site-to-Site VPN uses static routes — no dynamic failover',
      description: `${staticVpns.length === 1 ? 'This VPN connection is' : `These ${staticVpns.length} VPN connections are`} configured with static routes only (${ids}), so ${staticVpns.length === 1 ? 'it has' : 'they have'} no BGP session and cannot withdraw or re-advertise prefixes when a path fails.${hasDx ? ' Traffic will not move to or from Direct Connect automatically, so this VPN is not a working backup for your DX path despite being present.' : ''} Recreate the connection with BGP (dynamic routing) so failover is automatic, and verify the customer gateway supports BGP.`,
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: Customer gateway redundancy (detectable) ---
export function ruleCgwRedundancy(topology: TopologyData): RuleResult {
  if (topology.vpnConnections.length === 0) {
    return { annotations: [], recommendation: null };
  }

  const cgwIds = new Set(
    topology.vpnConnections
      .map((v) => v.customerGatewayId)
      .filter((id): id is string => !!id),
  );

  if (cgwIds.size >= 2) return { annotations: [], recommendation: null };

  return {
    annotations: [],
    recommendation: {
      id: 'bp-cgw-redundancy',
      ruleId: 'cgw-redundancy',
      category: 'bestpractice',
      severity: 'warning',
      title: 'Deploy multiple customer gateways for device redundancy',
      description: 'All Site-to-Site VPN connections terminate on the same customer gateway. A single customer gateway (or DX partner device) is a single point of failure — deploy at least two CGWs so device failures do not take down the hybrid network.',
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: DX partner diversity (detectable) ---
export function ruleDxPartnerDiversity(topology: TopologyData): RuleResult {
  if (topology.connections.length < 2) {
    return { annotations: [], recommendation: null };
  }

  const partners = new Set(
    topology.connections
      .map((c) => c.partnerName)
      .filter((p): p is string => !!p && p.trim().length > 0),
  );

  // If there are no named partners, we can't tell — stay silent.
  if (partners.size === 0) return { annotations: [], recommendation: null };
  if (partners.size >= 2) return { annotations: [], recommendation: null };

  const partnerName = [...partners][0];

  // DescribeLocations tells us which providers actually serve the customer's
  // facilities, so name the real alternatives instead of advising "use another
  // partner" in the abstract. Only consider locations the customer occupies,
  // and drop the incumbent from the list.
  const occupiedCodes = new Set(
    topology.connections.map((c) => c.location).filter((l): l is string => !!l),
  );
  const incumbent = partnerName.trim().toLowerCase();
  const alternatives = [
    ...new Set(
      topology.locations
        .filter((l) => occupiedCodes.has(l.locationCode))
        .flatMap((l) => l.availableProviders ?? [])
        .filter((p) => p.trim().length > 0 && p.trim().toLowerCase() !== incumbent),
    ),
  ].sort();

  // Cap the list: some facilities carry dozens of providers and the point is to
  // show the option exists, not to dump a directory.
  const MAX_NAMED = 6;
  const named = alternatives.slice(0, MAX_NAMED);
  const alternativesText =
    named.length > 0
      ? ` Other providers available at your current location${occupiedCodes.size > 1 ? 's' : ''} include: ${named.join(', ')}${alternatives.length > named.length ? `, and ${alternatives.length - named.length} more` : ''}.`
      : '';

  return {
    annotations: [],
    recommendation: {
      id: 'bp-dx-partner-diversity',
      ruleId: 'dx-partner-diversity',
      category: 'bestpractice',
      severity: 'info',
      title: 'Consider sourcing Direct Connect from multiple partners',
      description: `All Direct Connect connections are sourced from the same partner/last-mile provider (${partnerName}). If budget allows, procuring Direct Connect from multiple partners minimizes single-point-of-failure risk on the partner side (partner network outages, partner maintenance events).${alternativesText}`,
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: VPN DPD configuration ---
// AWS-side DPD config (DpdTimeoutAction, DpdTimeoutSeconds) is available from
// DescribeVpnConnections → Options.TunnelOptions. Customer-gateway-side DPD
// config is never exposed, so we still surface an info-level attestation when
// the AWS side is fine.
export function ruleVpnDpd(topology: TopologyData): RuleResult {
  if (topology.vpnConnections.length === 0) {
    return { annotations: [], recommendation: null };
  }

  const noActionTunnels: string[] = [];
  for (const vpn of topology.vpnConnections) {
    for (const t of vpn.tunnels) {
      if (t.dpdTimeoutAction === 'none') {
        const label = t.outsideIpAddress || 'tunnel';
        noActionTunnels.push(`${vpn.vpnConnectionId} (${label})`);
      }
    }
  }

  if (noActionTunnels.length > 0) {
    return {
      annotations: [],
      recommendation: {
        id: 'bp-vpn-dpd',
        ruleId: 'vpn-dpd',
        category: 'bestpractice',
        severity: 'warning',
        title: 'Enable DPD timeout action on VPN tunnels',
        description: `The following VPN tunnel(s) are configured with DpdTimeoutAction=none, so AWS takes no action when the customer gateway stops responding to DPD probes: ${noActionTunnels.join(', ')}. Switch the tunnel option to "clear" or "restart" (via ModifyVpnTunnelOptions) so failover is not delayed after a peer failure. Also verify DPD is configured on the customer gateway side — that half is not visible via the AWS API.`,
        additionalNodes: [],
        additionalEdges: [],
      },
    };
  }

  return {
    annotations: [],
    recommendation: {
      id: 'bp-vpn-dpd',
      ruleId: 'vpn-dpd',
      category: 'bestpractice',
      severity: 'info',
      title: 'Verify VPN Dead Peer Detection (DPD) on the customer gateway',
      description: 'AWS-side DPD is configured on every tunnel (DpdTimeoutAction is set to clear or restart). Verify DPD is also configured on the customer gateway so failed tunnels are detected quickly from both sides — customer-gateway DPD config is not exposed via the AWS API.',
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: DX location redundancy — Metro vs Geographic (guidance-only) ---
export function ruleDxLocationRedundancy(topology: TopologyData): RuleResult {
  if (topology.connections.length === 0 && topology.virtualInterfaces.length === 0) {
    return { annotations: [], recommendation: null };
  }

  return {
    annotations: [],
    recommendation: {
      id: 'bp-dx-location-redundancy',
      ruleId: 'dx-location-redundancy',
      category: 'bestpractice',
      severity: 'info',
      title: 'Choose DX location redundancy that matches your risk profile',
      description: 'Metro diversity (DX locations in the same metro) gives fast, low-latency failover and protects against single-facility failures (power, cooling, fiber cut to one building) at lower cross-connect cost. Geographic diversity (DX locations in separate regions) protects against large-scale regional events (natural disasters, metro-wide fiber cuts, grid outages) at the cost of higher latency on the backup path and higher circuit costs. Metro diversity is often sufficient for high availability; choose geographic diversity when business continuity requires resilience against catastrophic regional events.',
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: BGP timer fallback when BFD unavailable (guidance-only) ---
export function ruleBgpTimersFallback(topology: TopologyData): RuleResult {
  if (topology.virtualInterfaces.length === 0) {
    return { annotations: [], recommendation: null };
  }

  return {
    annotations: [],
    recommendation: {
      id: 'bp-bgp-timers-fallback',
      ruleId: 'bgp-timers-fallback',
      category: 'bestpractice',
      severity: 'info',
      title: 'Optimize BGP timers when BFD is not supported',
      description: 'If the customer gateway or partner device does not support BFD, tune the BGP hold timer down to roughly 20–30 seconds to reduce failure detection time while still keeping the session stable. The AWS default hold timer is 90 seconds, which delays failover significantly.',
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: Regular DX failover testing (guidance-only) ---
// The generic guidance, used whenever we have no test history to reason about
// (never fetched, permission denied, mock, or older snapshot). Identical to the
// rule's original behaviour, so nothing regresses when the data is absent.
const FAILOVER_TESTING_GUIDANCE =
  'Exercise your redundant paths on a schedule. AWS allows you to temporarily shut down BGP peers on your VIFs from the AWS side for up to 72 hours, which lets you simulate router maintenance and validate failover before it happens for real. Note: partner-provided / hosted VIFs may be under partner monitoring — coordinate with your DX partner before running failover tests.';

/** Tests older than this are treated as stale evidence. */
const FAILOVER_TEST_STALE_DAYS = 365;

function daysSince(iso: string): number | undefined {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  const ms = Date.now() - then;
  return ms < 0 ? undefined : Math.floor(ms / 86_400_000);
}

export function ruleDxFailoverTesting(topology: TopologyData): RuleResult {
  if (topology.connections.length === 0 && topology.virtualInterfaces.length === 0) {
    return { annotations: [], recommendation: null };
  }

  const history = topology.vifFailoverTests;

  // No data → the original unconditional guidance. Never imply a customer has
  // not tested just because we could not look.
  if (!history || history.size === 0) {
    return {
      annotations: [],
      recommendation: {
        id: 'bp-dx-failover-testing',
        ruleId: 'dx-failover-testing',
        category: 'bestpractice',
        severity: 'info',
        title: 'Conduct regular Direct Connect failover tests',
        description: FAILOVER_TESTING_GUIDANCE,
        additionalNodes: [],
        additionalEdges: [],
      },
    };
  }

  const failed: string[] = [];
  const untested: string[] = [];
  const stale: string[] = [];
  const recent: Array<{ label: string; days: number }> = [];
  let running = 0;

  for (const vif of topology.virtualInterfaces) {
    const tests = history.get(vif.virtualInterfaceId);
    if (!tests) continue; // not queried — stays out of every bucket
    const label = vif.virtualInterfaceName || vif.virtualInterfaceId;

    if (tests.length === 0) {
      untested.push(label);
      continue;
    }

    if (tests.some((t) => /running|in.?progress/i.test(t.status))) running++;

    // A failed test is the strongest possible signal: failover was attempted and
    // did not work.
    if (tests.some((t) => /fail/i.test(t.status))) {
      failed.push(label);
      continue;
    }

    // Newest end/start time across this VIF's tests.
    const newest = tests
      .map((t) => t.endTime ?? t.startTime)
      .filter((d): d is string => !!d)
      .sort()
      .at(-1);
    const age = newest ? daysSince(newest) : undefined;
    if (age === undefined) {
      // Tests on record but no usable timestamp — treat as evidence without a date.
      recent.push({ label, days: 0 });
    } else if (age > FAILOVER_TEST_STALE_DAYS) {
      stale.push(`${label} (last tested ${newest!.slice(0, 10)}, ${age} days ago)`);
    } else {
      recent.push({ label, days: age });
    }
  }

  if (failed.length > 0) {
    return {
      annotations: [],
      recommendation: {
        id: 'bp-dx-failover-testing',
        ruleId: 'dx-failover-testing',
        category: 'bestpractice',
        severity: 'critical',
        title: 'A Direct Connect failover test did not complete successfully',
        description: `AWS recorded a failed BGP failover test on: ${failed.join(', ')}. A failed test means the redundancy on this path did not behave as expected when it was exercised — treat this as an open finding, not a historical note. Review the test result in the Direct Connect console, confirm the backup path actually carried traffic, then re-run the test once the cause is fixed. ${FAILOVER_TESTING_GUIDANCE}`,
        additionalNodes: [],
        additionalEdges: [],
      },
    };
  }

  if (untested.length > 0 || stale.length > 0) {
    const parts: string[] = [];
    if (untested.length > 0) {
      parts.push(`no failover test is on record for ${untested.join(', ')}`);
    }
    if (stale.length > 0) {
      parts.push(
        `the most recent test is over a year old on ${stale.join(', ')}`,
      );
    }
    return {
      annotations: [],
      recommendation: {
        id: 'bp-dx-failover-testing',
        ruleId: 'dx-failover-testing',
        category: 'bestpractice',
        severity: 'warning',
        title: 'Direct Connect failover has not been recently validated',
        description: `Your topology may be redundant on paper, but ${parts.join('; and ')}. Note what "no test on record" means: AWS only records failover tests started through its own API — StartBgpFailoverTest, or the "Bring BGP down" action in the Direct Connect console. A test you ran by shutting the BGP session on your own router is invisible here, so this is evidence of no AWS-recorded test rather than proof you have never tested. ${FAILOVER_TESTING_GUIDANCE}`,
        additionalNodes: [],
        additionalEdges: [],
      },
    };
  }

  if (recent.length > 0) {
    const newest = recent.reduce((m, r) => Math.min(m, r.days), Number.MAX_SAFE_INTEGER);
    return {
      annotations: [],
      recommendation: {
        id: 'bp-dx-failover-testing',
        ruleId: 'dx-failover-testing-ok',
        category: 'bestpractice',
        severity: 'info',
        title: 'Direct Connect failover has been tested',
        description: `${recent.length === 1 ? 'This virtual interface has' : `All ${recent.length} checked virtual interfaces have`} a recorded BGP failover test within the last year${newest > 0 ? ` (most recent: ${newest} day${newest === 1 ? '' : 's'} ago)` : ''}${running > 0 ? `, and ${running} test${running === 1 ? ' is' : 's are'} currently running` : ''}. Keep exercising the paths on a schedule — a design validated once drifts as the network changes.`,
        additionalNodes: [],
        additionalEdges: [],
      },
    };
  }

  // History present but nothing matched a VIF in this topology.
  return {
    annotations: [],
    recommendation: {
      id: 'bp-dx-failover-testing',
      ruleId: 'dx-failover-testing',
      category: 'bestpractice',
      severity: 'info',
      title: 'Conduct regular Direct Connect failover tests',
      description: FAILOVER_TESTING_GUIDANCE,
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: Documented failover runbooks (guidance-only) ---
export function ruleFailoverRunbooks(topology: TopologyData): RuleResult {
  if (topology.connections.length === 0 && topology.virtualInterfaces.length === 0) {
    return { annotations: [], recommendation: null };
  }

  return {
    annotations: [],
    recommendation: {
      id: 'bp-failover-runbooks',
      ruleId: 'failover-runbooks',
      category: 'bestpractice',
      severity: 'info',
      title: 'Maintain documented DX/VPN failover runbooks',
      description: 'Create and maintain operational runbooks for Direct Connect and VPN failover procedures, including escalation paths, on-call rotations, and partner coordination steps. During an incident, a well-tested runbook is what turns failover from a multi-hour scramble into a repeatable procedure.',
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Rule: VIF rate limits over-subscribe the parent connection ---
// A VIF rate limit caps that VIF's bandwidth, and AWS enforces that no single
// limit exceeds the port. It does NOT stop the SUM of limits on one port from
// exceeding it: three 4Gbps VIFs on a 10Gbps port is 120% committed. That's a
// legitimate design (statistical multiplexing — the VIFs are unlikely to peak
// together), but it means the rate limits no longer guarantee isolation, so a
// noisy VIF can starve its neighbours. Silent when no VIF carries a rate limit.
export function ruleVifRateLimitOversubscription(topology: TopologyData): RuleResult {
  const rateLimited = topology.virtualInterfaces.filter((v) => !!v.rateLimit);
  if (rateLimited.length === 0) return { annotations: [], recommendation: null };

  const offenders: string[] = [];
  for (const conn of topology.connections) {
    const portBps = parseBandwidthToBps(conn.bandwidth);
    if (!portBps) continue;
    const vifs = rateLimited.filter((v) => v.connectionId === conn.connectionId);
    if (vifs.length < 2) continue;
    // Only compare when every VIF on the port is capped. An uncapped VIF can
    // already use the whole port, so "committed vs port" is not the right frame.
    const allOnConn = topology.virtualInterfaces.filter((v) => v.connectionId === conn.connectionId);
    if (allOnConn.length !== vifs.length) continue;

    const committedBps = vifs.reduce((sum, v) => sum + (parseBandwidthToBps(v.rateLimit) ?? 0), 0);
    if (committedBps > portBps) {
      const pct = Math.round((committedBps / portBps) * 100);
      offenders.push(
        `${conn.connectionName || conn.connectionId} (${conn.bandwidth} port, ${vifs.length} VIFs committing ${formatBps(committedBps)} — ${pct}%)`,
      );
    }
  }

  if (offenders.length === 0) return { annotations: [], recommendation: null };

  return {
    annotations: [],
    recommendation: {
      id: 'bp-vif-rate-limit-oversubscription',
      ruleId: 'vif-rate-limit-oversubscription',
      category: 'bestpractice',
      severity: 'info',
      title: 'VIF rate limits exceed the parent connection bandwidth',
      description: `The sum of per-VIF rate limits is greater than the underlying port on: ${offenders.join('; ')}. AWS enforces that no single rate limit exceeds the connection, but not that they sum to it — so the port is over-subscribed and the limits no longer guarantee each VIF its share. This is a valid design if you are relying on the VIFs not peaking simultaneously; if the intent was hard isolation, reduce the limits so they total at or below the port bandwidth, or move a VIF to another connection.`,
      additionalNodes: [],
      additionalEdges: [],
    },
  };
}

// --- Aggregate all best practice rules ---
export function getAllBestPracticeResults(topology: TopologyData): {
  annotations: NodeAnnotation[];
  recommendations: Recommendation[];
} {
  const allAnnotations: NodeAnnotation[] = [];
  const allRecommendations: Recommendation[] = [];

  const rules = [
    ruleBfdGuidance(topology),
    ruleVifDown(topology),
    ruleConnectionNotAvailable(topology),
    ruleNoVpnBackup(topology),
    ruleSlaAwareness(topology),
    ruleResiliencyToolkit(topology),
    ruleConsistentPrefixAdvertisement(topology),
    ruleVifRouteSymmetry(topology),
    ruleVifRateLimitOversubscription(topology),
    ruleLagMinLinks(topology),
    ruleBgpRouteLimit(topology),
    ruleBgpSessionStability(topology),
    ruleDxgwPropagationEnabled(topology),
    ruleBlackholeRoutes(topology),
    ruleVpcNoHybridRoute(topology),
    ruleVpnTunnelRedundancy(topology),
    ruleVpnStaticRoutesOnly(topology),
    ruleCgwRedundancy(topology),
    ruleDxPartnerDiversity(topology),
    ruleVpnDpd(topology),
    ruleDxLocationRedundancy(topology),
    ruleBgpTimersFallback(topology),
    ruleDxFailoverTesting(topology),
    ruleFailoverRunbooks(topology),
  ];

  for (const result of rules) {
    allAnnotations.push(...result.annotations);
    if (result.recommendation) allRecommendations.push(result.recommendation);
  }

  const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  allRecommendations.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

  return { annotations: allAnnotations, recommendations: allRecommendations };
}
