import type { TopologyData } from '../types/topology';
import type { Recommendation, NodeAnnotation, ResiliencyLevel } from '../types/recommendations';

type RuleResult = { annotations: NodeAnnotation[]; recommendation: Recommendation | null };

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

// --- Rule: Cross-region network path (DX region differs from resource region) ---
export function ruleCrossRegionPath(topology: TopologyData): RuleResult {
  const dxRegions = new Set<string>();
  for (const conn of topology.connections) {
    if (conn.region) dxRegions.add(conn.region);
  }
  if (dxRegions.size === 0) return { annotations: [], recommendation: null };

  const resourceRegions = new Set<string>();
  for (const vpc of topology.vpcs) {
    if (vpc.region) resourceRegions.add(vpc.region);
  }
  for (const tgw of topology.transitGateways) {
    const region = tgw.transitGatewayArn?.split(':')[3];
    if (region) resourceRegions.add(region);
  }
  if (resourceRegions.size === 0) return { annotations: [], recommendation: null };

  const uncoveredRegions = [...resourceRegions].filter((r) => !dxRegions.has(r));
  if (uncoveredRegions.length === 0) return { annotations: [], recommendation: null };

  return {
    annotations: [],
    recommendation: {
      id: 'bp-cross-region-path',
      ruleId: 'cross-region-path',
      category: 'bestpractice',
      severity: 'info',
      title: 'Cross-Region Network Path Detected',
      description: `Your Direct Connect connections terminate in ${[...dxRegions].join(', ')} but resources exist in ${uncoveredRegions.join(', ')}. The DX SLA covers the connection segment between your on-premises network and the AWS DX location. Traffic routed cross-region over the AWS backbone has separate availability characteristics and is not covered by the Direct Connect SLA. Consider provisioning Direct Connect connections in each resource region for end-to-end SLA coverage.`,
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

  return {
    annotations: [],
    recommendation: {
      id: 'bp-consistent-prefix-advertisement',
      ruleId: 'consistent-prefix-advertisement',
      category: 'bestpractice',
      severity: 'info',
      title: 'Advertise the same prefixes across redundant VIFs',
      description: 'Validate that the same BGP prefixes are learned and advertised across redundant Virtual Interfaces. Asymmetric advertisement leaves the failover path with different reachability and can cause traffic blackholes during a failover. BGP route state is not available via the AWS API — verify from your customer router.',
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

  return {
    annotations: [],
    recommendation: {
      id: 'bp-vif-route-symmetry',
      ruleId: 'vif-route-symmetry',
      category: 'bestpractice',
      severity: 'info',
      title: 'Summarize prefixes and keep VIF routing symmetric',
      description: 'Route summarization — advertising individual /24s will exhaust the 100-prefix limit rapidly. Consolidate into aggregate prefixes. All VIFs attached to the same DXGW or VGW serving the same routing domain should advertise and receive identical prefix sets with consistent BGP attributes (local preference, AS_PATH length, etc.) unless traffic manipulation is required. BGP route state is not available via the AWS API — verify from your customer router.',
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

// --- Rule: BGP route limit (detected via CloudWatch VirtualInterfaceBgpPrefixesAccepted) ---
// AWS accepts at most 100 prefixes per BGP session on private and transit VIFs.
// CloudWatch publishes VirtualInterfaceBgpPrefixesAccepted per VIF (IPv4 + IPv6
// summed upstream), so the actual on-prem → AWS count is known. We warn above
// the hard limit, caution near it, and confirm "met" when data is healthy.
// Public VIFs have a higher published limit (1000) and are excluded from this check.
const BGP_ROUTE_HARD_LIMIT = 100;
const BGP_ROUTE_CAUTION_THRESHOLD = 80;

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
    const accepted = topology.bgpPrefixMetrics?.get(vif.virtualInterfaceId)?.accepted;
    const label = `${vif.virtualInterfaceName || vif.virtualInterfaceId}`;
    if (accepted === undefined) {
      unknown.push(label);
    } else if (accepted >= BGP_ROUTE_HARD_LIMIT) {
      over.push(`${label} (${accepted} accepted)`);
    } else if (accepted >= BGP_ROUTE_CAUTION_THRESHOLD) {
      near.push(`${label} (${accepted} accepted)`);
    } else {
      healthy.push({ id: label, count: accepted });
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
        description: `The following VIFs are at or above the 100-prefix limit for on-premises → AWS advertisement: ${over.join(', ')}. Exceeding the limit causes BGP session teardown and network disconnection. Summarize or filter on-premises routes immediately. See https://docs.aws.amazon.com/directconnect/latest/UserGuide/limits.html`,
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
        description: `The following VIFs are within 20 prefixes of the 100-prefix hard limit: ${near.join(', ')}. Plan summarization now so on-premises growth does not trigger a BGP session teardown. See https://docs.aws.amazon.com/directconnect/latest/UserGuide/limits.html`,
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
        description: `All ${healthy.length} private/transit VIF${healthy.length > 1 ? 's are well under' : ' is well under'} the 100-prefix hard limit — peak observed is ${max} prefix${max === 1 ? '' : 'es'} accepted from on-premises.`,
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
      description: `Private and transit Virtual Interfaces accept at most 100 routes per BGP session from on-premises to AWS. CloudWatch prefix metrics were not available for ${unknown.length === 1 ? 'this VIF' : `these ${unknown.length} VIFs`} (${unknown.join(', ')}) — verify the count directly on your customer router and summarize routes if needed. See https://docs.aws.amazon.com/directconnect/latest/UserGuide/limits.html`,
      additionalNodes: [],
      additionalEdges: [],
    },
  };
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
      degraded.push(`${vpn.vpnConnectionId} (${upTunnels}/2 tunnels UP)`);
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
  return {
    annotations: [],
    recommendation: {
      id: 'bp-dx-partner-diversity',
      ruleId: 'dx-partner-diversity',
      category: 'bestpractice',
      severity: 'info',
      title: 'Consider sourcing Direct Connect from multiple partners',
      description: `All Direct Connect connections are sourced from the same partner/last-mile provider (${partnerName}). If budget allows, procuring Direct Connect from multiple partners minimizes single-point-of-failure risk on the partner side (partner network outages, partner maintenance events).`,
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
export function ruleDxFailoverTesting(topology: TopologyData): RuleResult {
  if (topology.connections.length === 0 && topology.virtualInterfaces.length === 0) {
    return { annotations: [], recommendation: null };
  }

  return {
    annotations: [],
    recommendation: {
      id: 'bp-dx-failover-testing',
      ruleId: 'dx-failover-testing',
      category: 'bestpractice',
      severity: 'info',
      title: 'Conduct regular Direct Connect failover tests',
      description: 'Exercise your redundant paths on a schedule. AWS allows you to temporarily shut down BGP peers on your VIFs from the AWS side for up to 72 hours, which lets you simulate router maintenance and validate failover before it happens for real. Note: partner-provided / hosted VIFs may be under partner monitoring — coordinate with your DX partner before running failover tests.',
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
    ruleCrossRegionPath(topology),
    ruleSlaAwareness(topology),
    ruleResiliencyToolkit(topology),
    ruleConsistentPrefixAdvertisement(topology),
    ruleVifRouteSymmetry(topology),
    ruleLagMinLinks(topology),
    ruleBgpRouteLimit(topology),
    ruleVpnTunnelRedundancy(topology),
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
