'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { PanicAlert } from '@/components/PanicBanner';

/**
 * Runs `fn` every `ms` while the page is on screen, and once straight away when it comes
 * back into view (phase 2: hidden tabs no longer ask the server for anything).
 */
export function useVisibleInterval(fn: () => void, ms: number, deps: unknown[] = []) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    let t: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (t === null) t = setInterval(() => saved.current(), ms);
    };
    const stop = () => {
      if (t !== null) clearInterval(t);
      t = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        saved.current();
        start();
      } else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}

export interface OpenBolo {
  id: string;
  reportedAt: string;
  acknowledgedAt: string | null;
  siteName: string | null;
  postName: string | null;
  deviceLabel: string;
  employeeName: string | null;
}
export interface Banners {
  panics: PanicAlert[] | null;
  bolos: OpenBolo[] | null;
  unread: number;
}

// One request for the panic banner, the BOLO banner and the Alerts count, shared by all three.
let current: Banners | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<(b: Banners) => void>();

export function refreshBanners(): Promise<void> {
  inFlight ??= api<Banners>('/banners')
    .then((b) => {
      current = b;
      listeners.forEach((l) => l(b));
    })
    .catch(() => undefined)
    .finally(() => (inFlight = null));
  return inFlight;
}

/** The latest banners, checked every 15 seconds while the page is on screen, and on each page change. */
export function useBanners(path: string): Banners | null {
  const [b, setB] = useState<Banners | null>(current);
  useEffect(() => {
    listeners.add(setB);
    void refreshBanners();
    window.addEventListener('onpar:alerts', refreshBanners);
    return () => {
      listeners.delete(setB);
      window.removeEventListener('onpar:alerts', refreshBanners);
    };
  }, [path]);
  useVisibleInterval(() => void refreshBanners(), 15_000);
  return b;
}

/**
 * The same as setInterval, but paused while the page is not on screen and run once when it
 * comes back. Returns the function that stops it (for a useEffect clean-up).
 */
export function everyWhileVisible(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    if (t === null) t = setInterval(fn, ms);
  };
  const stop = () => {
    if (t !== null) clearInterval(t);
    t = null;
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      fn();
      start();
    } else stop();
  };
  if (document.visibilityState === 'visible') start();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
