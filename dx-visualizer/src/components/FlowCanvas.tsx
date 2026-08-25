import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRedact } from '../utils/redact';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  BackgroundVariant,
  useUpdateNodeInternals,
  useReactFlow,
  type NodeChange,
  type Edge,
  type Connection,
  type Node,
} from '@xyflow/react';
import { useTopologyStore } from '../store/topology-store';
import { computeDropSnap } from '../utils/drop-snap';
import { planUserEdge, isUserDrawnPair, type ConnectEndpoint } from '../utils/user-edges';
import { CustomerSiteNode } from './nodes/CustomerSiteNode';
import { OnPremiseNode } from './nodes/OnPremiseNode';
import { CgwNode } from './nodes/CgwNode';
import { DxLocationNode } from './nodes/DxLocationNode';
import { DxPartnerDeviceNode } from './nodes/DxPartnerDeviceNode';
import { DxPartnerDeviceGroupNode } from './nodes/DxPartnerDeviceGroupNode';
import { LagNode } from './nodes/LagNode';
import { AwsDeviceNode } from './nodes/AwsDeviceNode';
import { DxGatewayNode } from './nodes/DxGatewayNode';
import { TgwNode } from './nodes/TgwNode';
import { TgwConnectNode } from './nodes/TgwConnectNode';
import { TgwFirewallNode } from './nodes/TgwFirewallNode';
import { CoreNetworkNode } from './nodes/CoreNetworkNode';
import { VgwNode } from './nodes/VgwNode';
import { VpcNode } from './nodes/VpcNode';
import { VpcGroupNode } from './nodes/VpcGroupNode';
import { TgwGroupNode } from './nodes/TgwGroupNode';
import { IsolatedTgwGroupNode } from './nodes/IsolatedTgwGroupNode';
import { RegionNode } from './nodes/RegionNode';
import { UnattachedZoneNode } from './nodes/UnattachedZoneNode';
import { HiddenAssocZoneNode } from './nodes/HiddenAssocZoneNode';
import { AwsCloudNode } from './nodes/AwsCloudNode';
import { PublicResourcesNode } from './nodes/PublicResourcesNode';
import { CustomEdge } from '../edges/CustomEdge';

const nodeTypes = {
  customerSite: CustomerSiteNode,
  onPremise: OnPremiseNode,
  cgw: CgwNode,
  dxLocation: DxLocationNode,
  dxPartnerDevice: DxPartnerDeviceNode,
  dxPartnerDeviceGroup: DxPartnerDeviceGroupNode,
  lag: LagNode,
  awsDevice: AwsDeviceNode,
  dxGateway: DxGatewayNode,
  tgw: TgwNode,
  tgwConnect: TgwConnectNode,
  tgwFirewall: TgwFirewallNode,
  coreNetwork: CoreNetworkNode,
  vgw: VgwNode,
  vpc: VpcNode,
  vpcGroup: VpcGroupNode,
  tgwGroup: TgwGroupNode,
  isolatedTgwGroup: IsolatedTgwGroupNode,
  region: RegionNode,
  unattachedZone: UnattachedZoneNode,
  hiddenAssocZone: HiddenAssocZoneNode,
  awsCloud: AwsCloudNode,
  publicResources: PublicResourcesNode,
};

const edgeTypes = {
  customEdge: CustomEdge,
};

// Container types render behind regular nodes
const CONTAINER_TYPES = new Set(['customerSite', 'dxLocation', 'region', 'unattachedZone', 'hiddenAssocZone', 'awsCloud']);

// Drag-to-adopt: which leaf categories can be dropped into containers
const LEAF_DROPPABLE_CATEGORIES = new Set(['onPremise', 'cgw']);
const CONTAINER_DROP_TARGETS = new Set(['customerSite', 'dxLocation']);

// Group nodes own their own click handler (expand/collapse) — pinning their
// path via click would steal that gesture. Users can still hover them to
// preview the path; pin gets triggered from leaf nodes instead.
const GROUP_TYPES = new Set(['tgwGroup', 'vpcGroup', 'isolatedTgwGroup', 'dxPartnerDeviceGroup']);

const VPC_CATEGORIES = new Set(['vpc', 'vpcGroup']);

