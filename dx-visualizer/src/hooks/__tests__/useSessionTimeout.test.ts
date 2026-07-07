// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionTimeout } from '../useSessionTimeout';

const SESSION_MS = 15 * 60 * 1000;
const WARNING_MS = 14 * 60 * 1000;

describe('useSessionTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when isActive is false', () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useSessionTimeout(false, onExpire));

    act(() => { vi.advanceTimersByTime(SESSION_MS + 1000); });

    expect(onExpire).not.toHaveBeenCalled();
    expect(result.current.isWarning).toBe(false);
    expect(result.current.secondsLeft).toBeNull();
  });

  it('shows warning at 14 minutes of inactivity', () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useSessionTimeout(true, onExpire));

    act(() => { vi.advanceTimersByTime(WARNING_MS + 1000); });

    expect(result.current.isWarning).toBe(true);
    expect(result.current.secondsLeft).toBeGreaterThan(0);
    expect(result.current.secondsLeft).toBeLessThanOrEqual(60);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('calls onExpire after 15 minutes of inactivity', () => {
    const onExpire = vi.fn();
    renderHook(() => useSessionTimeout(true, onExpire));

    act(() => { vi.advanceTimersByTime(SESSION_MS + 1000); });

    expect(onExpire).toHaveBeenCalledOnce();
  });

  it('does not call onExpire more than once', () => {
    const onExpire = vi.fn();
    renderHook(() => useSessionTimeout(true, onExpire));

    act(() => { vi.advanceTimersByTime(SESSION_MS * 2); });

    expect(onExpire).toHaveBeenCalledOnce();
  });

  it('resets warning on user activity', () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useSessionTimeout(true, onExpire));

    act(() => { vi.advanceTimersByTime(WARNING_MS + 1000); });
    expect(result.current.isWarning).toBe(true);

    act(() => { window.dispatchEvent(new MouseEvent('mousemove')); });

    expect(result.current.isWarning).toBe(false);
    expect(result.current.secondsLeft).toBeNull();
  });

  it('resets expiry on user activity before timeout', () => {
    const onExpire = vi.fn();
    renderHook(() => useSessionTimeout(true, onExpire));

    // Advance to warning zone, then simulate activity — timer resets
    act(() => { vi.advanceTimersByTime(WARNING_MS + 1000); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown')); });
    // Advance less than a full session from the reset point — should not expire
    act(() => { vi.advanceTimersByTime(SESSION_MS - 2000); });

    expect(onExpire).not.toHaveBeenCalled();
  });

  it('stops timer when isActive becomes false', () => {
    const onExpire = vi.fn();
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useSessionTimeout(active, onExpire),
      { initialProps: { active: true } },
    );

    act(() => { vi.advanceTimersByTime(WARNING_MS); });
    rerender({ active: false });
    act(() => { vi.advanceTimersByTime(SESSION_MS); });

    expect(onExpire).not.toHaveBeenCalled();
  });

  it('clears warning state when isActive becomes false', () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useSessionTimeout(active, vi.fn()),
      { initialProps: { active: true } },
    );

    act(() => { vi.advanceTimersByTime(WARNING_MS + 1000); });
    expect(result.current.isWarning).toBe(true);

    rerender({ active: false });

    expect(result.current.isWarning).toBe(false);
    expect(result.current.secondsLeft).toBeNull();
  });

  it('restarts timer when isActive goes from false to true', () => {
    const onExpire = vi.fn();
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useSessionTimeout(active, onExpire),
      { initialProps: { active: false } },
    );

    rerender({ active: true });
    act(() => { vi.advanceTimersByTime(SESSION_MS + 1000); });

    expect(onExpire).toHaveBeenCalledOnce();
  });

  it('invokes all cleanup side-effects passed via onExpire', () => {
    const clearChat = vi.fn();
    const setCredentials = vi.fn();
    const onExpire = vi.fn(() => {
      setCredentials(null);
      clearChat();
    });

    renderHook(() => useSessionTimeout(true, onExpire));
    act(() => { vi.advanceTimersByTime(SESSION_MS + 1000); });

    expect(onExpire).toHaveBeenCalledOnce();
    expect(setCredentials).toHaveBeenCalledWith(null);
    expect(clearChat).toHaveBeenCalledOnce();
  });
});
