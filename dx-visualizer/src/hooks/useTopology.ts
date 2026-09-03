import { useCallback, useEffect, useRef } from 'react';
import { useTopologyStore } from '../store/topology-store';
import { getMockTopology } from '../utils/mock-data';
import { fetchAllTopologyData } from '../api/fetch-topology';
import { resolveAccountName } from '../api/organizations';
import { buildGraph } from '../engine/topology-builder';
import { applyLayout } from '../engine/layout-engine';
import { analyzeTopology, getRecommendedGraph } from '../engine/recommendation-engine';
import type { DxNode, TopologyData } from '../types/topology';

/**
 * Topology with every Site-to-Site VPN removed, for the "hide VPN" filter.
 *
 * Clearing `vpnConnections` is enough to erase VPN from the graph entirely:
 * `addVpnSubgraph` — the sole producer of `vpn-*`, `onprem-vpn-*` and
 * `custsite-vpn-*` nodes and of the tunnel edges — is only ever reached by
 * iterating this array, and `customerGateways` is read nowhere else in
 * `buildGraph`, so the CGW routers vanish with it.
 *
 * Stripping before the build rather than filtering after it also fixes two
 * things for free. The layout engine reserves a band above the DX rows sized
 * to the VPN section and widens the `cgw` column to hold it; with no VPN nodes
 * present the band collapses and the column drops to zero width. And
 * `isTgwIsolated` / `isVgwIsolated` now count a VPN-only gateway as isolated,
 * so it moves into the Unattached zone instead of floating on the canvas with
 * every edge filtered out from under it.
 */
function withoutVpn(topology: TopologyData): TopologyData {
  return { ...topology, vpnConnections: [] };
}

function rebuildFromTopology() {
  const {
    topologyData,
    expandedVpcGroups,
    expandedTgwGroups,
    vpcGroupViewMode,
    expandedIsolatedTgwGroups,
    isolatedTgwGroupViewMode,
    showNonDxVpcs,
    showVpn,
    expandedPartnerGroups,
    resiliencyTargets,
    focusedDxGatewayId,
    expandedUnattachedZone,
    expandedHiddenAssocZone,
    nodeSizeOverrides,
    showUtilization,
    setCurrentGraph,
    setRecommendedGraph,
    setAssessment,
  } = useTopologyStore.getState();
  if (!topologyData) return;

  const { nodes, edges } = buildGraph(
    showVpn ? topologyData : withoutVpn(topologyData),
    expandedVpcGroups,
    expandedTgwGroups,
    vpcGroupViewMode,
    expandedIsolatedTgwGroups,
    isolatedTgwGroupViewMode,
    showNonDxVpcs,
    expandedPartnerGroups,
  );
  // Always the FULL topology, never the VPN-stripped copy above. Hiding VPN is
  // a canvas filter, not a change of scope: `bp-no-vpn-backup` warns when no
  // VPN exists, and `vpn-tunnel-redundancy` / `vpn-static-routes-only` /
  // `vpn-dpd` report real faults, so grading the stripped copy would both
  // invent a finding and silence four others.
  const assessment = analyzeTopology(topologyData, resiliencyTargets);

  const nodesWithBadges = nodes.map((node) => {
    const annotations = assessment.bestPractice.annotations.filter(
      (a) => a.nodeId === node.id
    );
    if (annotations.length > 0) {
      return {
        ...node,
        data: { ...node.data, badges: annotations.map((a) => a.badge) },
      };
    }
    return node;
  });

  // DXGWs with zero VIFs have nothing hanging off them — flag them so the
  // node renders with an UNATTACHED chip in both current and recommended views.
  // A Cloud WAN association counts as a downstream path but still leaves the
  // DXGW without any physical connection on the ingress side, so we keep the
  // chip regardless of core-network attachments.
  const orphanDxgwNodeIds = new Set(
    assessment.perDxGateway
      .filter((d) => d.connectionCount === 0)
      .map((d) => `dxgw-${d.dxGatewayId}`),
  );
  const tagOrphans = (list: DxNode[]): DxNode[] =>
    orphanDxgwNodeIds.size === 0
      ? list
      : list.map((n) =>
          orphanDxgwNodeIds.has(n.id)
            ? { ...n, data: { ...n.data, isOrphan: true } }
            : n,
        );

  const layoutNodes = applyLayout(nodesWithBadges, edges, { expandedUnattachedZone, expandedHiddenAssocZone, nodeSizeOverrides, showUtilization });
  setCurrentGraph(tagOrphans(layoutNodes), edges);

  const { nodes: recNodes, edges: recEdges } = getRecommendedGraph(assessment, focusedDxGatewayId);

  if (recNodes.length > 0) {
    const combined = [...nodesWithBadges, ...recNodes];
    const allEdges = [...edges, ...recEdges];
    const layoutAll = applyLayout(combined, allEdges, { expandedUnattachedZone, expandedHiddenAssocZone, nodeSizeOverrides, showUtilization });
    const recNodeIds = new Set(recNodes.map((rn) => rn.id));
    const layoutCurrentForRec = tagOrphans(layoutAll.filter((n) => !recNodeIds.has(n.id)));
    const layoutRecNodes = layoutAll.filter((n) => recNodeIds.has(n.id));
    setRecommendedGraph(layoutRecNodes, recEdges, layoutCurrentForRec);
  } else {
    setRecommendedGraph([], recEdges, tagOrphans(layoutNodes));
  }

  setAssessment(assessment);
}

