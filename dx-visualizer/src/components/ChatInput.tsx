import { useState, useRef, useEffect, useCallback } from 'react';
import { useIsLight } from '../hooks/useTheme';
import { useTopologyStore } from '../store/topology-store';

interface Props {
  onSend: (message: string) => void;
  onStop?: () => void;
  disabled?: boolean;
}

const MIN_HEIGHT = 36;
const MAX_HEIGHT = 400;
const DEFAULT_HEIGHT = 96;
const HEIGHT_STORAGE_KEY = 'chat-input-height-v2';

export function ChatInput({ onSend, onStop, disabled }: Props) {
  const [value, setValue] = useState('');
  const [height, setHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_HEIGHT;
    const stored = window.localStorage.getItem(HEIGHT_STORAGE_KEY);
    const parsed = stored ? parseInt(stored, 10) : NaN;
    return Number.isFinite(parsed) ? Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, parsed)) : DEFAULT_HEIGHT;
  });
  const [isResizing, setIsResizing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resizeStart = useRef<{ y: number; startHeight: number } | null>(null);
  const light = useIsLight();
  const refreshNonce = useTopologyStore((s) => s.topologyRefreshNonce);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const commitHeight = useCallback((next: number) => {
    const clamped = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, next));
    setHeight(clamped);
    try {
      window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(clamped));
    } catch {
      // ignore quota errors
    }
  }, []);

  const onDragStart = (clientY: number) => {
    resizeStart.current = { y: clientY, startHeight: height };
    setIsResizing(true);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    onDragStart(e.clientY);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (t) onDragStart(t.clientY);
  };

  const handleHandleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      commitHeight(height + (e.shiftKey ? 40 : 12));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      commitHeight(height - (e.shiftKey ? 40 : 12));
    } else if (e.key === 'Home') {
      e.preventDefault();
      commitHeight(MIN_HEIGHT);
    } else if (e.key === 'End') {
      e.preventDefault();
      commitHeight(MAX_HEIGHT);
    }
  };

  const handleDoubleClick = () => {
    commitHeight(DEFAULT_HEIGHT);
  };

  // Reset to the default height after a topology refresh — treats "Refresh
  // topology" as a soft reset for chat-panel UI state. Guarded by a ref so the
  // initial mount (nonce === 0) doesn't clobber a user's saved height.
  const refreshBaseline = useRef(refreshNonce);
  useEffect(() => {
    if (refreshNonce === refreshBaseline.current) return;
    refreshBaseline.current = refreshNonce;
    commitHeight(DEFAULT_HEIGHT);
  }, [refreshNonce, commitHeight]);

  useEffect(() => {
    if (!isResizing) return;

    const onMove = (clientY: number) => {
      const start = resizeStart.current;
      if (!start) return;
      // Dragging up (smaller clientY) should increase the height since the
      // input is anchored to the bottom of the panel.
      const delta = start.y - clientY;
      commitHeight(start.startHeight + delta);
    };

    const onMouseMove = (e: MouseEvent) => onMove(e.clientY);
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t) onMove(t.clientY);
    };
    const onEnd = () => {
      resizeStart.current = null;
      setIsResizing(false);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onTouchMove);
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = '';
    };
  }, [isResizing, commitHeight]);

  return (
    <div className={`relative flex items-end gap-2 p-3 pt-2 border-t ${light ? 'border-gray-300 bg-gray-100' : 'border-slate-700 bg-slate-800'}`}>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize chat input (drag, or use arrow keys)"
        aria-valuenow={height}
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={MAX_HEIGHT}
        tabIndex={0}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onKeyDown={handleHandleKeyDown}
        onDoubleClick={handleDoubleClick}
        title="Drag to resize. Double-click to reset."
        className={`absolute left-0 right-0 -top-1 h-2 flex items-center justify-center cursor-ns-resize group focus:outline-none`}
      >
        <span
          className={`h-1 w-10 rounded-full transition-colors ${
            isResizing
              ? 'bg-blue-500'
              : light
                ? 'bg-gray-300 group-hover:bg-gray-400 group-focus-visible:bg-blue-500'
                : 'bg-slate-600 group-hover:bg-slate-500 group-focus-visible:bg-blue-500'
          }`}
        />
      </div>
      <label htmlFor="chat-input" className="sr-only">Ask about resiliency improvements</label>
      <textarea
        id="chat-input"
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask about resiliency improvements..."
        disabled={disabled}
        style={{ height: `${height}px` }}
        className={`flex-1 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none disabled:opacity-50 disabled:cursor-not-allowed border ${
          light
            ? 'bg-gray-100 border-gray-300 text-gray-800 placeholder-gray-400'
            : 'bg-slate-700 border-slate-600 text-white placeholder-slate-400'
        }`}
      />
      {disabled && onStop ? (
        <button
          onClick={onStop}
          title="Stop generating"
          aria-label="Stop generating"
          className="p-2 bg-red-600 text-white rounded-lg hover:bg-red-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 transition-colors flex-shrink-0"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="1.5" />
          </svg>
        </button>
      ) : (
        <button
          onClick={handleSubmit}
          disabled={disabled || !value.trim()}
          aria-label="Send message"
          title="Send message"
          className="p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-shrink-0"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      )}
    </div>
  );
}
