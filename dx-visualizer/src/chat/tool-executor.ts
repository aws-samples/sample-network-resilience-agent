import { useTopologyStore } from '../store/topology-store';
import { lookupDxPricing, lookupNetworkServicePricing } from './dx-pricing';
import { fetchDxCosts, fetchDxDailyCosts } from '../api/cost-explorer';
import { RESILIENCY_TIERS, type MockScenario } from '../utils/shared';
import { getLocationDeviceCounts } from '../engine/sla-gating';
import { compareDxGateways } from '../engine/dxgw-compare';
import type { TopologyData } from '../types/topology';

export interface ToolResult {
  content: Array<{ text: string }>;
  status: 'success' | 'error';
}

export async function executeTool(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'get_dx_pricing':
        return await handleGetDxPricing(input);
      case 'get_network_service_pricing':
        return await handleGetNetworkServicePricing(input);
      case 'get_topology_summary':
        return handleGetTopologySummary();
      case 'compare_dx_gateways':
        return handleCompareDxGateways(input);
      case 'estimate_upgrade_cost':
        return await handleEstimateUpgradeCost(input);
      case 'get_actual_costs':
        return await handleGetActualCosts(input);
      case 'get_daily_dx_costs':
        return await handleGetDailyDxCosts(input);
      case 'switch_view':
        return handleSwitchView(input);
      case 'toggle_simulation':
        return handleToggleSimulation(input);
      case 'toggle_live_status':
        return handleToggleLiveStatus(input);
      case 'change_scenario':
        return handleChangeScenario(input);
      default:
        return { content: [{ text: `Unknown tool: ${toolName}` }], status: 'error' };
    }
  } catch (err) {
    return {
      content: [{ text: `Tool error: ${err instanceof Error ? err.message : String(err)}` }],
      status: 'error',
    };
  }
}

async function handleGetDxPricing(input: Record<string, unknown>): Promise<ToolResult> {
  const creds = useTopologyStore.getState().credentials;
  if (!creds) {
    return { content: [{ text: 'No AWS credentials available. Connect to AWS to fetch live pricing.' }], status: 'error' };
  }
  const result = await lookupDxPricing(
    creds,
    input.region as string,
    input.port_speed as string,
    (input.num_connections as number) ?? 1
  );
  return { content: [{ text: JSON.stringify(result, null, 2) }], status: 'success' };
}

async function handleGetNetworkServicePricing(input: Record<string, unknown>): Promise<ToolResult> {
  const creds = useTopologyStore.getState().credentials;
  if (!creds) {
    return { content: [{ text: 'No AWS credentials available. Connect to AWS to fetch live pricing.' }], status: 'error' };
  }
  const result = await lookupNetworkServicePricing(
    creds,
    input.service as 'tgw' | 'vpn' | 'vgw',
    input.region as string,
    (input.num_attachments as number) ?? 1
  );
  return { content: [{ text: JSON.stringify(result, null, 2) }], status: 'success' };
}

