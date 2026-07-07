import { useEffect, useRef } from 'react';

export function useUnloadCleaner(isActive: boolean, onUnload: () => void) {
  const onUnloadRef = useRef(onUnload);
  onUnloadRef.current = onUnload;

  useEffect(() => {
    if (!isActive) return;
    const handler = () => onUnloadRef.current();
    window.addEventListener('pagehide', handler);
    return () => window.removeEventListener('pagehide', handler);
  }, [isActive]);
}
