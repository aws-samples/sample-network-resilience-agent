import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTopologyStore } from '../store/topology-store';
import { useIsLight } from '../hooks/useTheme';
import type { ResiliencyTarget } from '../engine/resiliency-rules';

const targetLabels: Record<ResiliencyTarget, string> = {
  high: 'High Resiliency',
  maximum: 'Maximum Resiliency',
};

const targetSla: Record<ResiliencyTarget, string> = {
  high: '99.9%',
  maximum: '99.99%',
};

const targetBlurb: Record<ResiliencyTarget, string> = {
  high: '2 locations × 1 connection',
  maximum: '2 locations × 2 connections',
};

const MENU_WIDTH = 280;
const MENU_GAP = 6;

/**
 * Bulk tier picker shown in the top bar for multi-DXGW topologies. Applies the
 * chosen target to every DX Gateway at once. DXGWs already meeting or exceeding
 * the picked tier are no-ops (engine auto-escalates past-tier levels), matching
 * the per-DXGW semantics exposed on the ghost customer-site zones.
 *
 * The pill label reads from `assessment.perDxGateway[].targetLevel` (the
 * *effective* target the engine is using after auto-escalation), not the raw
 * user pick in the store. This prevents the misleading case where the store
 * says "high" for all DXGWs but the engine has escalated several to "maximum".
 * When effective targets differ across gateways, the pill shows "Mixed" and
 * the tooltip breaks down the split.
 */