function handleGetTopologySummary(): ToolResult {
  const store = useTopologyStore.getState();
  const topology = store.topologyData;
  const assessment = store.assessment;

  if (!topology) {
    return { content: [{ text: 'No topology data loaded.' }], status: 'error' };
  }

  const locations = new Map<string, number>();
  for (const conn of topology.connections) {
    locations.set(conn.location, (locations.get(conn.location) ?? 0) + 1);
  }
  // Also surface the logical-device count per location — the LLM needs this
  // to reason correctly about Max SLA eligibility, since two connections
  // sharing one AWS logical device don't provide device redundancy.
  const devicesByLocation = getLocationDeviceCounts(topology);

  const vifsByType = new Map<string, number>();
  for (const vif of topology.virtualInterfaces) {
    const t = vif.virtualInterfaceType ?? 'unknown';
    vifsByType.set(t, (vifsByType.get(t) ?? 0) + 1);
  }

  const summary: Record<string, unknown> = {
    connections: {
      total: topology.connections.length,
      byLocation: Object.fromEntries(locations),
      uniqueLogicalDevicesByLocation: Object.fromEntries(devicesByLocation),
      details: topology.connections.map((c) => ({
        name: c.connectionName,
        id: c.connectionId,
        bandwidth: c.bandwidth,
        location: c.location,
        state: c.connectionState,
      })),
    },
    virtualInterfaces: {
      total: topology.virtualInterfaces.length,
      byType: Object.fromEntries(vifsByType),
    },
    dxGateways: topology.dxGateways.length,
    transitGateways: topology.transitGateways.length,
    vpnGateways: topology.vpnGateways.length,
    vpcs: topology.vpcs.length,
    lags: topology.lags.length,
  };

  if (assessment) {
    summary.resiliency = {
      currentLevel: assessment.resiliency.currentLevel,
      dxNotInUse: assessment.dxNotInUse,
      targetLevel: assessment.resiliency.targetLevel,
      recommendationCount: assessment.resiliency.recommendations.length,
      recommendations: assessment.resiliency.recommendations.map((r) => ({
        severity: r.severity,
        title: r.title,
        description: r.description,
      })),
    };
    summary.bestPractice = {
      recommendationCount: assessment.bestPractice.recommendations.length,
      recommendations: assessment.bestPractice.recommendations.map((r) => ({
        severity: r.severity,
        title: r.title,
        description: r.description,
      })),
    };
  }

  return { content: [{ text: JSON.stringify(summary, null, 2) }], status: 'success' };
}

/**
 * Resolve what the user typed to a DX Gateway id. They will say "compare primary
 * against secondary", meaning names, so an id-only lookup would fail on almost
 * every real question. Order is most-specific first, and an ambiguous or unknown
 * term returns the full gateway list rather than a bare failure, so the model can
 * retry in the same turn instead of asking the user to go find an id.
 */
function resolveDxGatewayId(topology: TopologyData, term: string): { id: string } | { error: string } {
  const gateways = topology.dxGateways;
  const list = () =>
    gateways
      .map((g) => `${g.directConnectGatewayName || '(unnamed)'} (${g.directConnectGatewayId})`)
      .join('; ') || 'none';

  const needle = term.trim().toLowerCase();
  if (!needle) return { error: `No DX Gateway specified. Available gateways: ${list()}` };

  const byId = gateways.find((g) => g.directConnectGatewayId.toLowerCase() === needle);
  if (byId) return { id: byId.directConnectGatewayId };

  const byName = gateways.filter((g) => (g.directConnectGatewayName ?? '').toLowerCase() === needle);
  if (byName.length === 1) return { id: byName[0].directConnectGatewayId };
  if (byName.length > 1) {
    return {
      error: `"${term}" matches ${byName.length} DX Gateways by name (${byName.map((g) => g.directConnectGatewayId).join(', ')}). Ask the user which one, or pass the gateway ID.`,
    };
  }

  const partial = gateways.filter(
    (g) =>
      (g.directConnectGatewayName ?? '').toLowerCase().includes(needle)
      || g.directConnectGatewayId.toLowerCase().includes(needle),
  );
  if (partial.length === 1) return { id: partial[0].directConnectGatewayId };
  if (partial.length > 1) {
    return {
      error: `"${term}" is ambiguous — it matches: ${partial.map((g) => `${g.directConnectGatewayName || '(unnamed)'} (${g.directConnectGatewayId})`).join('; ')}. Ask the user which one, or pass the gateway ID.`,
    };
  }
  return { error: `No DX Gateway matches "${term}". Available gateways: ${list()}` };
}

