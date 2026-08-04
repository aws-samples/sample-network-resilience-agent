import type { NodeProps } from '@xyflow/react';
import type { DxNodeData, HiddenAssocChildInfo } from '../../types/topology';
import { useTopologyStore } from '../../store/topology-store';

// Renders DXGW associations whose associated gateway identity AWS refuses
// to expose via the public API (prefix-pool / EDGLESS origin). Structurally
// modelled on UnattachedZoneNode — collapsible header + inline table, same
// neutral palette so it reads as part of the canvas, not an alert.
export function HiddenAssocZoneNode({ data }: NodeProps) {
  const d = data as DxNodeData;
  const theme = useTopologyStore((s) => s.theme);
  const isLocked = useTopologyStore((s) => s.isLocked);
  const expanded = useTopologyStore((s) => s.expandedHiddenAssocZone);
  const toggleExpanded = useTopologyStore((s) => s.toggleHiddenAssocZone);
  const light = theme === 'light';

  const rows = (d.hiddenAssocChildren as HiddenAssocChildInfo[] | undefined) ?? [];
  const total = rows.length;

  const bg = light ? '#ffffff' : 'rgba(15,23,42,0.82)';
  const headerGradient = light
    ? 'linear-gradient(to bottom, #e2e8f0, #eef1f6)'
    : 'rgba(100,116,139,0.22)';
  const border = light ? '#94a3b8' : '#475569';
  const headerBorder = light ? 'rgba(100,116,139,0.22)' : '#47556940';
  const headerText = light ? '#374151' : '#ffffff';
  const sectionText = light ? '#475569' : '#cbd5e1';
  const subtleText = '#94a3b8';
  const colHeadText = light ? '#64748b' : '#94a3b8';
  const rowText = light ? '#1f2937' : '#e4e4e7';
  const rowAlt = light ? 'rgba(15,23,42,0.025)' : 'rgba(148,163,184,0.05)';
  const rowHoverBg = light ? 'rgba(14,165,233,0.06)' : 'rgba(148,163,184,0.08)';
  const rowBorder = light ? '#eef2f7' : 'rgba(148,163,184,0.14)';
  const idPillBg = light ? '#f1f5f9' : 'rgba(148,163,184,0.12)';
  const idPillText = light ? '#475569' : '#cbd5e1';
  const iconBg = light ? 'rgba(14,165,233,0.12)' : 'rgba(56,189,248,0.16)';
  const iconColor = light ? '#0369a1' : '#7dd3fc';

  const cols = { dxgw: '78%', state: '22%' };

  return (
    <div
      className="rounded-xl pointer-events-none overflow-hidden"
      style={{
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: border,
        backgroundColor: bg,
        width: '100%',
        height: '100%',
        position: 'relative',
        boxShadow: light
          ? '0 1px 2px rgba(15,23,42,0.05), 0 6px 16px rgba(15,23,42,0.04)'
          : '0 2px 10px rgba(0,0,0,0.25)',
      }}
    >
      <button
        type="button"
        onClick={toggleExpanded}
        className={`pointer-events-auto cursor-pointer flex items-center gap-2 px-3.5 w-full text-left transition-colors ${isLocked ? 'nodrag nopan' : ''}`}
        style={{
          background: headerGradient,
          borderBottom: expanded ? `1px solid ${headerBorder}40` : 'none',
          height: 40,
        }}
        title={expanded ? 'Collapse hidden associations' : 'Expand hidden associations'}
        aria-expanded={expanded}
      >
        <svg
          width={12}
          height={12}
          viewBox="0 0 24 24"
          fill="none"
          stroke={headerText}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 150ms' }}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: 999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: iconBg,
          }}
        >
          {/* eye-off — associations exist but AWS redacts the target identity */}
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        </div>
        <span className="text-[11px] font-semibold" style={{ color: headerText }}>
          {d.label}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span
            className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full"
            style={{
              background: light ? '#bae6fd' : 'rgba(56,189,248,0.28)',
              color: light ? '#075985' : '#e0f2fe',
              boxShadow: light ? 'inset 0 -1px 0 rgba(0,0,0,0.05)' : 'inset 0 -1px 0 rgba(0,0,0,0.2)',
            }}
          >
            {total}
          </span>
        </div>
      </button>

      {expanded && (
        /* Pointer handlers only stop React Flow claiming the gesture as a drag so the
           table stays selectable — the body is read-only, so there is no action to
           expose to the keyboard. */
        /* eslint-disable-next-line jsx-a11y/no-static-element-interactions */
        <div
          className={`pointer-events-auto px-3.5 py-2.5 selectable-text${isLocked ? ' nodrag nopan' : ''}`}
          onMouseDown={isLocked ? (e) => e.stopPropagation() : undefined}
          onPointerDown={isLocked ? (e) => e.stopPropagation() : undefined}
        >
          {total > 0 ? (
            <section>
              <div
                className="flex items-center gap-1.5 text-[11px] font-semibold mb-1"
                style={{ color: sectionText }}
              >
                <span>Prefix-pool associations</span>
                <span
                  className="text-[9px] font-mono font-bold px-1.5 rounded-full"
                  style={{
                    background: 'rgba(56,189,248,0.18)',
                    color: sectionText,
                    height: 14,
                    display: 'inline-flex',
                    alignItems: 'center',
                    lineHeight: 1,
                  }}
                >
                  {total}
                </span>
              </div>
              <div
                className="text-[10px] italic mb-1.5 leading-snug"
                style={{ color: subtleText }}
              >
                AWS returns only the state for prefix-pool (EDGLESS) associations.
                The target gateway lives in another account and its identity
                isn&apos;t included in this account&apos;s API response.
              </div>
              <table className="w-full text-[10px]" style={{ borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed' }}>
                <thead>
                  <tr style={{ color: colHeadText }}>
                    <Th width={cols.dxgw} border={rowBorder}>Parent DXGW</Th>
                    <Th width={cols.state} border={rowBorder}>State</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <HoverRow key={`${row.dxGatewayId}-${i}`} alt={i % 2 === 1} altBg={rowAlt} hoverBg={rowHoverBg}>
                      <Td color={rowText} title={row.dxGatewayName}>
                        <span className="inline-flex items-center gap-1.5 min-w-0">
                          <span className="truncate max-w-[50%]">{row.dxGatewayName}</span>
                          <IdPill bg={idPillBg} color={idPillText}>{row.dxGatewayId}</IdPill>
                        </span>
                      </Td>
                      <Td color={rowText}>{row.state}</Td>
                    </HoverRow>
                  ))}
                </tbody>
              </table>
            </section>
          ) : (
            <div className="text-[10px] italic text-center py-2" style={{ color: subtleText }}>
              No prefix-pool associations.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Th({ children, width, border }: { children: React.ReactNode; width: string; border: string }) {
  return (
    <th
      className="text-left font-medium py-1 px-1.5"
      style={{
        width,
        fontSize: '10px',
        borderBottom: `1px solid ${border}`,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, color, title }: { children: React.ReactNode; color: string; title?: string }) {
  return (
    <td
      className="py-1 px-1.5 truncate"
      style={{ color, verticalAlign: 'middle' }}
      title={title}
    >
      <span className="inline-flex items-center gap-1 align-middle">{children}</span>
    </td>
  );
}

function HoverRow({ children, alt, altBg, hoverBg }: { children: React.ReactNode; alt: boolean; altBg: string; hoverBg: string }) {
  return (
    <tr
      style={{ background: alt ? altBg : 'transparent', transition: 'background 120ms' }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = hoverBg; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = alt ? altBg : 'transparent'; }}
    >
      {children}
    </tr>
  );
}

function IdPill({ children, bg, color }: { children: React.ReactNode; bg: string; color: string }) {
  return (
    <span
      className="inline-block truncate"
      style={{
        background: bg,
        color,
        padding: '1px 6px',
        borderRadius: 4,
        fontSize: '9px',
        maxWidth: '100%',
      }}
    >
      {children}
    </span>
  );
}
