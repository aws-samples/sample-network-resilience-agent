import type { NodeProps } from '@xyflow/react';
import type { DxNodeData, VpcChildInfo, TgwChildInfo, VgwChildInfo, DxgwChildInfo } from '../../types/topology';
import { useTopologyStore } from '../../store/topology-store';
import { useRedact } from '../../utils/redact';

export function UnattachedZoneNode({ data }: NodeProps) {
  const d = data as DxNodeData;
  const r = useRedact();
  const theme = useTopologyStore((s) => s.theme);
  const isLocked = useTopologyStore((s) => s.isLocked);
  const expanded = useTopologyStore((s) => s.expandedUnattachedZone);
  const toggleExpanded = useTopologyStore((s) => s.toggleUnattachedZone);
  const light = theme === 'light';

  const vpcChildren = (d.vpcChildren as VpcChildInfo[] | undefined) ?? [];
  const tgwChildren = (d.tgwChildren as TgwChildInfo[] | undefined) ?? [];
  const vgwChildren = (d.vgwChildren as VgwChildInfo[] | undefined) ?? [];
  const dxgwChildren = (d.dxgwChildren as DxgwChildInfo[] | undefined) ?? [];
  const total = vpcChildren.length + tgwChildren.length + vgwChildren.length + dxgwChildren.length;

  // Header palette matches the other zone containers (DX location, customer
  // site) — neutral slate gradient in light mode, muted slate in dark mode.
  // This keeps the unattached zone visually part of the canvas instead of a
  // warning banner. A small amber icon + left strip still mark it as
  // "needs attention" without flooding the body with tint.
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
  const warnIconBg = light ? 'rgba(217,119,6,0.12)' : 'rgba(250,204,21,0.14)';
  const warnIconColor = light ? '#b45309' : '#fbbf24';

  const vpcCols = { name: '26%', id: '22%', cidr: '18%', region: '18%', state: '16%' };
  const tgwCols = { name: '26%', id: '22%', asn: '14%', region: '22%', state: '16%' };
  const vgwCols = { name: '26%', id: '22%', asn: '14%', region: '22%', state: '16%' };
  const dxgwCols = { name: '34%', id: '30%', asn: '18%', state: '18%' };

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
        title={expanded ? 'Collapse unattached resources' : 'Expand unattached resources'}
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
            background: warnIconBg,
          }}
        >
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={warnIconColor} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <span className="text-[11px] font-semibold" style={{ color: headerText }}>
          {d.label}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {dxgwChildren.length > 0 && (
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
              style={{
                background: light ? 'rgba(15,23,42,0.05)' : 'rgba(148,163,184,0.12)',
                color: light ? '#475569' : '#cbd5e1',
              }}
            >
              {dxgwChildren.length} Direct Connect Gateway{dxgwChildren.length !== 1 ? 's' : ''}
            </span>
          )}
          {vgwChildren.length > 0 && (
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
              style={{
                background: light ? 'rgba(15,23,42,0.05)' : 'rgba(148,163,184,0.12)',
                color: light ? '#475569' : '#cbd5e1',
              }}
            >
              {vgwChildren.length} Virtual Private Gateway{vgwChildren.length !== 1 ? 's' : ''}
            </span>
          )}
          {vpcChildren.length > 0 && (
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
              style={{
                background: light ? 'rgba(15,23,42,0.05)' : 'rgba(148,163,184,0.12)',
                color: light ? '#475569' : '#cbd5e1',
              }}
            >
              {vpcChildren.length} Virtual Private Cloud{vpcChildren.length !== 1 ? 's' : ''}
            </span>
          )}
          {tgwChildren.length > 0 && (
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
              style={{
                background: light ? 'rgba(15,23,42,0.05)' : 'rgba(148,163,184,0.12)',
                color: light ? '#475569' : '#cbd5e1',
              }}
            >
              {tgwChildren.length} Transit Gateway{tgwChildren.length !== 1 ? 's' : ''}
            </span>
          )}
          <span
            className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full"
            style={{
              background: light ? '#fcd34d' : 'rgba(250,204,21,0.28)',
              color: light ? '#78350f' : '#fef3c7',
              boxShadow: light ? 'inset 0 -1px 0 rgba(0,0,0,0.05)' : 'inset 0 -1px 0 rgba(0,0,0,0.2)',
            }}
          >
            {total}
          </span>
        </div>
      </button>

      {expanded && (
        /* Pointer handlers only stop React Flow claiming the gesture as a drag so the
           tables stay selectable — the body is read-only, so there is no action to
           expose to the keyboard. */
        /* eslint-disable-next-line jsx-a11y/no-static-element-interactions */
        <div
          className={`pointer-events-auto px-3.5 py-2.5 selectable-text${isLocked ? ' nodrag nopan' : ''}`}
          onMouseDown={isLocked ? (e) => e.stopPropagation() : undefined}
          onPointerDown={isLocked ? (e) => e.stopPropagation() : undefined}
        >
          {dxgwChildren.length > 0 && (
            <section className={vgwChildren.length + vpcChildren.length + tgwChildren.length > 0 ? 'mb-3' : ''}>
              <SectionTitle
                label="Unattached Direct Connect Gateways"
                count={dxgwChildren.length}
                color={sectionText}
              />
              <table className="w-full text-[10px]" style={{ borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed' }}>
                <thead>
                  <tr style={{ color: colHeadText }}>
                    <Th width={dxgwCols.name} border={rowBorder}>Name</Th>
                    <Th width={dxgwCols.id} border={rowBorder}>DXGW ID</Th>
                    <Th width={dxgwCols.asn} border={rowBorder}>ASN</Th>
                    <Th width={dxgwCols.state} border={rowBorder}>State</Th>
                  </tr>
                </thead>
                <tbody>
                  {dxgwChildren.map((g, i) => (
                    <HoverRow key={g.dxgwId} alt={i % 2 === 1} altBg={rowAlt} hoverBg={rowHoverBg}>
                      <Td color={rowText} title={g.name}>{g.name}</Td>
                      <Td mono color={idPillText} title={r(g.dxgwId)}>
                        <IdPill bg={idPillBg} color={idPillText}>{r(g.dxgwId)}</IdPill>
                      </Td>
                      <Td mono color={rowText}>{g.asn != null ? r(`AS ${g.asn}`).replace(/^AS /, '') : '—'}</Td>
                      <Td color={stateColor(g.state, light)}><StatusDot state={g.state} light={light} />{g.state}</Td>
                    </HoverRow>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {vgwChildren.length > 0 && (
            <section className={vpcChildren.length + tgwChildren.length > 0 ? 'mb-3' : ''}>
              <SectionTitle
                label="Unattached Virtual Private Gateways"
                count={vgwChildren.length}
                color={sectionText}
              />
              <table className="w-full text-[10px]" style={{ borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed' }}>
                <thead>
                  <tr style={{ color: colHeadText }}>
                    <Th width={vgwCols.name} border={rowBorder}>Name</Th>
                    <Th width={vgwCols.id} border={rowBorder}>VGW ID</Th>
                    <Th width={vgwCols.asn} border={rowBorder}>ASN</Th>
                    <Th width={vgwCols.region} border={rowBorder}>Region</Th>
                    <Th width={vgwCols.state} border={rowBorder}>Attachment</Th>
                  </tr>
                </thead>
                <tbody>
                  {vgwChildren.map((v, i) => {
                    const shown = v.attachmentState ?? 'detached';
                    return (
                      <HoverRow key={v.vgwId} alt={i % 2 === 1} altBg={rowAlt} hoverBg={rowHoverBg}>
                        <Td color={rowText} title={v.name}>{v.name}</Td>
                        <Td mono color={idPillText} title={r(v.vgwId)}>
                          <IdPill bg={idPillBg} color={idPillText}>{r(v.vgwId)}</IdPill>
                        </Td>
                        <Td mono color={rowText}>{v.asn != null ? r(`AS ${v.asn}`).replace(/^AS /, '') : '—'}</Td>
                        <Td mono color={rowText}>{v.region ?? '—'}</Td>
                        <Td color={stateColor(shown, light)}><StatusDot state={shown} light={light} />{shown}</Td>
                      </HoverRow>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}

          {vpcChildren.length > 0 && (
            <section className={tgwChildren.length > 0 ? 'mb-3' : ''}>
              <SectionTitle
                label="Unattached VPCs"
                count={vpcChildren.length}
                color={sectionText}
              />
              <table className="w-full text-[10px]" style={{ borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed' }}>
                <thead>
                  <tr style={{ color: colHeadText }}>
                    <Th width={vpcCols.name} border={rowBorder}>Name</Th>
                    <Th width={vpcCols.id} border={rowBorder}>VPC ID</Th>
                    <Th width={vpcCols.cidr} border={rowBorder}>CIDR</Th>
                    <Th width={vpcCols.region} border={rowBorder}>Region</Th>
                    <Th width={vpcCols.state} border={rowBorder}>State</Th>
                  </tr>
                </thead>
                <tbody>
                  {vpcChildren.map((v, i) => (
                    <HoverRow key={v.vpcId} alt={i % 2 === 1} altBg={rowAlt} hoverBg={rowHoverBg}>
                      <Td color={rowText} title={v.name}>{v.name}</Td>
                      <Td mono color={idPillText} title={r(v.vpcId)}>
                        <IdPill bg={idPillBg} color={idPillText}>{r(v.vpcId)}</IdPill>
                      </Td>
                      <Td mono color={rowText}>{r(v.cidr)}</Td>
                      <Td mono color={rowText}>{v.region ?? '—'}</Td>
                      <Td color={stateColor(v.state, light)}><StatusDot state={v.state} light={light} />{v.state}</Td>
                    </HoverRow>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {tgwChildren.length > 0 && (
            <section>
              <SectionTitle
                label="Unattached Transit Gateways"
                count={tgwChildren.length}
                color={sectionText}
              />
              <table className="w-full text-[10px]" style={{ borderCollapse: 'separate', borderSpacing: 0, tableLayout: 'fixed' }}>
                <thead>
                  <tr style={{ color: colHeadText }}>
                    <Th width={tgwCols.name} border={rowBorder}>Name</Th>
                    <Th width={tgwCols.id} border={rowBorder}>TGW ID</Th>
                    <Th width={tgwCols.asn} border={rowBorder}>ASN</Th>
                    <Th width={tgwCols.region} border={rowBorder}>Region</Th>
                    <Th width={tgwCols.state} border={rowBorder}>State</Th>
                  </tr>
                </thead>
                <tbody>
                  {tgwChildren.map((t, i) => (
                    <HoverRow key={t.tgwId} alt={i % 2 === 1} altBg={rowAlt} hoverBg={rowHoverBg}>
                      <Td color={rowText} title={t.name}>{t.name}</Td>
                      <Td mono color={idPillText} title={r(t.tgwId)}>
                        <IdPill bg={idPillBg} color={idPillText}>{r(t.tgwId)}</IdPill>
                      </Td>
                      <Td mono color={rowText}>{t.asn != null ? r(`AS ${t.asn}`).replace(/^AS /, '') : '—'}</Td>
                      <Td mono color={rowText}>{t.region ?? '—'}</Td>
                      <Td color={stateColor(t.state, light)}><StatusDot state={t.state} light={light} />{t.state}</Td>
                    </HoverRow>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {total === 0 && (
            <div className="text-[10px] italic text-center py-2" style={{ color: subtleText }}>
              No unattached resources.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SectionTitle({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div
      className="flex items-center gap-1.5 text-[11px] font-semibold mb-1.5"
      style={{ color }}
    >
      <span>{label}</span>
      <span
        className="text-[9px] font-mono font-bold px-1.5 rounded-full"
        style={{
          background: 'rgba(250,204,21,0.18)',
          color,
          height: 14,
          display: 'inline-flex',
          alignItems: 'center',
          lineHeight: 1,
        }}
      >
        {count}
      </span>
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

function Td({ children, color, mono, title }: { children: React.ReactNode; color: string; mono?: boolean; title?: string }) {
  return (
    <td
      className={`py-1 px-1.5 truncate${mono ? ' font-mono' : ''}`}
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

function StatusDot({ state, light }: { state: string; light: boolean }) {
  const color = stateColor(state, light);
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: color,
        display: 'inline-block',
        flexShrink: 0,
        boxShadow: `0 0 0 2px ${color}1a`,
      }}
    />
  );
}

function stateColor(state: string, light: boolean): string {
  const s = state.toLowerCase();
  if (s === 'available' || s === 'attached') return light ? '#15803d' : '#4ade80';
  if (s.includes('pending') || s.includes('modifying')) return light ? '#a16207' : '#facc15';
  return light ? '#64748b' : '#94a3b8';
}
