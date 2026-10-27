import { useEffect } from 'react';

export default function useVisiblePolling(task, interval, enabled = true, immediate = false) {
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (!active || pending || document.visibilityState === 'hidden') return;
      pending = true;
      try { await task(() => active); } finally { pending = false; }
    };
    const trigger = () => { void refresh().catch(() => undefined); };
    const timer = window.setInterval(trigger, interval);
    document.addEventListener('visibilitychange', trigger);
    if (immediate) trigger();
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', trigger);
    };
  }, [task, interval, enabled, immediate]);
}
