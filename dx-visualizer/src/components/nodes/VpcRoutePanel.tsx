import { useCallback, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useReactFlow, useViewport } from '@xyflow/react';
import type { VpcRouteTable, VpcRoute } from '../../types/aws-resources';
import { useTopologyStore } from '../../store/topology-store';
import { useRedact } from '../../utils/redact';

interface VpcRoutePanelProps {
  routeTables: VpcRouteTable[];
  onClose: () => void;
  nodeId: string;
}

// Resolve a VpcRoute's target into a short label and the underlying ID, mirroring
// the way the AWS console renders the "Target" column of a VPC route table.
function describeTarget(route: VpcRoute): { label: string; value: string } {
  if (route.gatewayId) {
    if (route.gatewayId === 'local') return { label: 'local', value: 'local' };
    if (route.gatewayId.startsWith('igw-')) return { label: 'IGW', value: route.gatewayId };
    if (route.gatewayId.startsWith('vgw-')) return { label: 'VGW', value: route.gatewayId };
    if (route.gatewayId.startsWith('vpce-')) return { label: 'VPCE', value: route.gatewayId };
    return { label: 'Gateway', value: route.gatewayId };
  }
  if (route.natGatewayId) return { label: 'NAT GW', value: route.natGatewayId };
  if (route.transitGatewayId) return { label: 'TGW', value: route.transitGatewayId };
  if (route.vpcPeeringConnectionId) return { label: 'PCX', value: route.vpcPeeringConnectionId };
  if (route.networkInterfaceId) return { label: 'ENI', value: route.networkInterfaceId };
  if (route.egressOnlyInternetGatewayId) return { label: 'EIGW', value: route.egressOnlyInternetGatewayId };
  if (route.carrierGatewayId) return { label: 'CGW', value: route.carrierGatewayId };
  if (route.localGatewayId) return { label: 'LGW', value: route.localGatewayId };
  if (route.coreNetworkArn) return { label: 'Core Net', value: route.coreNetworkArn.split('/').pop() ?? route.coreNetworkArn };
  if (route.instanceId) return { label: 'EC2', value: route.instanceId };
  return { label: '-', value: '-' };
}

// Origin → S/P shorthand. AWS reports `CreateRouteTable` for the implicit local
// route, `CreateRoute` for static user-added entries, and `EnableVgwRoutePropagation`
// for routes propagated from a VGW. Anything else (notably TGW propagation) is
// surfaced as propagated so the badge stays meaningful.
function isStaticOrigin(origin?: string): boolean {
  if (!origin) return true;
  return origin === 'CreateRouteTable' || origin === 'CreateRoute';
}

