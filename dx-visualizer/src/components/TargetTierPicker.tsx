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

interface TargetTierPickerProps {
  dxGatewayId: string;
  size?: 'sm' | 'xs';
  align?: 'left' | 'right';
}

const MENU_WIDTH = 240;
const MENU_GAP = 6;

export function TargetTierPicker({ dxGatewayId, size = 'sm', align = 'right' }: TargetTierPickerProps) {
  const target = useTopologyStore((s) => s.resiliencyTargets[dxGatewayId] ?? 'high');
  const setResiliencyTarget = useTopologyStore((s) => s.setResiliencyTarget);
  const light = useIsLight();

  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  // Portal the listbox to <body> so it escapes its React Flow node wrapper
  // (which clips/occludes absolutely-positioned children). Position it with
  // `position: fixed` anchored to the trigger's viewport rect. An rAF loop
  // while the menu is open keeps the menu glued to the trigger across any
  // layout shift — scroll, canvas pan/zoom, divider drag — without having to
  // enumerate the event sources (resize doesn't fire on inner flex reflow).
  useLayoutEffect(() => {
    if (!menuOpen) return;
    let rafId = 0;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (trigger) {
        const rect = trigger.getBoundingClientRect();
        const top = rect.bottom + MENU_GAP;
        const left = align === 'right' ? rect.right - MENU_WIDTH : rect.left;
        const clampedLeft = Math.max(8, Math.min(window.innerWidth - MENU_WIDTH - 8, left));
        setMenuPos((prev) =>
          prev && prev.top === top && prev.left === clampedLeft ? prev : { top, left: clampedLeft },
        );
      }
      rafId = requestAnimationFrame(updatePosition);
    };
    updatePosition();
    return () => cancelAnimationFrame(rafId);
  }, [menuOpen, align]);

  useEffect(() => {
    if (!menuOpen) return;
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
  }, [menuOpen]);

  const buttonPadding = size === 'xs' ? 'px-1.5 py-0.5' : 'px-2 py-1.5';
  const buttonText = size === 'xs' ? 'text-[10px]' : 'text-[11px]';

  const menu = menuOpen && menuPos ? (
    <div
      ref={menuRef}
      role="listbox"
      aria-label="Resiliency target tier"
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
        Next Resiliency Options
      </div>
      {(['high', 'maximum'] as ResiliencyTarget[]).map((tier) => {
        const selected = target === tier;
        return (
          <button
            type="button"
            key={tier}
            role="option"
            aria-selected={selected}
            onClick={(e) => {
              e.stopPropagation();
              setResiliencyTarget(dxGatewayId, tier);
              setMenuOpen(false);
            }}
            className={`w-full text-left px-3 py-2.5 transition-colors ${
              selected
                ? (light ? 'bg-emerald-50' : 'bg-emerald-500/10')
                : (light ? 'hover:bg-gray-50' : 'hover:bg-white/[0.04]')
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{
                  backgroundColor: selected ? '#10b981' : 'transparent',
                  border: '1.5px solid #10b981',
                }}
                aria-hidden="true"
              />
              <span className={`text-xs font-semibold ${light ? 'text-gray-900' : 'text-slate-100'}`}>
                {targetLabels[tier]}
              </span>
              <span className={`ml-auto text-[11px] font-mono ${light ? 'text-gray-500' : 'text-slate-400'}`}>
                {targetSla[tier]}
              </span>
            </div>
            <div className={`text-[11px] mt-1 pl-4 ${light ? 'text-gray-500' : 'text-slate-400'}`}>
              {targetBlurb[tier]}
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
        className={`flex items-center gap-1 ${buttonPadding} ${buttonText} font-medium rounded-md border transition-all ${
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
        aria-label={`Target tier for ${dxGatewayId}: ${targetLabels[target]}`}
        title="Choose target resiliency tier for this DX Gateway"
      >
        <span className="uppercase tracking-wider font-bold text-emerald-500 dark:text-emerald-400">
          {target === 'maximum' ? 'Max' : 'High'}
        </span>
        <span className={light ? 'text-gray-500' : 'text-slate-400'}>{targetSla[target]}</span>
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
