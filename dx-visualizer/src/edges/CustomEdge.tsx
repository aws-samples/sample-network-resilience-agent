import { useRef, useCallback, useState } from 'react';
import { BaseEdge, getBezierPath, getSmoothStepPath, EdgeLabelRenderer, Position, useStore, useStoreApi } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import { COLORS } from '../utils/colors';
import { PEERING_INTRA_OFFSET, PEERING_CROSS_CLEARANCE } from '../utils/constants';
import { parseBandwidthToBps, formatBps } from '../utils/shared';
import { useTopologyStore } from '../store/topology-store';
import { useRedact } from '../utils/redact';
import { isUserDrawnPair } from '../utils/user-edges';

function useNodeCategory(nodeId: string): string | undefined {
  return useTopologyStore((s) => {
    const node = s.currentNodes.find((n) => n.id === nodeId)
      ?? s.userOnPremises.find((n) => n.id === nodeId);
    return node?.data.category;
  });
}

// Mirrors @xyflow/system's getControlWithCurvature so we can evaluate the same
// cubic bezier React Flow renders and place labels on the actual curve when
// labelPosition != 0.5 (e.g. VPN Tunnel). Without this, linear source→target
// interpolation drifts off-curve for Right→Top / L-shaped edges.
const BEZIER_CURVATURE = 0.1;
function calculateControlOffset(distance: number, curvature: number) {
  if (distance >= 0) return 0.5 * distance;
  return curvature * 25 * Math.sqrt(-distance);
}
function getControlPoint(pos: Position, x1: number, y1: number, x2: number, y2: number, c: number): [number, number] {
  switch (pos) {
    case Position.Left:   return [x1 - calculateControlOffset(x1 - x2, c), y1];
    case Position.Right:  return [x1 + calculateControlOffset(x2 - x1, c), y1];
    case Position.Top:    return [x1, y1 - calculateControlOffset(y1 - y2, c)];
    case Position.Bottom: return [x1, y1 + calculateControlOffset(y2 - y1, c)];
  }
}

