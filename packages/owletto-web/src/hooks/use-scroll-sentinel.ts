import { useEffect, useRef } from 'react';

interface UseScrollSentinelOptions {
  onIntersect: () => void;
  enabled: boolean;
  rootMargin?: string;
}

export function useScrollSentinel({
  onIntersect,
  enabled,
  rootMargin = '400px',
}: UseScrollSentinelOptions) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onIntersect);
  callbackRef.current = onIntersect;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !enabled) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          callbackRef.current();
        }
      },
      { rootMargin }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, rootMargin]);

  return sentinelRef;
}