export function BulkTargetTierPicker() {
  const dxGateways = useTopologyStore((s) => s.topologyData?.dxGateways) ?? [];
  const setResiliencyTarget = useTopologyStore((s) => s.setResiliencyTarget);
  const assessment = useTopologyStore((s) => s.assessment);
  const setSpotlightNodes = useTopologyStore((s) => s.setSpotlightNodes);
  const light = useIsLight();

  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    let rafId = 0;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (trigger) {
        const rect = trigger.getBoundingClientRect();
        const top = rect.bottom + MENU_GAP;
        const left = rect.right - MENU_WIDTH;
        const clampedLeft = Math.max(8, Math.min(window.innerWidth - MENU_WIDTH - 8, left));
        setMenuPos((prev) =>
          prev && prev.top === top && prev.left === clampedLeft ? prev : { top, left: clampedLeft },
        );
      }
      rafId = requestAnimationFrame(updatePosition);
    };
    updatePosition();
    return () => cancelAnimationFrame(rafId);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) {
      // Tier-row hover spotlights DXGW nodes on canvas; clear when the menu
      // closes so the highlight doesn't linger after the popover dismisses.
      setSpotlightNodes([]);
      return;
    }
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [menuOpen, setSpotlightNodes]);

  // Unattached DXGWs have no VIFs/associations and no traffic path, so
  // resiliency tiering doesn't apply — exclude them from both the affected set
  // and the total count used in the "Applies to X of Y" copy.
  const attachedDxGateways = assessment?.perDxGateway.filter((g) => !g.isUnattached) ?? [];

  // DXGW IDs the picked tier would *upgrade* — everything not already at or
  // above the tier. Returned as IDs (not just a count) so the popover can
  // spotlight the matching DX Gateway nodes on canvas when the user hovers a
  // tier row.
  const affectedDxGatewayIds = (tier: ResiliencyTarget): string[] => {
    return attachedDxGateways
      .filter((g) => {
        if (g.currentLevel === 'maximum') return false;
        if (tier === 'high' && g.currentLevel === 'high') return false;
        return true;
      })
      .map((g) => g.dxGatewayId);
  };
  const totalCount = attachedDxGateways.length || dxGateways.length;

  const applyToAll = (tier: ResiliencyTarget) => {
    const attachedIds = new Set(attachedDxGateways.map((g) => g.dxGatewayId));
    for (const gw of dxGateways) {
      // Unattached DXGWs get no traffic, so applying a tier to them is a no-op.
      if (attachedDxGateways.length > 0 && !attachedIds.has(gw.directConnectGatewayId)) continue;
      setResiliencyTarget(gw.directConnectGatewayId, tier);
    }
    setMenuOpen(false);
  };

  // Derive the pill label from the engine's *effective* targets, not the raw
  // store values. The engine auto-escalates any DXGW already at High → Max
  // (see recommendation-engine.ts ~line 165), so reading from the store would
  // show "HIGH 99.9%" while some gateways are actually being assessed at Max.
  // Using `targetLevel` ensures the pill reflects what's really being computed.
  // Unattached DXGWs have no traffic path so their target is meaningless —
  // exclude them to keep the pill label honest when every remaining gateway
  // agrees on a tier.
  const effectiveTargets = attachedDxGateways
    .map((g) => g.targetLevel)
    .filter((t): t is ResiliencyTarget => t === 'high' || t === 'maximum');
  const allSame = effectiveTargets.length > 0 && effectiveTargets.every((t) => t === effectiveTargets[0]);
  const displayTier: ResiliencyTarget | 'mixed' = allSame
    ? (effectiveTargets[0] ?? 'high')
    : effectiveTargets.length > 0
      ? 'mixed'
      : 'high';

  // When mixed, count how many DXGWs are at each tier for the tooltip.
  const mixedCounts = (() => {
    if (displayTier !== 'mixed') return null;
    const high = effectiveTargets.filter((t) => t === 'high').length;
    const max = effectiveTargets.filter((t) => t === 'maximum').length;
    return { high, max };
  })();

  const displayLabel = displayTier === 'mixed'
    ? 'Mixed'
    : displayTier === 'maximum' ? 'Max' : 'High';
  const displaySla = displayTier === 'mixed' ? '' : targetSla[displayTier];

  const pillTooltip = mixedCounts
    ? `DX Gateways have different targets — ${mixedCounts.max} at Max (99.99%), ${mixedCounts.high} at High (99.9%). Click to set a single target for all.`
    : 'Set target resiliency tier for every DX Gateway at once';

  const menu = menuOpen && menuPos ? (
    <div
      ref={menuRef}
      role="listbox"
      aria-label="Bulk resiliency target tier"
      style={{
        position: 'fixed',
        top: menuPos.top,
        left: menuPos.left,
        width: MENU_WIDTH,
        zIndex: 9999,
      }}
      className={`rounded-lg border shadow-xl overflow-hidden ${
        light ? 'bg-white border-gray-200' : 'bg-slate-800 border-slate-600'
      }`}
    >
      <div
        className={`px-3 py-2 text-[10px] font-bold uppercase tracking-wider border-b ${
          light ? 'text-gray-500 border-gray-200 bg-gray-50' : 'text-slate-400 border-slate-700 bg-slate-900/40'
        }`}
      >
        Next Resiliency Level Options
      </div>
      {(['high', 'maximum'] as ResiliencyTarget[]).map((tier) => {
        const affectedIds = affectedDxGatewayIds(tier);
        const affected = affectedIds.length;
        const gwWord = totalCount === 1 ? 'DX Gateway' : 'DX Gateways';
        return (
          <button
            type="button"
            key={tier}
            role="option"
            aria-selected={false}
            onClick={(e) => {
              e.stopPropagation();
              applyToAll(tier);
            }}
            onMouseEnter={() => {
              if (affected > 0) {
                setSpotlightNodes(affectedIds.map((id) => `dxgw-${id}`));
              }
            }}
            onMouseLeave={() => setSpotlightNodes([])}
            onFocus={() => {
              if (affected > 0) {
                setSpotlightNodes(affectedIds.map((id) => `dxgw-${id}`));
              }
            }}
            onBlur={() => setSpotlightNodes([])}
            className={`w-full text-left px-3 py-2.5 transition-colors ${
              light ? 'hover:bg-gray-50' : 'hover:bg-white/[0.04]'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`text-xs font-semibold ${light ? 'text-gray-900' : 'text-slate-100'}`}>
                {targetLabels[tier]}
              </span>
              <span className={`ml-auto text-[11px] font-mono ${light ? 'text-gray-500' : 'text-slate-400'}`}>
                {targetSla[tier]}
              </span>
            </div>
            <div className={`text-[11px] mt-1 ${light ? 'text-gray-500' : 'text-slate-400'}`}>
              {targetBlurb[tier]}
            </div>
            <div className={`text-[10px] mt-1 font-medium ${
              affected === 0
                ? (light ? 'text-gray-400' : 'text-slate-500')
                : (light ? 'text-emerald-600' : 'text-emerald-400')
            }`}>
              {affected === 0
                ? `All ${totalCount} ${gwWord} already meet this tier`
                : `Applies to ${affected} of ${totalCount} ${gwWord}`}
            </div>
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <div className="relative inline-flex" style={{ pointerEvents: 'auto' }}>
      <button
        ref={triggerRef}
        type="button"
        className={`flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium rounded-md border transition-all ${
          light
            ? 'bg-white border-gray-200 text-gray-700 hover:border-emerald-400 shadow-sm'
            : 'bg-slate-800 border-slate-600 text-slate-200 hover:border-emerald-500/60'
        }`}
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((o) => !o);
        }}
        aria-haspopup="listbox"
        aria-expanded={menuOpen}
        title={pillTooltip}
      >
        <span className="uppercase tracking-wider font-bold text-emerald-500 dark:text-emerald-400">
          {displayLabel}
        </span>
        {displaySla && (
          <span className={light ? 'text-gray-500' : 'text-slate-400'}>{displaySla}</span>
        )}
        <svg
          className={`w-3 h-3 transition-transform ${menuOpen ? 'rotate-180' : ''} ${light ? 'text-gray-400' : 'text-slate-500'}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
