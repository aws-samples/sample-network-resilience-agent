// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useUnloadCleaner } from '../useUnloadCleaner';

describe('useUnloadCleaner', () => {
  it('calls onUnload when pagehide fires and session is active', () => {
    const onUnload = vi.fn();
    renderHook(() => useUnloadCleaner(true, onUnload));

    window.dispatchEvent(new Event('pagehide'));

    expect(onUnload).toHaveBeenCalledOnce();
  });

  it('does not call onUnload when isActive is false', () => {
    const onUnload = vi.fn();
    renderHook(() => useUnloadCleaner(false, onUnload));

    window.dispatchEvent(new Event('pagehide'));

    expect(onUnload).not.toHaveBeenCalled();
  });

  it('removes listener when isActive becomes false', () => {
    const onUnload = vi.fn();
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useUnloadCleaner(active, onUnload),
      { initialProps: { active: true } },
    );

    rerender({ active: false });
    window.dispatchEvent(new Event('pagehide'));

    expect(onUnload).not.toHaveBeenCalled();
  });

  it('removes listener on unmount', () => {
    const onUnload = vi.fn();
    const { unmount } = renderHook(() => useUnloadCleaner(true, onUnload));

    unmount();
    window.dispatchEvent(new Event('pagehide'));

    expect(onUnload).not.toHaveBeenCalled();
  });

  it('adds listener when isActive goes from false to true', () => {
    const onUnload = vi.fn();
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useUnloadCleaner(active, onUnload),
      { initialProps: { active: false } },
    );

    rerender({ active: true });
    window.dispatchEvent(new Event('pagehide'));

    expect(onUnload).toHaveBeenCalledOnce();
  });

  it('does not call onUnload on beforeunload (user may cancel navigation)', () => {
    const onUnload = vi.fn();
    renderHook(() => useUnloadCleaner(true, onUnload));

    window.dispatchEvent(new Event('beforeunload'));

    expect(onUnload).not.toHaveBeenCalled();
  });

  it('uses pagehide not beforeunload so cancelled navigation does not clear chat', () => {
    // beforeunload fires when user attempts navigation but may cancel (stay on page)
    // pagehide only fires on confirmed unload — prevents premature chat wipe
    const onUnload = vi.fn();
    renderHook(() => useUnloadCleaner(true, onUnload));

    window.dispatchEvent(new Event('beforeunload')); // simulates user attempting then cancelling
    expect(onUnload).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('pagehide'));     // simulates confirmed tab close
    expect(onUnload).toHaveBeenCalledOnce();
  });
});
