import { useTopologyStore } from '../store/topology-store';
import { lookupDxPricing, lookupNetworkServicePricing } from './dx-pricing';
import { fetchDxCosts, fetchDxDailyCosts } from '../api/cost-explorer';
import { RESILIENCY_TIERS, type MockScenario } from '../utils/shared';
import { getLocationDeviceCounts } from '../engine/sla-gating';

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
  let pricingNote = '';
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