function handleCompareDxGateways(input: Record<string, unknown>): ToolResult {
  const topology = useTopologyStore.getState().topologyData;
  if (!topology) {
    return { content: [{ text: 'No topology data loaded.' }], status: 'error' };
  }
  if (topology.dxGateways.length < 2) {
    return {
      content: [{
        text: `This topology has ${topology.dxGateways.length} DX Gateway(s), so there is no pair to compare. Say so plainly — do not compare VIFs across unrelated gateways as a substitute.`,
      }],
      status: 'error',
    };
  }

  const a = resolveDxGatewayId(topology, String(input.gateway_a ?? ''));
  const b = resolveDxGatewayId(topology, String(input.gateway_b ?? ''));
  if ('error' in a) return { content: [{ text: a.error }], status: 'error' };
  if ('error' in b) return { content: [{ text: b.error }], status: 'error' };
  if (a.id === b.id) {
    return {
      content: [{ text: `Both terms resolved to the same DX Gateway (${a.id}). Ask the user which two distinct gateways they mean.` }],
      status: 'error',
    };
  }

  const result = compareDxGateways(topology, a.id, b.id);
  if (!result) {
    return { content: [{ text: `Could not compare ${a.id} and ${b.id} — one of them is not in the loaded topology.` }], status: 'error' };
  }

  // The verdict decides how the numbers may be described, so it travels with
  // them: `independent` gateways differ by design, and calling that a gap would
  // send someone to "fix" a working router.
  const guidance = result.relationship.verdict === 'same-routing-domain'
    ? 'These gateways serve the same downstream. Prefixes present on only one of them have no failover path through the other — report those as gaps.'
    : result.relationship.verdict === 'independent'
      ? 'These gateways serve SEPARATE routing domains. Differing prefixes are expected and MUST NOT be reported as a redundancy gap. Present this as a configuration difference only, and say why it is not a gap.'
      : 'Whether these gateways share a downstream could not be determined. Do NOT call any difference a gap. Report the differences and state that the relationship is unconfirmed because some associations are hidden from this account.';

  return {
    content: [{ text: JSON.stringify({ ...result, howToReport: guidance }, null, 2) }],
    status: 'success',
  };
}

async function handleEstimateUpgradeCost(input: Record<string, unknown>): Promise<ToolResult> {
  const store = useTopologyStore.getState();
  const topology = store.topologyData;
  const assessment = store.assessment;

  if (!topology || !assessment) {
    return { content: [{ text: 'No topology or assessment data available.' }], status: 'error' };
  }

  const currentLevel = assessment.resiliency.currentLevel;
  const targetLevel = input.target_level as string;

  const currentIdx = RESILIENCY_TIERS.indexOf(currentLevel as typeof RESILIENCY_TIERS[number]);
  const targetIdx = RESILIENCY_TIERS.indexOf(targetLevel as typeof RESILIENCY_TIERS[number]);

  if (targetIdx <= currentIdx) {
    return {
      content: [{ text: JSON.stringify({ message: `Already at or above ${targetLevel} level (current: ${currentLevel}).` }) }],
      status: 'success',
    };
  }

  // Count unique AWS logical devices per location — same gating the tier
  // engine uses. Two connections sharing one logical device count as one
  // (no device redundancy), so the cost estimator should advise adding a
  // *new* connection on a separate device rather than undercounting here.
  const locations = getLocationDeviceCounts(topology);
  const locationCount = locations.size;
  const totalConnections = topology.connections.length;

  let additionalLocations = 0;
  let additionalConnectionsPerLocation = 0;
  const breakdown: string[] = [];

  if (targetLevel === 'devtest') {
    if (totalConnections < 2) {
      additionalConnectionsPerLocation = 2 - totalConnections;
      breakdown.push(`Need ${additionalConnectionsPerLocation} more connection(s) at existing location`);
    }
  } else if (targetLevel === 'high') {
    if (locationCount < 2) {
      additionalLocations = 2 - locationCount;
      breakdown.push(`Need ${additionalLocations} additional DX location(s)`);
    }
    if (additionalLocations > 0) {
      breakdown.push(`Need 1 connection at each new location`);
    }
  } else if (targetLevel === 'maximum') {
    if (locationCount < 2) {
      additionalLocations = 2 - locationCount;
      breakdown.push(`Need ${additionalLocations} additional DX location(s)`);
    }
    let additionalConns = 0;
    for (const [loc, deviceCount] of locations) {
      if (deviceCount < 2) {
        const needed = 2 - deviceCount;
        additionalConns += needed;
        breakdown.push(`Need ${needed} more connection(s) on a separate AWS logical device at ${loc}`);
      }
    }
    if (additionalLocations > 0) {
      additionalConns += additionalLocations * 2;
      breakdown.push(`Need 2 connections on separate AWS logical devices at each new location`);
    }
    additionalConnectionsPerLocation = additionalConns;
  }

  // Estimate cost using live pricing if credentials available
  const refBandwidth = topology.connections[0]?.bandwidth ?? '1Gbps';
  const refRegion = topology.vpcs[0]?.region ?? 'us-east-1';
  const totalNewConnections = targetLevel === 'maximum'
    ? additionalConnectionsPerLocation
    : (additionalLocations > 0 ? additionalLocations : additionalConnectionsPerLocation);

  let estimatedMonthlyCost = 0;
  let pricingNote: string;
  const creds = store.credentials;
  if (creds) {
    const pricing = await lookupDxPricing(creds, refRegion, refBandwidth, Math.max(totalNewConnections, 1));
    estimatedMonthlyCost = pricing.totalMonthlyPortCost;
    pricingNote = pricing.notes;
  } else {
    pricingNote = 'No AWS credentials — connect to AWS for live pricing estimates.';
  }

  const estimate = {
    currentLevel,
    targetLevel,
    currentLocations: locationCount,
    currentConnections: totalConnections,
    additionalLocationsNeeded: additionalLocations,
    additionalConnectionsNeeded: totalNewConnections,
    referencePortSpeed: refBandwidth,
    referenceRegion: refRegion,
    estimatedAdditionalMonthlyCost: estimatedMonthlyCost,
    breakdown,
    notes: pricingNote + ' Estimate based on port fees only. Data transfer, cross-connect fees, and partner charges are additional.',
  };

  return { content: [{ text: JSON.stringify(estimate, null, 2) }], status: 'success' };
}