export function VpcRoutePanel({ routeTables, onClose, nodeId }: VpcRoutePanelProps) {
  const theme = useTopologyStore((s) => s.theme);
  const r = useRedact();
  const light = theme === 'light';
  const { getNode } = useReactFlow();
  const viewport = useViewport();

  const tabNames = routeTables.map((rt) => rt.tags.Name || rt.routeTableId);
  const [selectedTab, setSelectedTab] = useState(tabNames[0] ?? '');

  const selectedRt = routeTables.find(
    (rt) => (rt.tags.Name || rt.routeTableId) === selectedTab,
  );

  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; startOffX: number; startOffY: number } | null>(null);

  const stopProp = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation();
  }, []);

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
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, startOffX: offset.x, startOffY: offset.y };
  }, [offset]);

  const node = getNode(nodeId);
  if (!node) return null;

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

  const panelWidth = 360 * z;
  const screenX = (absX + nodeWidth) * z + viewport.x - panelWidth + offset.x;
  const screenY = (absY + nodeHeight) * z + viewport.y + 4 + offset.y;

  const panelContent = (
    <div
      className="fixed tgw-route-scroll"
      style={{
        top: screenY,
        left: screenX,
        width: panelWidth,
        maxHeight: 360 * z,
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
          VPC Route Tables
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
          {routeTables.map((rt) => {
            const tab = rt.tags.Name || rt.routeTableId;
            const isMain = rt.isMain;
            return (
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
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4 * z,
                }}
              >
                {tab}
                {isMain && (
                  <span style={{
                    fontSize: `${7 * z}px`,
                    fontWeight: 700,
                    padding: `0 ${2 * z}px`,
                    borderRadius: 2 * z,
                    backgroundColor: tab === selectedTab
                      ? 'rgba(255,255,255,0.25)'
                      : (light ? 'rgba(139,92,246,0.2)' : 'rgba(139,92,246,0.3)'),
                  }}>main</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Single tab label when only one */}
      {tabNames.length === 1 && selectedRt && (
        <div style={{
          padding: `${4 * z}px ${10 * z}px`,
          borderBottom: `1px solid ${light ? '#e2e5ea' : 'rgba(139,92,246,0.15)'}`,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6 * z,
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
          {selectedRt.isMain && (
            <span style={{
              fontSize: `${7.5 * z}px`,
              fontWeight: 700,
              padding: `${1 * z}px ${4 * z}px`,
              borderRadius: 3 * z,
              backgroundColor: light ? 'rgba(139,92,246,0.15)' : 'rgba(139,92,246,0.25)',
              color: light ? '#7c3aed' : '#c084fc',
            }}>main</span>
          )}
        </div>
      )}

      {/* Subnet associations */}
      {selectedRt && selectedRt.associatedSubnetIds.length > 0 && (
        <div style={{
          padding: `${5 * z}px ${10 * z}px`,
          borderBottom: `1px solid ${light ? '#e2e5ea' : 'rgba(139,92,246,0.15)'}`,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 6 * z,
        }}>
          <span style={{
            fontSize: `${7.5 * z}px`,
            color: light ? '#94a3b8' : '#64748b',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
            flexShrink: 0,
            paddingTop: 1 * z,
          }}>
            Subnets
          </span>
          <span style={{
            fontSize: `${8 * z}px`,
            fontFamily: "'JetBrains Mono', monospace",
            color: light ? '#475569' : '#94a3b8',
            wordBreak: 'break-all',
          }}>
            {r(selectedRt.associatedSubnetIds.join(', '))}
          </span>
        </div>
      )}

      {/* Scrollable route list */}
      <div style={{ overflowY: 'auto', padding: `${8 * z}px ${10 * z}px` }}>
        {!selectedRt ? (
          <span style={{ color: light ? '#64748b' : '#94a3b8' }}>No route tables found</span>
        ) : selectedRt.routes.length === 0 ? (
          <span style={{ color: light ? '#64748b' : '#94a3b8' }}>No routes</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 * z }}>
            {selectedRt.routes.map((route, i) => {
              const isBlackhole = route.state === 'blackhole';
              const target = describeTarget(route);
              const dest = route.destinationCidrBlock
                ?? route.destinationIpv6CidrBlock
                ?? route.destinationPrefixListId
                ?? '-';
              const isStatic = isStaticOrigin(route.origin);
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
                    title={r(dest)}
                  >
                    {r(dest)}
                  </span>
                  <span
                    style={{
                      fontSize: `${7.5 * z}px`,
                      color: light ? '#64748b' : '#94a3b8',
                      whiteSpace: 'nowrap',
                      maxWidth: 110 * z,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={target.value === target.label ? target.label : `${target.label} · ${r(target.value)}`}
                  >
                    {target.label}
                  </span>
                  <span
                    style={{
                      fontSize: `${7 * z}px`,
                      fontWeight: 700,
                      borderRadius: 2 * z,
                      padding: `0 ${2 * z}px`,
                      backgroundColor: isStatic
                        ? (light ? 'rgba(59,130,246,0.1)' : 'rgba(59,130,246,0.2)')
                        : (light ? 'rgba(168,85,247,0.1)' : 'rgba(168,85,247,0.2)'),
                      color: isStatic
                        ? (light ? '#3b82f6' : '#60a5fa')
                        : (light ? '#a855f7' : '#c084fc'),
                    }}
                    title={isStatic ? 'Static' : 'Propagated'}
                  >
                    {isStatic ? 'S' : 'P'}
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
