import { useCallback, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useReactFlow, useViewport } from '@xyflow/react';
import type { VpcPeerInfo } from '../../types/topology';
import { useTopologyStore } from '../../store/topology-store';
import { useRedact } from '../../utils/redact';

interface VpcPeerPanelProps {
  peers: VpcPeerInfo[];
  onClose: () => void;
  nodeId: string;
}

// Floating list of a VPC's peering relationships. Mirrors VpcRoutePanel's
// portal/drag/zoom-scaling so it renders identically over the canvas. Solves the
// "which VPC peers to which" ambiguity when many peering edges leave the same
// handle: hovering a row spotlights exactly that edge, and the row text names
// the peer + region outright so no line-tracing is needed.
export function VpcPeerPanel({ peers, onClose, nodeId }: VpcPeerPanelProps) {
  const theme = useTopologyStore((s) => s.theme);
  const setSpotlightEdge = useTopologyStore((s) => s.setSpotlightEdge);
  const r = useRedact();
  const light = theme === 'light';
  const { getNode } = useReactFlow();
  const viewport = useViewport();

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

  // Clear any lingering spotlight when the panel unmounts (e.g. collapsed while
  // a row was still hovered).
  useEffect(() => () => setSpotlightEdge(null), [setSpotlightEdge]);

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

  const panelWidth = 340 * z;
  const screenX = (absX + nodeWidth) * z + viewport.x - panelWidth + offset.x;
  const screenY = (absY + nodeHeight) * z + viewport.y + 4 + offset.y;

  const accountColor = light ? '#d97706' : '#fbbf24';

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
          VPC Peerings ({peers.length})
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

      {/* Scrollable peer list */}
      <div style={{ overflowY: 'auto', padding: `${8 * z}px ${10 * z}px` }}>
        {peers.length === 0 ? (
          <span style={{ color: light ? '#64748b' : '#94a3b8' }}>No peerings</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 * z }}>
            {peers.map((peer) => {
              const isBlackhole = !!peer.state && !/^(active|available)$/i.test(peer.state);
              return (
                <div
                  key={peer.edgeId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6 * z,
                    borderRadius: 4 * z,
                    padding: `${3 * z}px ${6 * z}px`,
                    cursor: 'default',
                    transition: 'background-color 0.12s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = light ? 'rgba(139,92,246,0.1)' : 'rgba(139,92,246,0.2)';
                    setSpotlightEdge(peer.edgeId);
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    setSpotlightEdge(null);
                  }}
                  title={`${peer.direction === 'out' ? 'Requester → ' : 'Accepter ← '}${r(peer.peerVpcId)} · ${r(peer.pcxId)}${peer.state ? ` · ${peer.state}` : ''}`}
                >
                  {/* State dot */}
                  <span
                    style={{
                      width: 5 * z,
                      height: 5 * z,
                      borderRadius: '50%',
                      backgroundColor: isBlackhole ? '#ef4444' : '#22c55e',
                      flexShrink: 0,
                    }}
                  />
                  {/* Direction arrow — outbound (requester) vs inbound (accepter) */}
                  <span
                    style={{
                      fontSize: `${9 * z}px`,
                      color: light ? '#8b5cf6' : '#a78bfa',
                      flexShrink: 0,
                      width: 8 * z,
                      textAlign: 'center',
                    }}
                    title={peer.direction === 'out' ? 'This VPC is the requester' : 'This VPC is the accepter'}
                  >
                    {peer.direction === 'out' ? '→' : '←'}
                  </span>
                  {/* Peer name + id */}
                  <span
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        fontSize: `${9 * z}px`,
                        fontWeight: 600,
                        color: isBlackhole ? '#ef4444' : (light ? '#334155' : '#e2e8f0'),
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {r(peer.peerName)}
                    </span>
                    <span
                      style={{
                        fontSize: `${7.5 * z}px`,
                        fontFamily: "'JetBrains Mono', monospace",
                        color: light ? '#94a3b8' : '#64748b',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {r(peer.pcxId)}
                      {peer.crossAccount && peer.peerOwnerAccount && (
                        <span style={{ color: accountColor }}> · {r(peer.peerOwnerAccount)}</span>
                      )}
                    </span>
                  </span>
                  {/* Region */}
                  <span
                    style={{
                      fontSize: `${8 * z}px`,
                      fontFamily: "'JetBrains Mono', monospace",
                      color: light ? '#64748b' : '#94a3b8',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    {peer.peerRegion}
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