export function CustomEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
}: EdgeProps) {
  const zoom = useStore((s) => s.transform[2]);
  const storeApi = useStoreApi();
  const r = useRedact();
  const light = useTopologyStore((s) => s.theme) === 'light';
  const showLiveStatus = useTopologyStore((s) => s.showLiveStatus);
  const showUtilization = useTopologyStore((s) => s.showUtilization);
  const utilizationWindowDays = useTopologyStore((s) => s.utilizationWindowDays);
  const [utilHelpOpen, setUtilHelpOpen] = useState(false);
  const isSimulating = useTopologyStore((s) => s.isSimulating);
  const failedEdgeIds = useTopologyStore((s) => s.failedEdgeIds);
  const failedNodeIds = useTopologyStore((s) => s.failedNodeIds);
  const toggleEdgeFailure = useTopologyStore((s) => s.toggleEdgeFailure);
  const isLocked = useTopologyStore((s) => s.isLocked);
  const labelOffset = useTopologyStore((s) => s.edgeLabelOffsets.get(id));
  const setEdgeLabelOffset = useTopologyStore((s) => s.setEdgeLabelOffset);
  const hoveredNodeId = useTopologyStore((s) => s.hoveredNodeId);
  const highlightedEdgeIds = useTopologyStore((s) => s.highlightedEdgeIds);
  const isSpotlit = useTopologyStore((s) => s.spotlightEdgeIds.has(id));
  const setHoveredNode = useTopologyStore((s) => s.setHoveredNode);
  const setHoveredEdge = useTopologyStore((s) => s.setHoveredEdge);
  const hideEdge = useTopologyStore((s) => s.hideEdge);
  const isHiddenEdge = useTopologyStore((s) => s.hiddenEdgeIds.has(id));
  const sourceCat = useNodeCategory(source);
  const targetCat = useNodeCategory(target);
  // Only user-drawn edges are deletable, and the connect rules decide which those
  // are — so the × appears on exactly the edges the canvas can create and on
  // nothing the AWS APIs reported.
  const isDeletableEdge = isUserDrawnPair(sourceCat, targetCat);
  const hasHoverActive = hoveredNodeId != null;
  const isEdgeHighlighted = hasHoverActive && highlightedEdgeIds.has(id);
  // Don't fade deletable edges — their × affordance must stay readable/clickable.
  const isEdgeDimmed = hasHoverActive && !isEdgeHighlighted && !isDeletableEdge;
  const isRecommended = data?.isRecommended;
  const isInferred = data?.isInferred;
  const isPeering = data?.isPeering;
  // Peering edges are point-to-point: hovering the label highlights only this
  // edge + its two endpoints. All other edges highlight their full E2E path.
  const onLabelEnter = () => {
    if (isSimulating) return;
    if (isPeering) setHoveredEdge(id, source, target);
    else setHoveredNode(source);
  };
  const onLabelLeave = () => {
    if (isPeering) setHoveredEdge(null);
    else setHoveredNode(null);
  };
  const vifType = data?.vifType as 'private' | 'transit' | 'public' | undefined;
  const label = data?.label as string | undefined;
  const labelPosition = (data?.labelPosition as number | undefined) ?? 0.5;
  const tunnels = data?.tunnels as { outsideIpAddress: string; status: 'UP' | 'DOWN' }[] | undefined;
  const connectionState = data?.connectionState as string | undefined;
  const vifState = data?.vifState as string | undefined;
  const bgpStatus = data?.bgpStatus as string | undefined;
  const prefixesAccepted = data?.prefixesAccepted as number | undefined;
  const prefixesAdvertised = data?.prefixesAdvertised as number | undefined;
  const utilizationIngressBps = data?.utilizationIngressBps as number | undefined;
  const utilizationEgressBps = data?.utilizationEgressBps as number | undefined;
  const connectionBandwidth = data?.connectionBandwidth as string | undefined;
  const aggregatedVifs = data?.aggregatedVifs as { vifId: string; vifType: string; vlan: number; vifState: string; bgpStatus?: string; prefixesAccepted?: number; prefixesAdvertised?: number; utilizationIngressBps?: number; utilizationEgressBps?: number; connectionBandwidth?: string }[] | undefined;
  const [vifListExpanded, setVifListExpanded] = useState(false);
  const edgeStyleKind = data?.edgeStyle as 'smoothstep' | undefined;

  // Parallel-edge bowing: several edges connect the SAME two nodes (customer
  // gateway → LAG members), all sharing a single source dot and a single target
  // dot. We bow each edge symmetrically off the straight chord by its parallel
  // index so they render as distinct arcs — and their labels, which ride the arc
  // midpoints, separate vertically instead of stacking. BOW_SPACING is the
  // vertical gap between adjacent labels; sized to clear a ~4-line DX Connection
  // label. `bowCpOffset` is the control-point shift needed for the cubic bezier
  // midpoint (0.75·cp) to land exactly `bowY` off-chord.
  const parallelIndex = data?.parallelIndex as number | undefined;
  const parallelCount = data?.parallelCount as number | undefined;
  const BOW_SPACING = 72;
  const bowY =
    parallelCount != null && parallelCount > 1 && parallelIndex != null
      ? (parallelIndex - (parallelCount - 1) / 2) * BOW_SPACING
      : 0;
  const bowCpOffset = bowY / 0.75;
  const isVifDown = vifType && (
    (vifState && !/available/i.test(vifState)) ||
    (bgpStatus && !/up/i.test(bgpStatus))
  );
  const isVifUp = vifType && vifState && /available/i.test(vifState) && (!bgpStatus || /up/i.test(bgpStatus));
  const allTunnelsDown = tunnels && tunnels.length > 0 && tunnels.every((t) => t.status === 'DOWN');
  const anyTunnelUp = tunnels && tunnels.length > 0 && tunnels.some((t) => t.status === 'UP');
  const isConnectionDown = connectionState && !/available|associated|active|ordering|requested|pending|allocated|associating|updating|provisioning|initiating-request|pending-acceptance/i.test(connectionState);
  const isConnectionUp = connectionState && /^(available|associated|active)$/i.test(connectionState);

  const isFailed = failedEdgeIds.has(id) || failedNodeIds.has(source) || failedNodeIds.has(target);
  const isAffected = isSimulating && !isFailed && (failedNodeIds.size > 0 || failedEdgeIds.size > 0);

  // For smoothstep peering edges (TGW↔TGW left-exit, VPC↔VPC right-exit, Cloud
  // WAN↔TGW) the vertical leg must sit well outside any region container that
  // the edge's y-span crosses, otherwise the edge cuts across the container's
  // border and looks like it's piercing the region box.
  //
  // The bulge direction follows the source/target handle positions: peering-left
  // bulges LEFT (clear regions on the left), peering-right bulges RIGHT (clear
  // regions on the right). Floor of 120px keeps short peerings looking roomy.
  //
  // EXCEPTION — intra-region VPC↔VPC peering: both endpoints live in the SAME
  // region, so the leg must stay INSIDE that region box, not clear it. We use a
  // small fixed offset and skip the region-clearing scan entirely. The layout
  // engine reserves PEERING_INTRA_LANE of right-side width in the region for
  // exactly this leg + its label. Using a constant (not the scan) is essential:
  // a scan-derived offset would chase the widened region outward every relayout.
  const isIntraPeering = data?.peeringScope === 'intra';
  let smoothstepOffset = isIntraPeering ? PEERING_INTRA_OFFSET : 120;
  if (edgeStyleKind === 'smoothstep' && !isIntraPeering) {
    const rfState = storeApi.getState();
    const nodeLookup = (rfState as unknown as { nodeLookup?: Map<string, { internals: { positionAbsolute: { x: number; y: number } }; measured?: { width?: number; height?: number }; width?: number; height?: number; type?: string; data?: { category?: string } }> }).nodeLookup;
    if (nodeLookup) {
      const yMin = Math.min(sourceY, targetY);
      const yMax = Math.max(sourceY, targetY);
      const xMin = Math.min(sourceX, targetX);
      const xMax = Math.max(sourceX, targetX);
      const exitsLeft = sourcePosition === Position.Left && targetPosition === Position.Left;
      const exitsRight = sourcePosition === Position.Right && targetPosition === Position.Right;
      const CLEARANCE = PEERING_CROSS_CLEARANCE; // breathing room between vertical leg and region box
      for (const [, n] of nodeLookup) {
        if (n.data?.category !== 'region') continue;
        const abs = n.internals?.positionAbsolute;
        if (!abs) continue;
        const h = n.measured?.height ?? n.height ?? 0;
        const w = n.measured?.width ?? n.width ?? 0;
        // Only consider regions the edge's y-span actually crosses.
        if (abs.y > yMax || abs.y + h < yMin) continue;
        let needed = 0;
        if (exitsLeft && abs.x < xMin) {
          needed = xMin - abs.x + CLEARANCE;
        } else if (exitsRight && abs.x + w > xMax) {
          needed = (abs.x + w) - xMax + CLEARANCE;
        }
        if (needed > smoothstepOffset) smoothstepOffset = needed;
      }
    }
  }

  const [defaultPath, defaultLabelX, defaultLabelY] = edgeStyleKind === 'smoothstep'
    ? getSmoothStepPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition,
        targetPosition,
        borderRadius: 12,
        offset: smoothstepOffset,
      })
    : getBezierPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition,
        targetPosition,
        curvature: BEZIER_CURVATURE,
      });

  // Shift label along the edge path when labelPosition != 0.5 by evaluating the
  // actual cubic bezier at t. Linear chord interpolation drifts off the curve
  // whenever source/target have a large Y separation (e.g. ghost VIF edges from
  // an off-column AWS Device to a distant DX Gateway), because the bezier exits
  // horizontally from Right/Left handles before bending toward the target.
  const t = labelPosition;
  const evalBezierAt = (tCandidate: number): [number, number] => {
    const [cp1x, cp1y] = getControlPoint(sourcePosition, sourceX, sourceY, targetX, targetY, BEZIER_CURVATURE);
    const [cp2x, cp2y] = getControlPoint(targetPosition, targetX, targetY, sourceX, sourceY, BEZIER_CURVATURE);
    const mt = 1 - tCandidate;
    const b0 = mt * mt * mt;
    const b1 = 3 * mt * mt * tCandidate;
    const b2 = 3 * mt * tCandidate * tCandidate;
    const b3 = tCandidate * tCandidate * tCandidate;
    return [
      b0 * sourceX + b1 * cp1x + b2 * cp2x + b3 * targetX,
      b0 * sourceY + b1 * cp1y + b2 * cp2y + b3 * targetY,
    ];
  };
  let baseLabelX = defaultLabelX;
  let baseLabelY = defaultLabelY;
  if (t !== 0.5 && edgeStyleKind !== 'smoothstep') {
    [baseLabelX, baseLabelY] = evalBezierAt(t);
  }
  // Bowed parallel edge: put the label on the arc midpoint so each member's
  // label sits BOW_SPACING apart vertically.
  if (bowY !== 0) {
    baseLabelX = (sourceX + targetX) / 2;
    baseLabelY = (sourceY + targetY) / 2 + bowY;
  }

  // Collision-avoidance: when the label would sit on top of an unrelated node,
  // try alternative positions along the edge path. Skipped if the user has dragged
  // the label manually (their offset wins), while simulating (styling takes over),
  // or on bowed parallel edges (the bow already separates their labels).
  let avoidX = baseLabelX;
  let avoidY = baseLabelY;
  if (!labelOffset && label && !isSimulating && bowY === 0) {
    const LABEL_HALF_W = 80; // approximate half-width — caps at the 160px max-width we set on the label box
    const LABEL_HALF_H = 14; // approximate half-height
    const PAD = 4;           // minimum breathing room around the label

    const rfState = storeApi.getState();
    const nodeLookup = (rfState as unknown as { nodeLookup?: Map<string, { internals: { positionAbsolute: { x: number; y: number } }; measured?: { width?: number; height?: number }; width?: number; height?: number }> }).nodeLookup;

    if (nodeLookup && nodeLookup.size > 0) {
      type Rect = { x: number; y: number; w: number; h: number };
      const nodeRects: Rect[] = [];
      for (const [nid, n] of nodeLookup) {
        if (nid === source || nid === target) continue;
        const abs = n.internals?.positionAbsolute;
        if (!abs) continue;
        const w = n.measured?.width ?? n.width ?? 120;
        const h = n.measured?.height ?? n.height ?? 50;
        nodeRects.push({ x: abs.x, y: abs.y, w, h });
      }

      const rectIntersects = (lx: number, ly: number) => {
        const left = lx - LABEL_HALF_W - PAD;
        const right = lx + LABEL_HALF_W + PAD;
        const top = ly - LABEL_HALF_H - PAD;
        const bottom = ly + LABEL_HALF_H + PAD;
        for (const r of nodeRects) {
          if (left < r.x + r.w && right > r.x && top < r.y + r.h && bottom > r.y) {
            return true;
          }
        }
        return false;
      };

      if (rectIntersects(baseLabelX, baseLabelY)) {
        // Walk candidates around the current t — prefer nearby positions first.
        const base = t;
        const candidates = [0.5, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75]
          .filter((c) => Math.abs(c - base) > 0.01);
        let chosen: [number, number] | null = null;
        for (const c of candidates) {
          const [cx, cy] = evalBezierAt(c);
          if (!rectIntersects(cx, cy)) {
            chosen = [cx, cy];
            break;
          }
        }
        if (!chosen) {
          // Perpendicular fallback: nudge the label off the edge tangent.
          const edgeDx = targetX - sourceX;
          const edgeDy = targetY - sourceY;
          const len = Math.hypot(edgeDx, edgeDy) || 1;
          const perpX = -edgeDy / len;
          const perpY = edgeDx / len;
          const offset = LABEL_HALF_H * 2 + PAD * 2;
          const up: [number, number] = [baseLabelX + perpX * offset, baseLabelY + perpY * offset];
          const down: [number, number] = [baseLabelX - perpX * offset, baseLabelY - perpY * offset];
          chosen = rectIntersects(up[0], up[1]) ? (rectIntersects(down[0], down[1]) ? null : down) : up;
        }
        if (chosen) {
          [avoidX, avoidY] = chosen;
        }
      }
    }
  }

  // Apply user drag offset to label and bend the edge to follow
  const dx = labelOffset?.dx ?? 0;
  const dy = labelOffset?.dy ?? 0;
  const labelX = avoidX + dx;
  const labelY = avoidY + dy;

  let edgePath = defaultPath;
  if ((dx !== 0 || dy !== 0) && edgeStyleKind !== 'smoothstep') {
    // Recompute bezier with control points shifted by the drag offset so the edge bends with the label
    const hDist = Math.abs(targetX - sourceX) || 1;
    const curvature = Math.max(hDist * 0.25, 30);
    const cp1x = sourceX + curvature + dx;
    const cp1y = sourceY + dy;
    const cp2x = targetX - curvature + dx;
    const cp2y = targetY + dy;
    edgePath = `M ${sourceX},${sourceY} C ${cp1x},${cp1y} ${cp2x},${cp2y} ${targetX},${targetY}`;
  } else if (bowY !== 0) {
    // Bow the edge symmetrically off the straight chord. Both control points are
    // lifted by bowCpOffset (+ any drag dy) so the cubic peaks at bowY at t=0.5,
    // giving each parallel member its own arc from the shared source/target dots.
    const cp1x = sourceX + (targetX - sourceX) / 3;
    const cp2x = sourceX + (2 * (targetX - sourceX)) / 3;
    const cpY = (sourceY + targetY) / 2 + bowCpOffset + dy;
    edgePath = `M ${sourceX},${sourceY} C ${cp1x + dx},${cpY} ${cp2x + dx},${cpY} ${targetX},${targetY}`;
  }

  const baseEdgeColor = light ? COLORS.light.edge : COLORS.existing.edge;
  const inferredColor = '#facc15';
  // Base color for label borders and icons — always uses the default color, ignoring live status
  const baseLabelBorderColor = isFailed
    ? '#ef4444'
    : isRecommended
      ? COLORS.recommended.edge
      : isInferred
        ? inferredColor
        : vifType
          ? (light ? '#8b6ad0' : COLORS.vifTypes[vifType])
          : (style?.stroke as string) ?? baseEdgeColor;
  const hasStatusIssue = showLiveStatus && (isVifDown || allTunnelsDown || isConnectionDown);
  const hasStatusHealthy = showLiveStatus && !hasStatusIssue && (isVifUp || anyTunnelUp || isConnectionUp);
  const strokeColor = isEdgeHighlighted
    ? '#3b82f6'
    : isFailed
      ? '#ef4444'
      : isAffected
        ? '#22c55e'
        : isRecommended
          ? COLORS.recommended.edge
          : hasStatusIssue
            ? '#ef4444'
            : hasStatusHealthy
              ? '#22c55e'
              : isInferred
                ? inferredColor
                : vifType
                  ? (light ? '#8b6ad0' : COLORS.vifTypes[vifType])
                  : (style?.stroke as string) ?? baseEdgeColor;

  // Scale animation duration by path length so visual speed is consistent across all edges.
  // For smoothstep peering edges the path detours around region boxes, so we add the
  // outbound + return horizontal travel of the offset; otherwise the Manhattan estimate
  // undercounts and the dot visibly speeds up vs neighboring edges.
  const SPEED = 200; // pixels per second — consistent travel speed
  let pathLength: number;
  if (edgeStyleKind === 'smoothstep') {
    pathLength = Math.abs(targetY - sourceY) + Math.abs(targetX - sourceX) + 2 * smoothstepOffset;
  } else if (bowY !== 0) {
    // Bowed parallel LAG-member edges arc well off the straight chord, so the
    // Manhattan estimate undercounts their length and their dot races ahead of
    // neighboring edges. Measure the actual cubic-bezier arc (same control
    // points used to draw the bow above) so the dot travels at SPEED like the rest.
    const cp1x = sourceX + (targetX - sourceX) / 3 + dx;
    const cp2x = sourceX + (2 * (targetX - sourceX)) / 3 + dx;
    const cpY = (sourceY + targetY) / 2 + bowCpOffset + dy;
    const SAMPLES = 24;
    let len = 0;
    let px = sourceX, py = sourceY;
    for (let i = 1; i <= SAMPLES; i++) {
      const tt = i / SAMPLES;
      const mt = 1 - tt;
      const a = mt * mt * mt, b = 3 * mt * mt * tt, c = 3 * mt * tt * tt, d = tt * tt * tt;
      const x = a * sourceX + b * cp1x + c * cp2x + d * targetX;
      const y = a * sourceY + b * cpY + c * cpY + d * targetY;
      len += Math.hypot(x - px, y - py);
      px = x; py = y;
    }
    pathLength = len;
  } else {
    pathLength = Math.abs(targetX - sourceX) + Math.abs(targetY - sourceY);
  }
  const duration = Math.max(1, pathLength / SPEED); // minimum 1s

  // --- Drag logic for edge labels ---
  const dragRef = useRef<{ startX: number; startY: number; origDx: number; origDy: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (isLocked || isSimulating) return; // don't drag while locked or simulating
      e.stopPropagation();
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origDx: labelOffset?.dx ?? 0,
        origDy: labelOffset?.dy ?? 0,
      };
    },
    [isLocked, isSimulating, labelOffset],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;
      e.stopPropagation();
      // Divide by zoom to convert screen pixels to flow coordinates
      const z = zoom || 1;
      const dx = dragRef.current.origDx + (e.clientX - dragRef.current.startX) / z;
      const dy = dragRef.current.origDy + (e.clientY - dragRef.current.startY) / z;
      setEdgeLabelOffset(id, dx, dy);
    },
    [id, setEdgeLabelOffset, zoom],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;
      e.stopPropagation();
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      dragRef.current = null;
    },
    [],
  );

  return (
    <>
      {/* Invisible wider hit area for clicking edges in simulation mode */}
      {isSimulating && !isRecommended && (
        <path
          d={edgePath}
          fill="none"
          stroke="transparent"
          strokeWidth={16}
          style={{ cursor: 'pointer' }}
          onClick={() => toggleEdgeFailure(id)}
        />
      )}
      {/* Spotlight halo — mirrors `.node-spotlight` ring on nodes so the
          maintenance-calendar dxvif-* chip points at the actual VIF edge,
          not the DXGW it terminates on. Renders below the BaseEdge so the
          underlying line stays readable. */}
      {isSpotlit && (
        <>
          <path
            d={edgePath}
            fill="none"
            stroke="#ffffff"
            strokeWidth={6}
            strokeLinecap="round"
            opacity={1}
            strokeDasharray="14 6"
            className="edge-spotlight-march"
            style={{ pointerEvents: 'none' }}
          />
        </>
      )}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          strokeWidth: isHiddenEdge ? 1.5 : isEdgeHighlighted ? 3.5 : isFailed ? 3 : light ? 2.5 : 2,
          strokeDasharray: isHiddenEdge ? '4 4' : isFailed ? '6 3' : isRecommended ? '8 4' : undefined,
          opacity: isHiddenEdge
            ? 0.25
            : isEdgeDimmed
              ? 0.15
              : isEdgeHighlighted
                ? 1
                : isFailed ? 0.5 : isRecommended ? 0.7 : (light ? 1 : 0.8),
          ...style,
          stroke: strokeColor,
          pointerEvents: isSimulating && !isRecommended ? 'stroke' : undefined,
          cursor: isSimulating && !isRecommended ? 'pointer' : undefined,
        }}
        className={isRecommended ? 'recommended-edge' : undefined}
        interactionWidth={isSimulating ? 20 : undefined}
      />
      {/* Animated dot traveling along the edge path */}
      {!isRecommended && !isFailed && !isHiddenEdge && (
        <circle
          r="2.5"
          fill={strokeColor}
          opacity={0.9}
          style={{
            offsetPath: `path('${edgePath}')`,
            offsetDistance: '0%',
            animation: `edge-dot-flow ${duration.toFixed(1)}s linear infinite`,
          } as React.CSSProperties}
        />
      )}
      {(() => {
        // Detail rows (VIF/BGP status, prefixes, utilization) render
        // structurally from raw data fields. The VIF/BGP status block
        // requires a vifType; prefix and utilization rows render for any
        // edge that carries them — including the Partner → AWS Device link
        // which now exposes connection-level CloudWatch utilization.
        const hasVifStatusRow = !!vifType && showLiveStatus && (!!vifState || !!bgpStatus);
        const hasPrefixData = prefixesAccepted != null || prefixesAdvertised != null;
        const hasPrefixRow = showLiveStatus && !!vifType && (hasPrefixData || hasVifStatusRow);
        const hasUtilRow = showUtilization && (utilizationIngressBps != null || utilizationEgressBps != null);
        const hasDetailRows = hasVifStatusRow || hasPrefixRow || hasUtilRow;
        const labelHasVisibleLine = !!label && (showLiveStatus || label.split('\n').some((line) => !/^(VIF|BGP|State):\s/i.test(line)));
        const tunnelsVisible = showLiveStatus && !!tunnels && tunnels.length > 0;
        if (!labelHasVisibleLine && !tunnelsVisible && !hasDetailRows) return null;

        const headerColor = vifType
          ? (light ? (vifType === 'public' ? '#0284c7' : '#9d7be8') : (vifType === 'public' ? '#38bdf8' : COLORS.vifTypes[vifType]))
          : baseLabelBorderColor;
        const subTextColor = light ? '#64748b' : '#94a3b8';
        const idColor = light ? '#1e293b' : '#e2e8f0';
        const statusColorOf = (val: string | undefined): string => {
          if (!val) return '#94a3b8';
          if (/\b(available|associated|active|up)\b/i.test(val)) return '#22c55e';
          if (/\b(ordering|requested|pending|allocated|associating|updating|confirming|verifying|provisioning|initiating-request|pending-acceptance)\b/i.test(val)) return '#f59e0b';
          return '#ef4444';
        };

        const capBps = parseBandwidthToBps(connectionBandwidth);
        const peakBps = Math.max(utilizationIngressBps ?? 0, utilizationEgressBps ?? 0);
        const utilPct = capBps && capBps > 0 && peakBps > 0 ? (peakBps / capBps) * 100 : null;
        const utilColor = utilPct == null
          ? subTextColor
          : utilPct > 80 ? '#ef4444'
          : utilPct >= 50 ? '#f59e0b'
          : (light ? '#0d9488' : '#2dd4bf');

        return (
        <EdgeLabelRenderer>
          <div
            className={`absolute rounded px-1.5 py-0.5 text-[9px] font-medium text-center leading-tight nopan nodrag nowheel font-tech${isLocked && !isSimulating ? ' selectable-text' : ''}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              backgroundColor: light ? 'rgba(255,255,255,0.97)' : '#0f172a',
              border: `1px solid ${light ? 'rgba(15,23,42,0.10)' : baseLabelBorderColor + '40'}`,
              boxShadow: light ? '0 1px 2px rgba(15,23,42,0.06), 0 2px 8px rgba(15,23,42,0.06)' : undefined,
              borderRadius: 6,
              zIndex: 1001,
              cursor: isSimulating ? undefined : isLocked ? 'text' : 'grab',
              userSelect: isLocked && !isSimulating ? 'text' : 'none',
              pointerEvents: 'all',
              opacity: isEdgeDimmed ? 0.2 : 1,
              maxWidth: hasUtilRow ? 220 : 180,
              overflowWrap: 'anywhere',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onMouseEnter={onLabelEnter}
            onMouseLeave={onLabelLeave}
          >
            {label ? (
              label.split('\n').map((line, i) => {
                const isStatusLine = /^(VIF|BGP|State):\s/i.test(line);
                if (!showLiveStatus && isStatusLine) return null;
                const sColor = statusColorOf(line.split(':').slice(1).join(':'));
                const isCidr = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(line.trim());
                const color = isStatusLine
                  ? sColor
                  : i === 0 ? headerColor
                  : (i === 1 || isCidr) ? idColor
                  : subTextColor;
                return (
                  <div key={i} className={isStatusLine ? 'flex items-center justify-center gap-1' : undefined} style={{ color }}>
                    {isStatusLine && (
                      <span style={{
                        width: 6, height: 6, borderRadius: '50%', display: 'inline-block',
                        backgroundColor: sColor, flexShrink: 0,
                      }} />
                    )}
                    {r(line)}
                  </div>
                );
              })
            ) : null}

            {hasDetailRows && (
              <div className="flex flex-col gap-0.5 mt-0.5">
                {hasVifStatusRow && (vifState || bgpStatus) && (
                  <div className="flex items-center justify-center gap-2">
                    {vifState && (
                      <span className="flex items-center gap-1" style={{ color: statusColorOf(vifState) }}>
                        <span style={{
                          width: 6, height: 6, borderRadius: '50%', display: 'inline-block',
                          backgroundColor: statusColorOf(vifState), flexShrink: 0,
                        }} />
                        VIF {vifState.toLowerCase()}
                      </span>
                    )}
                    {bgpStatus && (
                      <span className="flex items-center gap-1" style={{ color: statusColorOf(bgpStatus) }}>
                        <span style={{
                          width: 6, height: 6, borderRadius: '50%', display: 'inline-block',
                          backgroundColor: statusColorOf(bgpStatus), flexShrink: 0,
                        }} />
                        BGP {bgpStatus.toLowerCase()}
                      </span>
                    )}
                  </div>
                )}

                {hasPrefixRow && (
                  <div
                    className="flex items-center justify-center gap-2"
                    style={{ color: hasPrefixData ? (light ? '#6366f1' : '#818cf8') : (light ? '#94a3b8' : '#64748b'), fontVariantNumeric: 'tabular-nums' }}
                    title="BGP prefixes accepted from peer / advertised to peer"
                  >
                    <span>Pfx</span>
                    {hasPrefixData ? (
                      <>
                        {prefixesAccepted != null && (
                          <span>{prefixesAccepted} <span style={{ opacity: 0.7 }}>accepted</span></span>
                        )}
                        {prefixesAdvertised != null && (
                          <span>{prefixesAdvertised} <span style={{ opacity: 0.7 }}>advertised</span></span>
                        )}
                      </>
                    ) : (
                      <span style={{ opacity: 0.6, fontStyle: 'italic' }}>no data</span>
                    )}
                  </div>
                )}

                {hasUtilRow && (
                  <div className="flex flex-col gap-0.5 relative">
                    <div className="flex items-center justify-center gap-1" style={{ color: utilColor, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {utilizationIngressBps != null && (
                        <span style={{ whiteSpace: 'nowrap' }}>{formatBps(utilizationIngressBps)}&nbsp;ingress</span>
                      )}
                      {utilizationEgressBps != null && (
                        <span style={{ whiteSpace: 'nowrap' }}>{formatBps(utilizationEgressBps)}&nbsp;egress</span>
                      )}
                      {utilPct != null && (
                        <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                          {utilPct >= 10 ? utilPct.toFixed(0) : utilPct.toFixed(1)}%
                        </span>
                      )}
                      <button
                        type="button"
                        onMouseEnter={() => setUtilHelpOpen(true)}
                        onMouseLeave={() => setUtilHelpOpen(false)}
                        onFocus={() => setUtilHelpOpen(true)}
                        onBlur={() => setUtilHelpOpen(false)}
                        aria-label="What does this mean?"
                        className="nodrag nopan flex items-center justify-center"
                        style={{
                          width: 11, height: 11, borderRadius: '50%',
                          border: `1px solid ${subTextColor}`,
                          color: subTextColor,
                          fontSize: 8, fontWeight: 700, lineHeight: 1,
                          background: 'transparent',
                          cursor: 'help',
                          padding: 0,
                          flexShrink: 0,
                        }}
                      >
                        ?
                      </button>
                    </div>
                    {utilHelpOpen && (
                      <div
                        className="absolute left-1/2 -translate-x-1/2 nodrag nopan font-tech text-left"
                        style={{
                          bottom: 'calc(100% + 6px)',
                          width: 240,
                          padding: '8px 10px',
                          borderRadius: 6,
                          backgroundColor: light ? '#0f172a' : '#1e293b',
                          color: '#e2e8f0',
                          border: `1px solid ${light ? 'rgba(15,23,42,0.4)' : 'rgba(148,163,184,0.3)'}`,
                          boxShadow: '0 4px 12px rgba(15,23,42,0.4)',
                          fontSize: 9,
                          lineHeight: 1.4,
                          fontWeight: 400,
                          zIndex: 1100,
                          pointerEvents: 'none',
                        }}
                      >
                        <div style={{ fontWeight: 600, marginBottom: 6 }}>{utilizationWindowDays}-Day Peak Utilization</div>
                        <div style={{ marginBottom: 6 }}>
                          <span style={{ fontWeight: 600 }}>Peak definition:</span> Represents the single highest-utilization hour observed within the {utilizationWindowDays}-day window — not an average. Utilization during other hours may have been significantly lower.
                        </div>
                        <div style={{ marginBottom: 6 }}>
                          <span style={{ fontWeight: 600 }}>Directional capacity:</span> The percentage reflects the busier direction (ingress or egress) relative to total port bandwidth. Because capacity is shared, the higher-traffic direction determines the saturation point.
                        </div>
                        <div>
                          <span style={{ fontWeight: 600 }}>Data granularity:</span> Each data point is a 1-hour average. As a result, sub-hour microbursts may appear as only a few percent and should not be interpreted as representative of actual peak load.
                        </div>
                      </div>
                    )}
                    {utilPct != null && (
                      <div
                        style={{
                          width: '100%',
                          height: 3,
                          borderRadius: 2,
                          backgroundColor: light ? 'rgba(15,23,42,0.08)' : 'rgba(148,163,184,0.18)',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: `${Math.min(100, utilPct)}%`,
                            height: '100%',
                            backgroundColor: utilColor,
                            transition: 'width 200ms ease-out',
                          }}
                        />
                      </div>
                    )}
                    <div style={{ color: subTextColor, fontSize: 8, lineHeight: 1.1 }}>
                      {utilizationWindowDays}d peak{capBps ? ` · of ${connectionBandwidth} port` : ''}
                    </div>
                  </div>
                )}
              </div>
            )}

            {showLiveStatus && tunnels && tunnels.length > 0 && (
              <div className="flex flex-col gap-0.5 mt-0.5">
                {tunnels.map((tun, i) => (
                  <div key={i} className="flex items-center gap-1 text-[8px]" style={{ color: subTextColor }}>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        display: 'inline-block',
                        backgroundColor: tun.status === 'UP' ? '#22c55e' : '#ef4444',
                        flexShrink: 0,
                      }}
                    />
                    <span>Tunnel {i + 1}</span>
                    <span style={{ color: tun.status === 'UP' ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                      {tun.status}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {aggregatedVifs && aggregatedVifs.length > 1 && (
              <div className="mt-0.5">
                <button
                  type="button"
                  className="nodrag nopan text-[8px] w-full text-center"
                  style={{ color: light ? '#6366f1' : '#818cf8', cursor: 'pointer', background: 'none', border: 'none', padding: '1px 0' }}
                  onClick={(e) => { e.stopPropagation(); setVifListExpanded(!vifListExpanded); }}
                >
                  {vifListExpanded ? '▾ Hide details' : '▸ Show all VIFs'}
                </button>
                {vifListExpanded && (
                  <div className="flex flex-col gap-0.5 mt-0.5" style={{ maxHeight: 200, overflowY: 'auto' }}>
                    {aggregatedVifs.map((av) => {
                      const avStatusColor = /available/i.test(av.vifState) ? '#22c55e' : '#ef4444';
                      const avBgpColor = av.bgpStatus ? (/up/i.test(av.bgpStatus) ? '#22c55e' : '#ef4444') : '#94a3b8';
                      return (
                        <div key={av.vifId} className="flex items-center gap-1 text-[8px]" style={{ color: subTextColor }}>
                          <span style={{ width: 5, height: 5, borderRadius: '50%', display: 'inline-block', backgroundColor: avStatusColor, flexShrink: 0 }} />
                          <span style={{ color: idColor }}>{r(av.vifId)}</span>
                          <span>V{av.vlan}</span>
                          {showLiveStatus && av.bgpStatus && (
                            <span style={{ color: avBgpColor, fontWeight: 600 }}>BGP {av.bgpStatus}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </EdgeLabelRenderer>
        );
      })()}
      {isDeletableEdge && !isLocked && !isSimulating && !isRecommended && !isHiddenEdge && (
        <EdgeLabelRenderer>
          <button
            className="absolute nodrag nopan edge-delete-btn flex items-center justify-center"
            style={{
              transform: `translate(-50%, -50%) translate(${(sourceX + targetX) / 2}px, ${(sourceY + targetY) / 2 - 16}px)`,
              width: 16,
              height: 16,
              borderRadius: '50%',
              border: `1px solid ${light ? '#dc2626' : '#ef4444'}`,
              backgroundColor: light ? 'rgba(255,255,255,0.95)' : 'rgba(15,23,42,0.9)',
              color: light ? '#dc2626' : '#ef4444',
              cursor: 'pointer',
              padding: 0,
              pointerEvents: 'all',
              zIndex: 1002,
              transition: 'color 120ms, border-color 120ms, background-color 120ms',
            }}
            title="Remove this connection"
            onClick={(e) => {
              e.stopPropagation();
              hideEdge(id);
            }}
            onMouseEnter={onLabelEnter}
            onMouseLeave={onLabelLeave}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="2.5" y1="2.5" x2="7.5" y2="7.5" />
              <line x1="7.5" y1="2.5" x2="2.5" y2="7.5" />
            </svg>
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
