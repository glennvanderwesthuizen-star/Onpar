'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';

export function Field({
  label,
  error,
  children,
  hint,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="f">
      <span>{label}</span>
      {children}
      {hint && !error && <div className="mute small">{hint}</div>}
      {error && <div className="err">{error}</div>}
    </label>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  const message = e?.message ?? (error instanceof Error ? error.message : 'Something went wrong.');
  return (
    <div className="banner err" role="alert">
      {message}
    </div>
  );
}

export function Pill({ tone, children }: { tone: 'green' | 'amber' | 'red' | 'blue' | 'grey'; children: React.ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function StatusPill({ status }: { status: string }) {
  const tone = status === 'COMPLIANT' ? 'green' : status === 'EXPIRING' ? 'amber' : 'red';
  const label = status === 'COMPLIANT' ? 'Compliant' : status === 'EXPIRING' ? 'Expiring' : 'Expired';
  return <Pill tone={tone}>{label}</Pill>;
}

/** Loads data once on mount and on `reload()`. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    load()
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

export function formatDate(d: string | null | undefined) {
  if (!d) return '—';
  return new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-ZA', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function formatDateTime(d: string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
