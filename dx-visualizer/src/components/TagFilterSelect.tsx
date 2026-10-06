import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useIsLight } from '../hooks/useTheme';

interface TagFilterSelectProps {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

export function TagFilterSelect({ label, value, options, placeholder, disabled, onChange }: TagFilterSelectProps) {
  const light = useIsLight();
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: '', time: 0 });
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0, maxHeight: 0 });
  const selectedIndex = options.findIndex((option) => option.value === value);
  const menuOpen = open && !disabled && options.length > 0;
  const focusedIndex = Math.min(activeIndex, options.length - 1);

  // Like the tier pickers, render outside React Flow's clipping containers.
  // Measure while open so scrolling or resizing the panel keeps the list anchored.
  useLayoutEffect(() => {
    if (!menuOpen) return;
    let frame = 0;
    const update = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (trigger && menu) {
        const rect = trigger.getBoundingClientRect();
        const gap = 6;
        const gutter = 8;
        const below = Math.max(0, window.innerHeight - rect.bottom - gap - gutter);
        const above = Math.max(0, rect.top - gap - gutter);
        const desiredHeight = Math.min(menu.scrollHeight, window.innerHeight * 0.4);
        const openAbove = below < desiredHeight && above > below;
        const maxHeight = Math.min(window.innerHeight * 0.4, openAbove ? above : below);
        const height = Math.min(menu.scrollHeight, maxHeight);
        const width = Math.min(rect.width, window.innerWidth - gutter * 2);
        const next = {
          top: openAbove ? rect.top - gap - height : rect.bottom + gap,
          left: Math.max(gutter, Math.min(rect.left, window.innerWidth - width - gutter)),
          width,
          maxHeight,
        };
        setPosition((prev) =>
          prev.top === next.top && prev.left === next.left && prev.width === next.width && prev.maxHeight === next.maxHeight
            ? prev : next,
        );
      }
      frame = requestAnimationFrame(update);
    };
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    update();
    document.addEventListener('pointerdown', dismiss);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', dismiss);
    };
  }, [menuOpen]);

  useLayoutEffect(() => {
    if (menuOpen) {
      menuRef.current?.children[focusedIndex]?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [menuOpen, focusedIndex]);

  const showMenu = (index = Math.max(0, selectedIndex)) => {
    typeahead.current = { text: '', time: 0 };
    setActiveIndex(index);
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || !options.length || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Tab') {
      if (menuOpen) choose(focusedIndex);
      return;
    }
    if (event.key === 'Escape') {
      if (menuOpen) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    const navigation = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '];
    if (navigation.includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Enter' || event.key === ' ') {
        if (menuOpen) choose(focusedIndex);
        else showMenu();
      } else if (event.key === 'Home') {
        showMenu(0);
      } else if (event.key === 'End') {
        showMenu(options.length - 1);
      } else if (!menuOpen) {
        showMenu();
      } else {
        setActiveIndex(Math.max(0, Math.min(options.length - 1, focusedIndex + (event.key === 'ArrowDown' ? 1 : -1))));
      }
    } else if (event.key.length === 1 && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      const now = Date.now();
      const text = (now - typeahead.current.time < 700 ? typeahead.current.text : '') + event.key.toLocaleLowerCase();
      typeahead.current = { text, time: now };
      const query = [...text].every((character) => character === text[0]) ? text[0] : text;
      const start = menuOpen ? focusedIndex : selectedIndex;
      const indices = options.map((_, i) => (start + i + 1) % options.length);
      const match = indices.find((i) => options[i].label.toLocaleLowerCase().startsWith(query));
      setActiveIndex(match ?? Math.max(0, start));
      setOpen(true);
    }
  };

  return (
    <div className="space-y-1">
      <label id={`${id}-label`} htmlFor={id} className="block">{label}</label>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-labelledby={`${id}-label`}
        aria-haspopup="listbox"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? `${id}-list` : undefined}
        aria-activedescendant={menuOpen ? `${id}-option-${focusedIndex}` : undefined}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          event.currentTarget.focus();
          if (menuOpen) setOpen(false);
          else showMenu();
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
        className={`flex w-full min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors outline-none
          focus-visible:ring-2 focus-visible:ring-violet-500 disabled:opacity-50 disabled:cursor-not-allowed ${
            light
              ? 'bg-white border-gray-200 text-gray-700 enabled:hover:border-violet-400 shadow-sm'
              : 'bg-slate-800 border-slate-600 text-slate-200 enabled:hover:border-violet-500/60'
          }`}
      >
        <span className="min-w-0 flex-1 truncate">{options[selectedIndex]?.label ?? placeholder}</span>
        <svg
          className={`w-3 h-3 shrink-0 transition-transform ${menuOpen ? 'rotate-180' : ''} ${light ? 'text-gray-400' : 'text-slate-500'}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {menuOpen && createPortal(
        <div
          ref={menuRef}
          id={`${id}-list`}
          role="listbox"
          aria-labelledby={`${id}-label`}
          style={{ position: 'fixed', ...position, zIndex: 9999 }}
          className={`nodrag nopan nowheel overflow-y-auto overscroll-contain rounded-lg border py-1 shadow-xl text-[11px] font-tech ${
            light ? 'bg-white border-gray-200 text-gray-700' : 'bg-slate-800 border-slate-600 text-slate-200'
          }`}
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              id={`${id}-option-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={index === focusedIndex}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setActiveIndex(index)}
              onClick={(event) => {
                event.stopPropagation();
                choose(index);
                triggerRef.current?.focus();
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                index === focusedIndex
                  ? light ? 'bg-violet-50 text-violet-800' : 'bg-violet-500/15 text-violet-200'
                  : light ? 'hover:bg-gray-50' : 'hover:bg-white/[0.04]'
              }`}
            >
              <span className="min-w-0 flex-1 break-all">{option.label}</span>
              <svg
                className={`w-3.5 h-3.5 shrink-0 ${option.value === value ? '' : 'invisible'}`}
                viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="m4 10 4 4 8-8" />
              </svg>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