export function FlowCanvas() {
  const theme = useTopologyStore((s) => s.theme);
  const viewMode = useTopologyStore((s) => s.viewMode);
  const currentNodes = useTopologyStore((s) => s.currentNodes);
  const currentEdges = useTopologyStore((s) => s.currentEdges);
  const recommendedNodes = useTopologyStore((s) => s.recommendedNodes);
  const recommendedEdges = useTopologyStore((s) => s.recommendedEdges);
  const recommendedCurrentNodes = useTopologyStore((s) => s.recommendedCurrentNodes);
  const updateNodePositions = useTopologyStore((s) => s.updateNodePositions);
  const isSimulating = useTopologyStore((s) => s.isSimulating);
  const toggleEdgeFailure = useTopologyStore((s) => s.toggleEdgeFailure);
  const failZone = useTopologyStore((s) => s.failZone);
  const failedNodeIds = useTopologyStore((s) => s.failedNodeIds);
  const showVpcs = useTopologyStore((s) => s.showVpcs);
  const isLocked = useTopologyStore((s) => s.isLocked);
  const setIsLocked = useTopologyStore((s) => s.setIsLocked);
  const homeAccountId = useTopologyStore((s) => s.topologyData?.homeAccountId);
  const homeAccountName = useTopologyStore((s) => s.homeAccountName);
  const redactMode = useTopologyStore((s) => s.redactMode);
  const r = useRedact();
  const setHoveredNode = useTopologyStore((s) => s.setHoveredNode);
  const setHoveredEdge = useTopologyStore((s) => s.setHoveredEdge);
  const setPinnedNode = useTopologyStore((s) => s.setPinnedNode);
  const setEdgeReconnectOverride = useTopologyStore((s) => s.setEdgeReconnectOverride);
  const edgeReconnectOverrides = useTopologyStore((s) => s.edgeReconnectOverrides);
  const updateNodeDimensions = useTopologyStore((s) => s.updateNodeDimensions);
  const hiddenEdgeIds = useTopologyStore((s) => s.hiddenEdgeIds);
  const hideEdge = useTopologyStore((s) => s.hideEdge);
  const userEdges = useTopologyStore((s) => s.userEdges);
  const addUserEdge = useTopologyStore((s) => s.addUserEdge);
  const userCustomerSites = useTopologyStore((s) => s.userCustomerSites);
  const updateUserCustomerSitePosition = useTopologyStore((s) => s.updateUserCustomerSitePosition);
  const updateUserCustomerSiteDimensions = useTopologyStore((s) => s.updateUserCustomerSiteDimensions);
  const hiddenCustomerSiteIds = useTopologyStore((s) => s.hiddenCustomerSiteIds);
  const userOnPremises = useTopologyStore((s) => s.userOnPremises);
  const hiddenOnPremiseIds = useTopologyStore((s) => s.hiddenOnPremiseIds);
  const updateUserOnPremisePosition = useTopologyStore((s) => s.updateUserOnPremisePosition);
  const showLiveStatus = useTopologyStore((s) => s.showLiveStatus);
  const reparentNodeToContainer = useTopologyStore((s) => s.reparentNodeToContainer);
  const setNodeSizeOverride = useTopologyStore((s) => s.setNodeSizeOverride);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [legendOverride, setLegendOverride] = useState<boolean | null>(null);
  const updateNodeInternals = useUpdateNodeInternals();
  const { getNodes, getNode } = useReactFlow();
  const dropTargetRef = useRef<string | null>(null);

  // Toggling Live mode adds/removes a status row inside live-capable nodes,
  // which shifts the Handle's vertical position. React Flow caches handle
  // coordinates and only re-measures when the outer node element resizes —
  // but our nodes have a fixed outer style.height (NODE_DIMENSIONS), so the
  // ResizeObserver never fires. Without this, edges land a few px off the
  // handle until the next layout rebuild.
  useEffect(() => {
    const { currentNodes: cn, recommendedNodes: rn, recommendedCurrentNodes: rcn } = useTopologyStore.getState();
    const ids = [...cn, ...rn, ...rcn].map((n) => n.id);
    if (ids.length > 0) updateNodeInternals(ids);
  }, [showLiveStatus, updateNodeInternals]);

  // Toggling redact swaps resource IDs / IPs / ASNs for bullet strings of a
  // different length, so the centered inner content resizes and the node's
  // side Handle shifts. As with Live mode above, the outer node width is fixed
  // by the layout engine, so React Flow's ResizeObserver never fires and edge
  // endpoints stay pinned to stale handle coordinates — leaving a visible gap
  // between the edge and its dot (e.g. at VPN nodes). Re-measure every rendered
  // node (getNodes covers user-created on-prem / site nodes too, which the
  // store-collection list above omits).
  useEffect(() => {
    const ids = getNodes().map((n) => n.id);
    if (ids.length > 0) updateNodeInternals(ids);
  }, [redactMode, updateNodeInternals, getNodes]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      // Outside simulation mode, clicking a hoverable leaf node pins its path —
      // the BFS highlight survives mouse-leave until the user clicks the
      // pane or the same node again. Group nodes own the click for
      // expand/collapse, so they don't participate in pinning.
      if (!isSimulating) {
        const cat = (node.data as Record<string, unknown>)?.category as string;
        if (CONTAINER_TYPES.has(cat) || GROUP_TYPES.has(cat)) return;
        setPinnedNode(node.id);
        return;
      }
      if (isLocked) return;
      const category = (node.data as Record<string, unknown>)?.category as string;
      if (!CONTAINER_TYPES.has(category) || category === 'awsCloud') return;

      const details = (node.data as Record<string, unknown>)?.details as Record<string, string> | undefined;
      const childNodeIds: string[] = [];

      if (category === 'dxLocation' || category === 'customerSite') {
        const locationCode = details?.code ?? details?.locationCode;
        if (!locationCode) return;
        for (const n of currentNodes) {
          if (CONTAINER_TYPES.has(n.data.category)) continue;
          const nLoc = (n.data.details as Record<string, string>)?.locationCode;
          if (nLoc === locationCode) childNodeIds.push(n.id);
        }
      } else if (category === 'region') {
        const regionCode = details?.regionCode;
        if (!regionCode) return;
        const regionChildCategories = new Set(['tgw', 'tgwConnect', 'tgwFirewall', 'tgwGroup', 'isolatedTgwGroup', 'vgw', 'vpc', 'vpcGroup']);
        for (const n of currentNodes) {
          if (!regionChildCategories.has(n.data.category)) continue;
          const nRegion = (n.data.details as Record<string, string>)?.region;
          if (nRegion === regionCode || n.id.includes(regionCode)) childNodeIds.push(n.id);
        }
      }

      if (childNodeIds.length === 0) return;

      const nodeSet = new Set(childNodeIds);
      const childEdgeIds: string[] = [];
      for (const e of currentEdges) {
        if (!e.data?.isRecommended && (nodeSet.has(e.source) || nodeSet.has(e.target))) {
          childEdgeIds.push(e.id);
        }
      }

      failZone([node.id, ...childNodeIds], childEdgeIds);
    },
    [isLocked, isSimulating, currentNodes, currentEdges, failZone, setPinnedNode]
  );

  const onNodeMouseEnter = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (isSimulating) return; // avoid fighting with failure-simulation styling
      const category = (node.data as Record<string, unknown>)?.category as string;
      // Containers wrap many nodes and would just highlight everything — skip them.
      if (CONTAINER_TYPES.has(category)) return;
      setHoveredNode(node.id);
    },
    [isSimulating, setHoveredNode]
  );

  const onNodeMouseLeave = useCallback(() => {
    setHoveredNode(null);
  }, [setHoveredNode]);

  const onEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      if (!isLocked && isSimulating && !edge.data?.isRecommended) {
        toggleEdgeFailure(edge.id);
      }
      if (!isLocked && !isSimulating) {
        setSelectedEdgeId(edge.id);
      }
    },
    [isLocked, isSimulating, toggleEdgeFailure]
  );

  const onEdgeMouseEnter = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      if (isSimulating) return;
      // Peering edges (VPC↔VPC, TGW↔TGW, Cloud WAN↔TGW) are point-to-point:
      // highlight only this edge + its two endpoints, not a full E2E path —
      // otherwise a VPC with many peerings lights up its whole upstream and
      // every sibling peering, obscuring which peer this edge connects.
      if ((edge.data as { isPeering?: boolean } | undefined)?.isPeering) {
        setHoveredEdge(edge.id, edge.source, edge.target);
        return;
      }
      // BFS from either endpoint yields the same E2E path since both sit on the
      // hovered edge — picking source is arbitrary.
      setHoveredNode(edge.source);
    },
    [isSimulating, setHoveredNode, setHoveredEdge]
  );

  const onEdgeMouseLeave = useCallback(() => {
    setHoveredNode(null);
    setHoveredEdge(null);
  }, [setHoveredNode, setHoveredEdge]);

  const customerSiteIds = useMemo(() => {
    const base = viewMode === 'recommended' && recommendedCurrentNodes.length > 0
      ? [...recommendedCurrentNodes, ...recommendedNodes]
      : currentNodes;
    return new Set(base.filter((n) => n.data.category === 'customerSite').map((n) => n.id));
  }, [viewMode, currentNodes, recommendedNodes, recommendedCurrentNodes]);

  const dxLocationIds = useMemo(() => {
    const base = viewMode === 'recommended' && recommendedCurrentNodes.length > 0
      ? [...recommendedCurrentNodes, ...recommendedNodes]
      : currentNodes;
    return new Set(base.filter((n) => n.data.category === 'dxLocation').map((n) => n.id));
  }, [viewMode, currentNodes, recommendedNodes, recommendedCurrentNodes]);

  const userCustomerSiteIds = useMemo(
    () => new Set(userCustomerSites.map((s) => s.id)),
    [userCustomerSites],
  );

  const userOnPremiseIds = useMemo(
    () => new Set(userOnPremises.map((r) => r.id)),
    [userOnPremises],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const positionChanges = changes
        .filter((c): c is NodeChange & { type: 'position'; id: string; position: { x: number; y: number } } =>
          c.type === 'position' && 'position' in c && c.position != null
        )
        .map((c) => ({ id: c.id, position: c.position }));
      if (positionChanges.length > 0) {
        const userSitePositions = positionChanges.filter((c) => userCustomerSiteIds.has(c.id));
        const userRouterPositions = positionChanges.filter((c) => userOnPremiseIds.has(c.id));
        const otherPositions = positionChanges.filter(
          (c) => !userCustomerSiteIds.has(c.id) && !userOnPremiseIds.has(c.id),
        );
        for (const p of userSitePositions) updateUserCustomerSitePosition(p.id, p.position);
        for (const p of userRouterPositions) updateUserOnPremisePosition(p.id, p.position);
        if (otherPositions.length > 0) updateNodePositions(otherPositions);
      }
      // Propagate resize dimensions for customerSite containers only
      const dimChanges = changes
        .filter((c): c is NodeChange & { type: 'dimensions'; id: string; dimensions: { width: number; height: number }; resizing: boolean } => {
          if (c.type !== 'dimensions') return false;
          const rec = c as unknown as Record<string, unknown>;
          return rec.dimensions != null && rec.resizing === true && (customerSiteIds.has(c.id) || userCustomerSiteIds.has(c.id) || dxLocationIds.has(c.id));
        })
        .map((c) => ({ id: c.id, width: c.dimensions.width, height: c.dimensions.height }));
      if (dimChanges.length > 0) {
        const userSiteDims = dimChanges.filter((c) => userCustomerSiteIds.has(c.id));
        const otherDims = dimChanges.filter((c) => !userCustomerSiteIds.has(c.id));
        for (const d of userSiteDims) updateUserCustomerSiteDimensions(d.id, d.width, d.height);
        if (otherDims.length > 0) updateNodeDimensions(otherDims);
      }
    },
    [updateNodePositions, updateNodeDimensions, customerSiteIds, dxLocationIds, userCustomerSiteIds, userOnPremiseIds, updateUserCustomerSitePosition, updateUserCustomerSiteDimensions, updateUserOnPremisePosition]
  );

  const getAbsolutePosition = useCallback(
    (node: Node) => {
      let absX = node.position.x;
      let absY = node.position.y;
      let pid = node.parentId;
      while (pid) {
        const parent = getNode(pid);
        if (!parent) break;
        absX += parent.position.x;
        absY += parent.position.y;
        pid = parent.parentId;
      }
      return { x: absX, y: absY };
    },
    [getNode],
  );

  const onNodeDrag = useCallback(
    (_event: MouseEvent | TouchEvent, draggedNode: Node) => {
      if (isLocked || isSimulating) return;
      const category = (draggedNode.data as Record<string, unknown>).category as string;
      if (!LEAF_DROPPABLE_CATEGORIES.has(category)) {
        if (dropTargetRef.current) {
          document.querySelector(`[data-id="${dropTargetRef.current}"]`)?.classList.remove('drop-target-highlight');
          dropTargetRef.current = null;
        }
        return;
      }

      const abs = getAbsolutePosition(draggedNode);
      const draggedW = draggedNode.measured?.width ?? 200;
      const draggedH = draggedNode.measured?.height ?? 80;
      const draggedCenterX = abs.x + draggedW / 2;
      const draggedCenterY = abs.y + draggedH / 2;

      const allNodes = getNodes();
      let foundTarget: string | null = null;
      for (const node of allNodes) {
        const cat = (node.data as Record<string, unknown>).category as string;
        if (!CONTAINER_DROP_TARGETS.has(cat)) continue;
        if (node.id === draggedNode.parentId) continue;
        const nw = node.measured?.width ?? (node.width as number | undefined) ?? 260;
        const nh = node.measured?.height ?? (node.height as number | undefined) ?? 200;
        const nx = node.position.x;
        const ny = node.position.y;
        if (
          draggedCenterX >= nx &&
          draggedCenterX <= nx + nw &&
          draggedCenterY >= ny &&
          draggedCenterY <= ny + nh
        ) {
          foundTarget = node.id;
          break;
        }
      }

      if (foundTarget !== dropTargetRef.current) {
        if (dropTargetRef.current) {
          document.querySelector(`[data-id="${dropTargetRef.current}"]`)?.classList.remove('drop-target-highlight');
        }
        dropTargetRef.current = foundTarget;
        if (foundTarget) {
          document.querySelector(`[data-id="${foundTarget}"]`)?.classList.add('drop-target-highlight');
        }
      }
    },
    [isLocked, isSimulating, getNodes, getAbsolutePosition],
  );

  const onNodeDragStop = useCallback(
    (_event: MouseEvent | TouchEvent, draggedNode: Node) => {
      const targetId = dropTargetRef.current;
      if (dropTargetRef.current) {
        document.querySelector(`[data-id="${dropTargetRef.current}"]`)?.classList.remove('drop-target-highlight');
      }
      dropTargetRef.current = null;

      if (!targetId || isLocked || isSimulating) return;
      const category = (draggedNode.data as Record<string, unknown>).category as string;
      if (!LEAF_DROPPABLE_CATEGORIES.has(category)) return;

      if (draggedNode.parentId === targetId) return;

      const targetNode = getNode(targetId);
      if (!targetNode) return;

      const targetW = targetNode.measured?.width ?? (targetNode.width as number | undefined) ?? 260;
      const targetH = targetNode.measured?.height ?? (targetNode.height as number | undefined) ?? 200;
      const draggedW = draggedNode.measured?.width ?? 200;
      const draggedH = draggedNode.measured?.height ?? 80;

      const dragAbs = getAbsolutePosition(draggedNode);
      const relY = dragAbs.y - targetNode.position.y;

      const allNodes = getNodes();
      const children = allNodes.filter(
        (n) => n.parentId === targetId && n.id !== draggedNode.id
      );

      const childRects = children.map((n) => ({
        x: n.position.x,
        y: n.position.y,
        width: n.measured?.width ?? 200,
        height: n.measured?.height ?? 80,
      }));

      const snap = computeDropSnap(relY, targetW, targetH, draggedW, draggedH, childRects);
      const finalX = snap.relX;
      const finalY = snap.relY;
      const newW = snap.newContainerWidth;
      const newH = snap.newContainerHeight;

      const nodeId = draggedNode.id;
      requestAnimationFrame(() => {
        if (newW !== targetW || newH !== targetH) {
          setNodeSizeOverride(targetId, newW, newH);
          updateNodeDimensions([{ id: targetId, width: newW, height: newH }]);
        }
        reparentNodeToContainer(nodeId, targetId, { x: finalX, y: finalY });
      });
    },
    [isLocked, isSimulating, getNode, getNodes, getAbsolutePosition, setNodeSizeOverride, updateNodeDimensions, reparentNodeToContainer],
  );

  const onReconnect = useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      // Only allow rewiring edges between on-prem CGW nodes and DX partner devices
      const allNodes = viewMode === 'recommended' && recommendedCurrentNodes.length > 0
        ? [...recommendedCurrentNodes, ...recommendedNodes, ...userOnPremises]
        : [...currentNodes, ...userOnPremises];
      const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

      const sourceNode = nodeMap.get(oldEdge.source);
      const targetNode = nodeMap.get(oldEdge.target);
      if (!sourceNode || !targetNode) return;

      const srcCat = (sourceNode.data as Record<string, unknown>)?.category as string;
      const tgtCat = (targetNode.data as Record<string, unknown>)?.category as string;

      // Must be onPremise → dxPartnerDevice edge
      const isOnPremToPartner = srcCat === 'onPremise' && tgtCat === 'dxPartnerDevice';
      if (!isOnPremToPartner) return;

      // New target must also be a dxPartnerDevice, new source must be onPremise
      const newSrcNode = nodeMap.get(newConnection.source ?? '');
      const newTgtNode = nodeMap.get(newConnection.target ?? '');
      if (!newSrcNode || !newTgtNode) return;

      const newSrcCat = (newSrcNode.data as Record<string, unknown>)?.category as string;
      const newTgtCat = (newTgtNode.data as Record<string, unknown>)?.category as string;
      if (newSrcCat !== 'onPremise' || newTgtCat !== 'dxPartnerDevice') return;

      setEdgeReconnectOverride(oldEdge.id, newConnection.source!, newConnection.target!);
    },
    [viewMode, currentNodes, recommendedNodes, recommendedCurrentNodes, userOnPremises, setEdgeReconnectOverride],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (isLocked || isSimulating) return;
      if (!connection.source || !connection.target) return;

      const allNodes = viewMode === 'recommended' && recommendedCurrentNodes.length > 0
        ? [...recommendedCurrentNodes, ...recommendedNodes, ...userOnPremises]
        : [...currentNodes, ...userOnPremises];
      const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

      // Absolute Y comes from the live ReactFlow node rather than `nodeMap`, so a
      // router the user has already dragged is measured where it now sits — that
      // position decides which end of a customer link is the source.
      const endpoint = (nodeId: string): ConnectEndpoint | undefined => {
        const node = nodeMap.get(nodeId);
        if (!node) return undefined;
        const live = getNode(nodeId);
        return {
          id: nodeId,
          category: node.data.category,
          y: live ? getAbsolutePosition(live).y : node.position.y,
        };
      };

      const planned = planUserEdge(
        endpoint(connection.source),
        endpoint(connection.target),
        { sourceHandle: connection.sourceHandle, targetHandle: connection.targetHandle },
      );
      if (planned) addUserEdge(planned.edge);
    },
    [isLocked, isSimulating, viewMode, currentNodes, recommendedNodes, recommendedCurrentNodes, userOnPremises, addUserEdge, getNode, getAbsolutePosition],
  );

  const nodes = useMemo(() => {
    const baseNodes = viewMode === 'recommended' && recommendedCurrentNodes.length > 0
      ? recommendedCurrentNodes
      : currentNodes;
    let all = viewMode === 'recommended'
      ? [...baseNodes, ...recommendedNodes]
      : [...baseNodes];

    // Filter out VPC nodes if hidden
    if (!showVpcs) {
      all = all.filter((n) => !VPC_CATEGORIES.has(n.data.category));
    }

    // Drop user-hidden Customer Router nodes. Their edges get filtered in the
    // `edges` memo below.
    if (hiddenOnPremiseIds.size > 0) {
      all = all.filter((n) => !(n.data.category === 'onPremise' && hiddenOnPremiseIds.has(n.id)));
    }

    // Drop user-hidden Customer Data Center containers but KEEP their child
    // nodes (e.g. the CGW inside). Detach each child by clearing parentId and
    // reprojecting its relative position back to absolute coordinates using
    // the hidden container's position.
    if (hiddenCustomerSiteIds.size > 0) {
      const byId = new Map(all.map((n) => [n.id, n] as const));
      all = all
        .filter((n) => !(n.data.category === 'customerSite' && hiddenCustomerSiteIds.has(n.id)))
        .map((n) => {
          if (!n.parentId || !hiddenCustomerSiteIds.has(n.parentId)) return n;
          const parent = byId.get(n.parentId);
          if (!parent) return { ...n, parentId: undefined };
          return {
            ...n,
            parentId: undefined,
            position: {
              x: parent.position.x + n.position.x,
              y: parent.position.y + n.position.y,
            },
          };
        });
    }

    // Append user-added Customer Data Center zones. Stack each below the lowest
    // existing customerSite so they form a column on the left edge. Once the
    // user drags a site, userPlaced=true and we respect the stored position.
    if (userCustomerSites.length > 0) {
      const existingSites = all.filter((n) => n.data.category === 'customerSite' && !n.parentId);
      let anchorX = 0;
      let cursorY = 0;
      if (existingSites.length > 0) {
        const sorted = [...existingSites].sort((a, b) => {
          const ay = a.position.y + (a.height ?? (a.style?.height as number) ?? 120);
          const by = b.position.y + (b.height ?? (b.style?.height as number) ?? 120);
          return by - ay;
        });
        const last = sorted[0];
        anchorX = last.position.x;
        cursorY = last.position.y + (last.height ?? (last.style?.height as number) ?? 120) + 24;
      }
      for (const site of userCustomerSites) {
        const h = (site.height ?? (site.style?.height as number) ?? 120);
        const placed = (site.data as Record<string, unknown>)?.userPlaced === 'true';
        if (placed) {
          all.push(site);
        } else {
          all.push({ ...site, position: { x: anchorX, y: cursorY } });
          cursorY += h + 24;
        }
      }
    }

    // Append user-added Customer Router nodes inside their parent Customer Data
    // Center zone. Positions are stored as (0, 0) in the store; compute a
    // sensible relative slot by stacking each below the zone's existing
    // onPremise children. React Flow uses coordinates relative to parentId.
    if (userOnPremises.length > 0) {
      const ROUTER_W = 200;
      const ROUTER_H = 80;
      const ROUTER_GAP = 12;
      const byParent = new Map<string, typeof userOnPremises>();
      for (const r of userOnPremises) {
        const pid = r.parentId ?? (r.data.details as Record<string, string> | undefined)?.parentSiteId;
        if (!pid) continue;
        const arr = byParent.get(pid) ?? [];
        arr.push(r);
        byParent.set(pid, arr);
      }
      for (const [parentSiteId, routers] of byParent) {
        const parent = all.find((n) => n.id === parentSiteId);
        if (!parent) continue;
        // Lowest existing onPremise child inside this zone (relative coords).
        const siblingBottoms = all
          .filter((n) => n.parentId === parentSiteId && n.data.category === 'onPremise')
          .map((n) => n.position.y + ROUTER_H);
        let cursorY = siblingBottoms.length > 0
          ? Math.max(...siblingBottoms) + ROUTER_GAP
          : 40;
        const parentW = (parent.width as number | undefined)
          ?? (parent.style?.width as number | undefined)
          ?? 260;
        const relX = Math.max(20, (parentW - ROUTER_W) / 2);
        for (const router of routers) {
          const placed = (router.data as Record<string, unknown>)?.userPlaced === 'true';
          if (placed) {
            all.push({ ...router, parentId: parentSiteId });
          } else {
            all.push({
              ...router,
              parentId: parentSiteId,
              position: { x: relX, y: cursorY },
            });
            cursorY += ROUTER_H + ROUTER_GAP;
          }
        }
      }
    }

    // ---- Post-process: minimize edge crossings between tgw_vgw and vpc columns ----
    // Reorder VPC nodes within each parent group to match their connected TGW/VGW order.
    // Group by parentId so we don't mix relative coordinate systems across regions.
    const TGW_VGW_CATS = new Set(['tgw', 'vgw']);
    const VPC_CATS_ALIGN = new Set(['vpc', 'vpcGroup']);
    const tgwVgwNodes = all.filter((n) => TGW_VGW_CATS.has(n.data.category));
    const vpcNodes = all.filter((n) => VPC_CATS_ALIGN.has(n.data.category));

    if (tgwVgwNodes.length > 0 && vpcNodes.length > 0) {
      const vpcShifts = new Map<string, number>();

      // Group VPCs by parentId
      const vpcsByParent = new Map<string | undefined, typeof vpcNodes>();
      for (const vpc of vpcNodes) {
        const pid = vpc.parentId;
        if (!vpcsByParent.has(pid)) vpcsByParent.set(pid, []);
        vpcsByParent.get(pid)!.push(vpc);
      }

      const baseEdges = viewMode === 'recommended'
        ? [...currentEdges, ...recommendedEdges]
        : [...currentEdges];

      for (const [pid, groupVpcs] of vpcsByParent) {
        const groupTgws = tgwVgwNodes.filter((n) => n.parentId === pid);
        if (groupTgws.length === 0 || groupVpcs.length === 0) continue;

        const sortedLeft = [...groupTgws].sort((a, b) => a.position.y - b.position.y);
        const leftIds = new Set(sortedLeft.map((n) => n.id));

        const vpcScored = groupVpcs.map((vpc) => {
          const connectedYs: number[] = [];
          for (const e of baseEdges) {
            if (e.target === vpc.id && leftIds.has(e.source)) {
              const src = sortedLeft.find((n) => n.id === e.source);
              if (src) connectedYs.push(src.position.y);
            }
            if (e.source === vpc.id && leftIds.has(e.target)) {
              const tgt = sortedLeft.find((n) => n.id === e.target);
              if (tgt) connectedYs.push(tgt.position.y);
            }
          }
          const avgY = connectedYs.length > 0
            ? connectedYs.reduce((a, b) => a + b, 0) / connectedYs.length
            : vpc.position.y;
          return { vpc, avgY };
        });

        vpcScored.sort((a, b) => a.avgY - b.avgY);
        const vpcYSlots = groupVpcs.map((n) => n.position.y).sort((a, b) => a - b);
        for (let i = 0; i < vpcScored.length; i++) {
          if (vpcYSlots[i] != null) {
            vpcShifts.set(vpcScored[i].vpc.id, vpcYSlots[i]);
          }
        }
      }

      if (vpcShifts.size > 0) {
        all = all.map((node) => {
          const newY = vpcShifts.get(node.id);
          if (newY != null) {
            return { ...node, position: { x: node.position.x, y: newY } };
          }
          return node;
        });
      }
    }

    const mapped = all.map((node) => ({
      ...node,
      selectable: true,
    }));
    // Sort: parents before children by depth (React Flow requires parent nodes to precede children)
    // Depth: 0 = no parent, 1 = direct child of root, 2 = grandchild
    const rootIds = new Set(mapped.filter((n) => !n.parentId).map((n) => n.id));
    mapped.sort((a, b) => {
      const depthA = !a.parentId ? 0 : rootIds.has(a.parentId) ? 1 : 2;
      const depthB = !b.parentId ? 0 : rootIds.has(b.parentId) ? 1 : 2;
      return depthA - depthB;
    });
    return mapped;
  }, [viewMode, currentNodes, recommendedNodes, recommendedCurrentNodes, currentEdges, recommendedEdges, showVpcs, userCustomerSites, hiddenCustomerSiteIds, userOnPremises, hiddenOnPremiseIds]);

  const hiddenNodeIds = useMemo(() => {
    if (showVpcs) return new Set<string>();
    const baseNodes = viewMode === 'recommended' && recommendedCurrentNodes.length > 0
      ? recommendedCurrentNodes
      : currentNodes;
    const all = viewMode === 'recommended' ? [...baseNodes, ...recommendedNodes] : [...baseNodes];
    return new Set(all.filter((n) => VPC_CATEGORIES.has(n.data.category)).map((n) => n.id));
  }, [showVpcs, viewMode, currentNodes, recommendedNodes, recommendedCurrentNodes]);

  const edges = useMemo(() => {
    let all = viewMode === 'recommended'
      ? [...currentEdges, ...recommendedEdges, ...userEdges]
      : [...currentEdges, ...userEdges];

    // Apply edge reconnection overrides
    if (edgeReconnectOverrides.size > 0) {
      all = all.map((e) => {
        const override = edgeReconnectOverrides.get(e.id);
        return override ? { ...e, source: override.source, target: override.target } : e;
      });
    }

    // Remove edges connected to hidden VPC nodes
    if (hiddenNodeIds.size > 0) {
      all = all.filter((e) => !hiddenNodeIds.has(e.source) && !hiddenNodeIds.has(e.target));
    }

    // Remove user-hidden edges (× button on deletable edges)
    if (hiddenEdgeIds.size > 0) {
      all = all.filter((e) => !hiddenEdgeIds.has(e.id));
    }

    // Drop edges whose source/target was a hidden on-prem router
    if (hiddenOnPremiseIds.size > 0) {
      all = all.filter((e) => !hiddenOnPremiseIds.has(e.source) && !hiddenOnPremiseIds.has(e.target));
    }

    return all;
  }, [viewMode, currentEdges, recommendedEdges, hiddenNodeIds, hiddenEdgeIds, edgeReconnectOverrides, userEdges, hiddenOnPremiseIds]);

  const { crossAccountIds, hasCrossAccount } = useMemo(() => {
    const ids = new Set<string>();
    let anyCross = false;
    for (const n of nodes) {
      const details = (n.data as Record<string, Record<string, string> | undefined>)?.details;
      if (details?.crossAccount === 'true') {
        anyCross = true;
        if (details.ownerAccount) ids.add(details.ownerAccount);
      }
    }
    return { crossAccountIds: Array.from(ids).sort(), hasCrossAccount: anyCross };
  }, [nodes]);

  const hasInferredConnection = useMemo(() => {
    return nodes.some((n) => (n.data as Record<string, unknown>)?.isInferred === true);
  }, [nodes]);

  // On-prem → partner-device cables aren't visible to AWS, so we never draw
  // them automatically. If the topology contains a partner device that has
  // no such cable (including any user-drawn edge), surface a hint so users
  // know they can unlock the canvas and wire it themselves.
  const hasUnwiredPartnerDevice = useMemo(() => {
    const partnerIds = new Set(
      nodes.filter((n) => (n.data as Record<string, unknown>)?.category === 'dxPartnerDevice').map((n) => n.id),
    );
    if (partnerIds.size === 0) return false;
    const onPremIds = new Set(
      nodes.filter((n) => (n.data as Record<string, unknown>)?.category === 'onPremise').map((n) => n.id),
    );
    if (onPremIds.size === 0) return false;
    const wired = new Set<string>();
    for (const e of edges) {
      if (partnerIds.has(e.target) && onPremIds.has(e.source)) wired.add(e.target);
      if (partnerIds.has(e.source) && onPremIds.has(e.target)) wired.add(e.source);
    }
    return wired.size < partnerIds.size;
  }, [nodes, edges]);

  // Hint dismissal is intentionally session-only (no localStorage) so a page
  // refresh resurfaces it. Storing *which* topology it was dismissed for (rather
  // than a bare boolean) also resurfaces it on a topology refresh or scenario
  // switch, since those hand us a new object reference.
  const topologyData = useTopologyStore((s) => s.topologyData);
  const [drawHintDismissedFor, setDrawHintDismissedFor] = useState<typeof topologyData>(null);
  const dismissDrawHint = useCallback(() => setDrawHintDismissedFor(topologyData), [topologyData]);
  const drawHintDismissed = topologyData != null && drawHintDismissedFor === topologyData;
  const showDrawHint = hasUnwiredPartnerDevice && !isSimulating && !drawHintDismissed;

  const hasMultipleLegendEntries = viewMode === 'recommended' || hasCrossAccount || hasInferredConnection;
  const showLegend = legendOverride ?? hasMultipleLegendEntries;

  const light = theme === 'light';

  const miniMapNodeColor = useCallback((node: Node) => {
    if (failedNodeIds.has(node.id)) return '#ef4444';
    if ((node.data as Record<string, unknown>)?.isRecommended) return '#10B981';
    if (node.type === 'region') return '#06B6D4';
    return '#8B5CF6';
  }, [failedNodeIds]);

  // Drop any active text selection when the user clicks anywhere outside a
  // .selectable-text region. Listening at the document level also catches
  // clicks on other nodes, the minimap, panels, etc. — not just the empty pane.
  const clearTextSelection = useCallback(() => {
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed) sel.removeAllRanges();
    setSelectedEdgeId(null);
  }, []);

  const onPaneClick = useCallback(() => {
    // Clicking the empty canvas clears any pinned path — matches the "click
    // anywhere else to cancel" cue. Also clears selection state that was
    // previously bound to the pane click.
    clearTextSelection();
    setPinnedNode(null);
  }, [clearTextSelection, setPinnedNode]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.('.selectable-text')) return;
      clearTextSelection();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [clearTextSelection]);

  // Delete/Backspace removes the selected edge, for the same user-drawn edges that
  // carry the × affordance. Both the edge list and the node map have to include
  // the user's own additions: every deletable edge is in `userEdges` by
  // definition, and a customer link can land on a router the user added.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isLocked || isSimulating || !selectedEdgeId) return;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      // Don't intercept when user is typing in an input
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      const allNodes = viewMode === 'recommended' && recommendedCurrentNodes.length > 0
        ? [...recommendedCurrentNodes, ...recommendedNodes, ...userOnPremises]
        : [...currentNodes, ...userOnPremises];
      const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

      const allEdges = viewMode === 'recommended'
        ? [...currentEdges, ...recommendedEdges, ...userEdges]
        : [...currentEdges, ...userEdges];
      const edge = allEdges.find((ed) => ed.id === selectedEdgeId);
      if (!edge) return;

      const srcCat = (nodeMap.get(edge.source)?.data as Record<string, unknown>)?.category as string | undefined;
      const tgtCat = (nodeMap.get(edge.target)?.data as Record<string, unknown>)?.category as string | undefined;
      if (isUserDrawnPair(srcCat, tgtCat)) {
        hideEdge(edge.id);
        setSelectedEdgeId(null);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isLocked, isSimulating, selectedEdgeId, viewMode, currentNodes, currentEdges, recommendedNodes, recommendedEdges, recommendedCurrentNodes, userOnPremises, userEdges, hideEdge]);

  return (
    <div className="relative w-full h-full" style={{
      background: light
        ? '#eef1f6'
        : 'radial-gradient(ellipse at 50% 50%, #131c2e 0%, #0f172a 60%, #0a0f1a 100%)',
    }}>
      {isSimulating && <div className="sim-canvas-frame" aria-hidden="true" />}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onEdgeClick={onEdgeClick}
        onEdgeMouseEnter={onEdgeMouseEnter}
        onEdgeMouseLeave={onEdgeMouseLeave}
        onPaneClick={onPaneClick}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.3}
        maxZoom={2}
        defaultEdgeOptions={{ type: 'customEdge' }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={!isLocked}
        elementsSelectable={!isLocked}
        edgesReconnectable={!isLocked && !isSimulating}
        onReconnect={onReconnect}
        onConnect={onConnect}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color={light ? '#a3acbd' : '#2a3650'} />
        <Controls
          position="top-left"
          showInteractive={false}
          className={light
            ? '!bg-gray-100 !border-gray-300 !shadow-lg [&>button:not(:last-child)]:!bg-gray-200 [&>button:not(:last-child)]:!border-gray-300 [&>button:not(:last-child)]:!text-gray-600 [&>button:not(:last-child):hover]:!bg-gray-300'
            : '!bg-slate-800 !border-slate-600 !shadow-lg [&>button:not(:last-child)]:!bg-slate-700 [&>button:not(:last-child)]:!border-slate-600 [&>button:not(:last-child)]:!text-slate-300 [&>button:not(:last-child):hover]:!bg-slate-600'
          }
        >
          <button
            data-tour="lock"
            onClick={() => setIsLocked(!isLocked)}
            title={isLocked ? 'Unlock canvas' : 'Lock canvas'}
            className={`react-flow__controls-button ${
              isLocked
                ? light
                  ? '!bg-red-50 !text-red-500 !border-red-200 hover:!bg-red-100'
                  : '!bg-red-500/20 !text-red-400 !border-red-500/40 hover:!bg-red-500/30'
                : light
                  ? '!bg-emerald-50 !text-emerald-600 !border-emerald-200 hover:!bg-emerald-100'
                  : '!bg-emerald-500/20 !text-emerald-400 !border-emerald-500/40 hover:!bg-emerald-500/30'
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill={isLocked ? (light ? '#ef4444' : '#f87171') : (light ? '#10b981' : '#34d399')} style={{ maxWidth: 16, maxHeight: 16 }}>
              {isLocked ? (
                <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z" />
              ) : (
                <path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z" />
              )}
            </svg>
          </button>
        </Controls>
        {showDrawHint && (
          <Panel position="top-left" style={{ marginTop: 160 }}>
            <div
              className={`rounded-lg text-[11px] shadow-lg max-w-[260px] ${
                light
                  ? 'bg-gray-100 border border-gray-300 text-gray-700'
                  : 'bg-slate-800/90 border border-slate-600 text-slate-200'
              }`}
              style={{ padding: '8px 10px' }}
            >
              <div className="flex items-start gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 shrink-0 mt-[1px]" style={{ color: light ? '#6b7280' : '#94a3b8' }}>
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
                </svg>
                <div className="flex-1 leading-snug">
                  <div className="opacity-90">
                    The physical link between your router and the partner device falls outside the AWS-managed scope. To represent it on the diagram, unlock the canvas and drag from the right handle of the Customer Gateway to the Partner Device.
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    {isLocked && (
                      <button
                        type="button"
                        onClick={() => setIsLocked(false)}
                        className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                          light
                            ? 'bg-gray-700 text-white hover:bg-gray-800'
                            : 'bg-slate-200 text-slate-900 hover:bg-white'
                        }`}
                      >
                        Unlock canvas
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={dismissDrawHint}
                      className={`text-[10px] underline-offset-2 hover:underline ${
                        light ? 'text-gray-600' : 'text-slate-400'
                      }`}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </Panel>
        )}
        <MiniMap
          pannable
          zoomable
          style={{ width: 140, height: 90 }}
          className={light ? '!bg-gray-200 !border-gray-300' : '!bg-slate-800 !border-slate-600'}
          nodeColor={miniMapNodeColor}
          maskColor={light ? 'rgba(226, 229, 235, 0.8)' : 'rgba(15, 23, 42, 0.8)'}
        />
        <Panel position="top-right">
          <div className={`rounded-lg text-[10px] font-tech ${
            light
              ? 'bg-gray-100/90 border border-gray-300 text-gray-600 shadow-sm'
              : 'bg-slate-800/90 border border-slate-600 text-slate-300 shadow-lg'
          }`}>
            <button
              onClick={() => setLegendOverride(!showLegend)}
              aria-expanded={showLegend}
              aria-label="Toggle legend"
              className={`flex items-center gap-1.5 w-full px-3 py-1.5 cursor-pointer ${
                light ? 'hover:bg-gray-50' : 'hover:bg-slate-700/50'
              } ${showLegend ? 'rounded-t-lg' : 'rounded-lg'}`}
            >
              <span className="font-semibold">Legend</span>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-3 h-3 ml-auto transition-transform ${showLegend ? '' : '-rotate-90'}`}>
                <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
              </svg>
            </button>
            {showLegend && (
              <div className={`flex flex-col gap-1.5 px-3 pb-2 pt-1 ${
                light ? 'border-t border-gray-100' : 'border-t border-slate-700'
              }`}>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded-sm border-2" style={{ borderColor: '#8B5CF6', background: light ? '#F5F3FF' : '#1e1b4b' }} />
                  <span>
                    {homeAccountName && !redactMode ? (
                      <>
                        {homeAccountName}
                        {homeAccountId && <span> ({r(homeAccountId)})</span>}
                      </>
                    ) : (
                      r(homeAccountId)
                    )}
                  </span>
                </div>
                {hasCrossAccount && (
                  <div className="flex items-start gap-2" style={{ maxWidth: 240 }}>
                    <span className="inline-block w-3 h-3 rounded-sm border-2 mt-[2px] shrink-0" style={{ borderColor: light ? '#d97706' : '#F59E0B', background: light ? '#FFFBEB' : '#451a03' }} />
                    <span className="leading-snug">
                      {crossAccountIds.length > 0
                        ? <>Cross-account ({crossAccountIds.map((id) => r(id)).join(', ')})</>
                        : 'Cross-account resource'}
                    </span>
                  </div>
                )}
                {hasInferredConnection && (
                  <div className="flex items-start gap-2" style={{ maxWidth: 240 }}>
                    <span className="inline-block w-3 h-3 rounded-sm border-2 mt-[2px] shrink-0" style={{ borderColor: light ? '#a16207' : '#FACC15', background: light ? '#FEFCE8' : '#422006' }} />
                    <span className="leading-snug">
                      Hosted VIF on external cable
                    </span>
                  </div>
                )}
                {viewMode === 'recommended' && (
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-3 h-3 rounded-sm border-2 border-dashed" style={{ borderColor: '#10B981', background: light ? '#ECFDF5' : '#022c22' }} />
                    <span>Recommendation</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}
