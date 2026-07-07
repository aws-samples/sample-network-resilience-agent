import { useEffect, useRef, useState } from 'react';

const SESSION_TIMEOUT_MS = 15 * 60 * 1000;
const WARNING_OFFSET_MS = 60 * 1000; // warn 60s before expiry

export function useSessionTimeout(isActive: boolean, onExpire: () => void) {
  const lastActivityRef = useRef(Date.now());
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  const expiredRef = useRef(false);

  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!isActive) {
      setSecondsLeft(null);
      expiredRef.current = false;
      return;
    }

    lastActivityRef.current = Date.now();
    expiredRef.current = false;

    const EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'] as const;
    const handleActivity = () => {
      lastActivityRef.current = Date.now();
      setSecondsLeft(null);
    };

    EVENTS.forEach((e) => window.addEventListener(e, handleActivity, { passive: true }));

    const tick = setInterval(() => {
      if (expiredRef.current) return;
      const idle = Date.now() - lastActivityRef.current;
      if (idle >= SESSION_TIMEOUT_MS) {
        expiredRef.current = true;
        onExpireRef.current();
      } else if (idle >= SESSION_TIMEOUT_MS - WARNING_OFFSET_MS) {
        setSecondsLeft(Math.ceil((SESSION_TIMEOUT_MS - idle) / 1000));
      } else {
        setSecondsLeft(null);
      }
    }, 1000);

    return () => {
      EVENTS.forEach((e) => window.removeEventListener(e, handleActivity));
      clearInterval(tick);
    };
  }, [isActive]);

  return { isWarning: secondsLeft !== null, secondsLeft };
}