import { useEffect, useRef, useState } from 'react';

const SESSION_TIMEOUT_MS = 15 * 60 * 1000;
const WARNING_OFFSET_MS = 60 * 1000; // warn 60s before expiry

export function useSessionTimeout(isActive: boolean, onExpire: () => void) {
  // Seeded by the effect below when the session goes active; never read before then.
  const lastActivityRef = useRef(0);
  const onExpireRef = useRef(onExpire);
  const expiredRef = useRef(false);

  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  // Drop any in-flight warning the moment isActive flips (sign-out / re-connect),
  // adjusting state during render rather than in an effect so the countdown can't
  // be observed for a frame after the session ended.
  const [wasActive, setWasActive] = useState(isActive);
  if (wasActive !== isActive) {
    setWasActive(isActive);
    setSecondsLeft(null);
  }

  // Keep the latest callback in a ref (written after commit, not during render) so
  // the interval below isn't torn down and restarted whenever the caller passes a
  // fresh closure — that would reset the idle countdown on every App re-render.
  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  useEffect(() => {
    if (!isActive) {
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