async function handleGetActualCosts(input: Record<string, unknown>): Promise<ToolResult> {
  const creds = useTopologyStore.getState().credentials;
  if (!creds) {
    return { content: [{ text: 'No AWS credentials available. Connect to AWS to fetch cost data.' }], status: 'error' };
  }
  const result = await fetchDxCosts(
    creds,
    input.start_date as string | undefined,
    input.end_date as string | undefined,
  );
  return { content: [{ text: JSON.stringify(result, null, 2) }], status: 'success' };
}

async function handleGetDailyDxCosts(input: Record<string, unknown>): Promise<ToolResult> {
  const creds = useTopologyStore.getState().credentials;
  if (!creds) {
    return { content: [{ text: 'No AWS credentials available. Connect to AWS to fetch cost data.' }], status: 'error' };
  }
  const result = await fetchDxDailyCosts(
    creds,
    input.start_date as string | undefined,
    input.end_date as string | undefined,
  );
  return { content: [{ text: JSON.stringify(result, null, 2) }], status: 'success' };
}

function handleSwitchView(input: Record<string, unknown>): ToolResult {
  const view = input.view as 'current' | 'recommended';
  useTopologyStore.getState().setViewMode(view);
  return { content: [{ text: `Switched to ${view} view.` }], status: 'success' };
}

function handleToggleSimulation(input: Record<string, unknown>): ToolResult {
  const enabled = input.enabled as boolean;
  useTopologyStore.getState().setIsSimulating(enabled);
  return {
    content: [{ text: enabled ? 'Failure simulation enabled.' : 'Failure simulation disabled.' }],
    status: 'success',
  };
}

function handleToggleLiveStatus(input: Record<string, unknown>): ToolResult {
  const store = useTopologyStore.getState();
  if (typeof input.enabled === 'boolean') {
    if (store.showLiveStatus !== input.enabled) {
      store.toggleLiveStatus();
    }
    return {
      content: [{ text: input.enabled ? 'Live status overlay enabled.' : 'Live status overlay disabled.' }],
      status: 'success',
    };
  }
  store.toggleLiveStatus();
  const newState = useTopologyStore.getState().showLiveStatus;
  return {
    content: [{ text: newState ? 'Live status overlay enabled.' : 'Live status overlay disabled.' }],
    status: 'success',
  };
}

function handleChangeScenario(input: Record<string, unknown>): ToolResult {
  const store = useTopologyStore.getState();
  if (!store.useMock) {
    return {
      content: [{ text: 'Scenario switching is only available in demo/mock mode, not with live AWS data.' }],
      status: 'error',
    };
  }
  const scenario = input.scenario as MockScenario;
  store.setMockScenario(scenario);
  return { content: [{ text: `Switched to ${scenario} demo scenario.` }], status: 'success' };
}