export function useTopology() {
  const {
    setIsLoading,
    setError,
    setTopologyData,
  } = useTopologyStore();

  const expandedVpcGroups = useTopologyStore((s) => s.expandedVpcGroups);
  const expandedTgwGroups = useTopologyStore((s) => s.expandedTgwGroups);
  const vpcGroupViewMode = useTopologyStore((s) => s.vpcGroupViewMode);
  const expandedIsolatedTgwGroups = useTopologyStore((s) => s.expandedIsolatedTgwGroups);
  const isolatedTgwGroupViewMode = useTopologyStore((s) => s.isolatedTgwGroupViewMode);
  const showNonDxVpcs = useTopologyStore((s) => s.showNonDxVpcs);
  // Hiding VPN changes which nodes buildGraph emits, so it has to rebuild the
  // graph — it can't be a render-time filter like showVpcs.
  const showVpn = useTopologyStore((s) => s.showVpn);
  const expandedPartnerGroups = useTopologyStore((s) => s.expandedPartnerGroups);
  const resiliencyTargets = useTopologyStore((s) => s.resiliencyTargets);
  const focusedDxGatewayId = useTopologyStore((s) => s.focusedDxGatewayId);
  const expandedUnattachedZone = useTopologyStore((s) => s.expandedUnattachedZone);
  const expandedHiddenAssocZone = useTopologyStore((s) => s.expandedHiddenAssocZone);
  // Toggling utilization mode widens the DX Connection / VIF edge labels —
  // applyLayout reads this to inflate the column gaps so labels don't overlap
  // the partner / AWS Logical Device nodes.
  const showUtilization = useTopologyStore((s) => s.showUtilization);
  // Subscribe to topologyData itself so utilization fetches (which mutate
  // topologyData with a fresh object) trigger a rebuild → CustomEdge picks
  // up the new vifUtilization/connectionUtilization maps.
  const topologyData = useTopologyStore((s) => s.topologyData);

  // Monotonic fetch id. A rapid Refresh / scenario switch starts a new fetch
  // while an older one is still in flight; we bump this at the start of every
  // call and any result that lands after the id moved on is discarded. Prevents
  // stale topology from overwriting fresh topology, and keeps `isLoading` tied
  // to the most recent fetch only.
  const fetchIdRef = useRef(0);

  const loadTopology = useCallback(async () => {
    // Hard guard against clobbering an imported snapshot. Refresh, Retry,
    // sign-out, and session-timeout all funnel through here — without this
    // gate, any of them would replace the customer's imported topology with
    // the SA's own AWS data (or mock fallback). The SA must explicitly Exit
    // the imported view first.
    if (useTopologyStore.getState().importedSnapshot != null) return;

    const fetchId = ++fetchIdRef.current;
    const isLatest = () => fetchIdRef.current === fetchId;

    const { credentials, useMock, mockScenario, clearUserEdges, clearHiddenEdges, clearEdgeReconnectOverrides, clearUserCustomerSites, clearHiddenCustomerSites, resetUtilization, resetVifRoutes } = useTopologyStore.getState();

    // Refresh wipes user-drawn, hidden, and rewired edges plus user-added
    // and user-hidden Customer Data Center zones — node IDs may change after
    // a refetch, so any persisted customizations would render as stray zones
    // / edges or silently hide the wrong site.
    clearUserEdges();
    clearHiddenEdges();
    clearEdgeReconnectOverrides();
    clearUserCustomerSites();
    clearHiddenCustomerSites();
    // Utilization is per-topology — a refetch invalidates the cache so users
    // don't see stale CloudWatch data after switching scenarios or accounts.
    resetUtilization();
    // BGP routes are per-topology for the same reason, and more sharply so: the
    // cache is keyed by VIF id, so surviving a scenario switch or an account
    // change would stamp one topology's prefixes onto another's VIFs and compute
    // a confidently wrong failover-gap count from them.
    resetVifRoutes();

    setIsLoading(true);
    setError(null);

    try {
      let topology;
      if (credentials && !useMock) {
        topology = await fetchAllTopologyData(credentials);
      } else {
        topology = getMockTopology(mockScenario);
      }

      if (!isLatest()) return;

      setTopologyData(topology);
      if (useMock) {
        const mockNames: Record<string, string> = {
          '123456789012': 'NetworkHub-Prod',
          '111111111111': 'NetworkHub-Shared',
        };
        useTopologyStore.getState().setHomeAccountName(
          mockNames[topology.homeAccountId ?? ''] ?? null,
        );
      } else if (credentials && topology.homeAccountId) {
        // Fire-and-forget: try Organizations, then IAM alias.
        // Leaves the legend on the account ID until the name resolves.
        // Guarded by isLatest so a slow resolve from a superseded fetch
        // doesn't stamp its account name onto the newer topology.
        resolveAccountName(credentials, topology.homeAccountId).then((name) => {
          if (name && isLatest()) useTopologyStore.getState().setHomeAccountName(name);
        });
      }
      rebuildFromTopology();
      useTopologyStore.getState().bumpTopologyRefresh();
      // Live mode owns the BGP route data, so a refresh taken while live is on
      // refetches it rather than waiting for a click — otherwise the route cache
      // we just cleared would leave the DX Gateway gap counts blank until someone
      // opened a panel.
      if (useTopologyStore.getState().showLiveStatus) {
        void useTopologyStore.getState().ensureVifRoutes();
      }
    } catch (err) {
      if (!isLatest()) return;
      setError(err instanceof Error ? err.message : 'Failed to load topology');
    } finally {
      // Only the newest fetch owns the loading flag; stale fetches that
      // finish late must not flip the spinner off while the newer one
      // is still running.
      if (isLatest()) setIsLoading(false);
    }
  }, [setIsLoading, setError, setTopologyData]);

  // Rebuild graph when expandedVpcGroups changes (without re-fetching)
  // Also rebuild on mount so HMR picks up layout-engine changes
  useEffect(() => {
    const { topologyData } = useTopologyStore.getState();
    if (topologyData) {
      rebuildFromTopology();
    }
  }, [topologyData, expandedVpcGroups, expandedTgwGroups, vpcGroupViewMode, expandedIsolatedTgwGroups, isolatedTgwGroupViewMode, showNonDxVpcs, showVpn, expandedPartnerGroups, resiliencyTargets, focusedDxGatewayId, expandedUnattachedZone, expandedHiddenAssocZone, showUtilization]);


  return { loadTopology };
}
