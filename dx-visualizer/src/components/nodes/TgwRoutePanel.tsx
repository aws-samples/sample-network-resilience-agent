import { useCallback, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useReactFlow, useViewport } from '@xyflow/react';
import type { TgwRouteTableWithRoutes } from '../../types/aws-resources';
import { useTopologyStore } from '../../store/topology-store';
import { useRedact } from '../../utils/redact';

interface TgwRoutePanelProps {
  routeTables: TgwRouteTableWithRoutes[];
  onClose: () => void;
  nodeId: string;
}

export function TgwRoutePanel({ routeTables, onClose, nodeId }: TgwRoutePanelProps) {
  const theme = useTopologyStore((s) => s.theme);
  const r = useRedact();
  const light = theme === 'light';
  const { getNode } = useReactFlow();
  const viewport = useViewport();

  // Tab state — each route table is a tab
  const tabNames = routeTables.map((rt) => rt.routeTable.tags.Name || rt.routeTable.transitGatewayRouteTableId);
  const [selectedTab, setSelectedTab] = useState(tabNames[0] ?? '');

  // Selected route table
  const selectedRt = routeTables.find(
    (rt) => (rt.routeTable.tags.Name || rt.routeTable.transitGatewayRouteTableId) === selectedTab,
  );

  // Drag state — offset is the user's drag displacement from the anchor position
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; startOffX: number; startOffY: number } | null>(null);

  const stopProp = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation();
  }, []);

  // Native pointer listeners for dragging
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setOffset({ x: dragRef.current.startOffX + dx, y: dragRef.current.startOffY + dy });
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const onDragStart = useCallback((e: React.PointerEvent) => {
    // Only drag from the header bar, not from scrollable content
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, startOffX: offset.x, startOffY: offset.y };
  }, [offset]);

  const node = getNode(nodeId);
  if (!node) return null;

  // Compute absolute position by walking up the parent chain
  let absX = node.position.x;
  let absY = node.position.y;
  let current = node;
  while (current.parentId) {
    const parent = getNode(current.parentId);
    if (!parent) break;
    absX += parent.position.x;
    absY += parent.position.y;
    current = parent as typeof current;
  }

  const nodeWidth = node.measured?.width ?? node.width ?? 160;
  const nodeHeight = node.measured?.height ?? node.height ?? 60;
  const z = viewport.zoom;

  // Screen position of the panel — aligned to right edge of node + user drag offset
  const panelWidth = 340 * z;
  const screenX = (absX + nodeWidth) * z + viewport.x - panelWidth + offset.x;
  const screenY = (absY + nodeHeight) * z + viewport.y + 4 + offset.y;

  const panelContent = (
    // onClick here only isolates the panel from the React Flow canvas underneath;
    // it is not an activation target, so role/tabIndex would add a bogus tab stop.
    // The Close button is the keyboard path out.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className="fixed tgw-route-scroll"
      style={{
        top: screenY,
        left: screenX,
        width: 340 * z,
        maxHeight: 340 * z,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: light ? '#ffffff' : '#1a0f2e',
        border: `1px solid ${light ? '#e2e5ea' : 'rgba(139,92,246,0.5)'}`,
        borderRadius: 8 * z,
        zIndex: 9999,
        fontSize: `${9 * z}px`,
        boxShadow: light
          ? '0 8px 30px rgba(0,0,0,0.18)'
          : '0 8px 30px rgba(0,0,0,0.8), 0 0 0 1px rgba(139,92,246,0.25)',
        pointerEvents: 'all' as const,
      }}
      onClick={stopProp}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={stopProp}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `${6 * z}px ${10 * z}px`,
          cursor: 'grab',
          borderBottom: `1px solid ${light ? '#e2e5ea' : 'rgba(139,92,246,0.25)'}`,
          flexShrink: 0,
        }}
        onPointerDown={onDragStart}
      >
        <span style={{
          fontSize: `${9.5 * z}px`,
          fontWeight: 600,
          color: light ? '#334155' : '#cbd5e1',
        }}>
          TGW Routes
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); onClose(); }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20 * z,
            height: 20 * z,
            borderRadius: 4 * z,
            border: `1px solid ${light ? '#e2e5ea' : 'rgba(148,163,184,0.25)'}`,
            cursor: 'pointer',
            color: light ? '#64748b' : '#94a3b8',
            backgroundColor: light ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.06)',
            transition: 'background-color 0.15s, color 0.15s, border-color 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = light ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.14)';
            e.currentTarget.style.color = light ? '#334155' : '#e2e8f0';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = light ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.06)';
            e.currentTarget.style.color = light ? '#64748b' : '#94a3b8';
          }}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          title="Close"
        >
          <svg width={8 * z} height={8 * z} viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="1" y1="1" x2="7" y2="7" />
            <line x1="7" y1="1" x2="1" y2="7" />
          </svg>
        </button>
      </div>

      {/* Tab selector */}
      {tabNames.length > 1 && (
        <div style={{
          display: 'flex',
          gap: 4 * z,
          padding: `${6 * z}px ${10 * z}px`,
          borderBottom: `1px solid ${light ? '#e2e5ea' : 'rgba(139,92,246,0.15)'}`,
          flexShrink: 0,
          flexWrap: 'wrap',
        }}>
          {tabNames.map((tab) => (
            <button
              key={tab}
              onClick={(e) => { e.stopPropagation(); setSelectedTab(tab); }}
              onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
              style={{
                fontSize: `${8 * z}px`,
                fontWeight: 600,
                padding: `${2 * z}px ${8 * z}px`,
                borderRadius: 4 * z,
                border: 'none',
                cursor: 'pointer',
                backgroundColor: tab === selectedTab
                  ? (light ? '#8b5cf6' : '#7c3aed')
                  : (light ? 'rgba(139,92,246,0.1)' : 'rgba(139,92,246,0.15)'),
                color: tab === selectedTab
                  ? '#ffffff'
                  : (light ? '#8b5cf6' : '#a78bfa'),
                transition: 'background-color 0.15s, color 0.15s',
              }}
            >
              {tab}
            </button>
          ))}
        </div>
      )}

      {/* Single tab label when only one */}
      {tabNames.length === 1 && (
        <div style={{
          padding: `${4 * z}px ${10 * z}px`,
          borderBottom: `1px solid ${light ? '#e2e5ea' : 'rgba(139,92,246,0.15)'}`,
          flexShrink: 0,
        }}>
          <span style={{
            fontSize: `${8 * z}px`,
            fontWeight: 600,
            padding: `${2 * z}px ${8 * z}px`,
            borderRadius: 4 * z,
            backgroundColor: light ? '#8b5cf6' : '#7c3aed',
            color: '#ffffff',
          }}>
            {tabNames[0]}
          </span>
        </div>
      )}

      {/* Scrollable route list for selected tab */}
      <div style={{ overflowY: 'auto', padding: `${8 * z}px ${10 * z}px` }}>
        {!selectedRt ? (
          <span style={{ color: light ? '#64748b' : '#94a3b8' }}>No route tables found</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 * z }}>
            {selectedRt.routes.map((route, i) => {
              const isBlackhole = route.state === 'blackhole';
              const target = route.transitGatewayAttachments[0];
              const resourceTypeMap: Record<string, string> = {
                'vpc': 'VPC',
                'vpn': 'VPN',
                'direct-connect-gateway': 'DX GW',
                'peering': 'Peering',
              };
              const targetLabel = target
                ? resourceTypeMap[target.resourceType] || target.resourceType
                : '-';
              return (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6 * z,
                    borderRadius: 4 * z,
                    padding: `${2.5 * z}px ${6 * z}px`,
                    backgroundColor: isBlackhole
                      ? (light ? 'rgba(239,68,68,0.08)' : 'rgba(127,29,29,0.3)')
                      : 'transparent',
                  }}
                >
                  <span
                    style={{
                      width: 5 * z,
                      height: 5 * z,
                      borderRadius: '50%',
                      backgroundColor: isBlackhole ? '#ef4444' : '#22c55e',
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontSize: `${9 * z}px`,
                      fontFamily: "'JetBrains Mono', monospace",
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: isBlackhole ? '#ef4444' : (light ? '#334155' : '#cbd5e1'),
                    }}
                  >
                    {r(route.destinationCidrBlock)}
                  </span>
                  <span style={{
                    fontSize: `${7.5 * z}px`,
                    color: light ? '#64748b' : '#94a3b8',
                    whiteSpace: 'nowrap',
                  }}>
                    {targetLabel}
                  </span>
                  <span
                    style={{
                      fontSize: `${7 * z}px`,
                      fontWeight: 700,
                      borderRadius: 2 * z,
                      padding: `0 ${2 * z}px`,
                      backgroundColor: route.type === 'static'
                        ? (light ? 'rgba(59,130,246,0.1)' : 'rgba(59,130,246,0.2)')
                        : (light ? 'rgba(168,85,247,0.1)' : 'rgba(168,85,247,0.2)'),
                      color: route.type === 'static'
                        ? (light ? '#3b82f6' : '#60a5fa')
                        : (light ? '#a855f7' : '#c084fc'),
                    }}
                  >
                    {route.type === 'static' ? 'S' : 'P'}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(panelContent, document.body);
}
