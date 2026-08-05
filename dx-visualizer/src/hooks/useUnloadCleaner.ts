import { useEffect, useRef } from 'react';

export function useUnloadCleaner(isActive: boolean, onUnload: () => void) {
  const onUnloadRef = useRef(onUnload);

  // Keep the latest callback in a ref (written after commit, not during render)
  // so the pagehide listener below isn't torn down and re-bound on every render.
  useEffect(() => {
    onUnloadRef.current = onUnload;
  }, [onUnload]);

  useEffect(() => {
    if (!isActive) return;
    const handler = () => onUnloadRef.current();
    window.addEventListener('pagehide', handler);
    return () => window.removeEventListener('pagehide', handler);
  }, [isActive]);
}
