'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBanner, formatDateTime, useLoad } from '@/components/ui';

interface Alert {
  id: string;
  kind: string;
  kindLabel: string;
  title: string;
  body: string;
  url: string;
  siteName: string | null;
  at: string;
  readAt: string | null;
  openedAt: string | null;
}

/** A page inside On Par only, never another address. */
const safe = (url: string) => (url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\') ? url : '/alerts');

/**
 * The alerts list: every alert raised for the signed-in person, whether or not it reached a
 * phone. Tapping an alert on the phone lands here with `?open=<id>`, which records that it was
 * opened and goes on to the page it is about.
 */
export default function AlertsPage() {
  const router = useRouter();
  const { data, error, reload } = useLoad(() => api<{ unread: number; alerts: Alert[] }>('/notifications'));
  const [opened, setOpened] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('open');
    if (!id) return;
    api<{ url: string }>(`/notifications/${id}/read`, { method: 'POST', json: { opened: true } })
      .then((r) => {
        const to = safe(r.url);
        if (to !== '/alerts') return router.replace(to);
        setOpened(id);
        router.replace('/alerts');
        reload();
        window.dispatchEvent(new Event('onpar:alerts'));
      })
      // An alert meant for someone else who used this phone: just show the list.
      .catch(() => router.replace('/alerts'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function open(a: Alert) {
    setActionError(null);
    try {
      if (!a.readAt) await api(`/notifications/${a.id}/read`, { method: 'POST', json: {} });
      window.dispatchEvent(new Event('onpar:alerts'));
      const to = safe(a.url);
      if (to !== '/alerts') router.push(to);
      else reload();
    } catch (e) {
      setActionError(e);
    }
  }

  async function readAll() {
    setActionError(null);
    try {
      await api('/notifications/read-all', { method: 'POST' });
      window.dispatchEvent(new Event('onpar:alerts'));
      reload();
    } catch (e) {
      setActionError(e);
    }
  }

  return (
    <>
      <div className="head">
        <div>
          <h1>Alerts</h1>
          <p className="mute">Everything On Par has alerted you about, newest first.</p>
        </div>
        <div className="row">
          {!!data?.unread && (
            <button className="btn ghost" onClick={readAll}>
              Mark all as read
            </button>
          )}
          <Link className="btn ghost" href="/account">
            Alert settings
          </Link>
        </div>
      </div>
      <ErrorBanner error={error ?? actionError} />
      {data && data.alerts.length === 0 && (
        <div className="card">
          <p>No alerts yet.</p>
          <p className="mute small">
            To get alerts on your phone, open <Link href="/account">My account</Link> and choose “Allow alerts on this device”.
          </p>
        </div>
      )}
      {data && data.alerts.length > 0 && (
        <div className="card alerts-list">
          {data.alerts.map((a) => (
            <button key={a.id} className={`alert-row${a.readAt ? '' : ' unread'}${a.id === opened ? ' opened' : ''}`} onClick={() => open(a)}>
              <span className="dot" aria-hidden="true" />
              <span className="what">
                <b>{a.title}</b>
                {!a.readAt && <span className="sr-only"> (unread)</span>}
                {a.body && <span className="body">{a.body}</span>}
                <span className="mute small">
                  {a.kindLabel}
                  {a.siteName ? ` · ${a.siteName}` : ''} · {formatDateTime(a.at)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
