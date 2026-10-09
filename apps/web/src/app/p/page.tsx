'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { ErrorBanner, Pill, formatDateTime } from '@/components/ui';

interface Notice {
  id: string;
  typeLabel: string;
  subject: string;
  issuedAt: string;
  acknowledged: string | null;
  status: string;
  statusLabel: string;
}

/** The employee's messages from HR, newest first. */
export default function PortalHome() {
  const router = useRouter();
  const [me, setMe] = useState<{ name: string; employeeNumber: string; company: string } | null>(null);
  const [list, setList] = useState<Notice[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    (async () => {
      try {
        setMe(await api('/portal/me'));
        setList((await api<{ notices: Notice[] }>('/portal/notices')).notices);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) router.replace('/p/login');
        else setError(e);
      }
    })();
  }, [router]);

  return (
    <>
      <header className="m-top">
        <span className="brand">
          <img src="/tsf-logo.png" alt="" />
          <span className="logo">
            On<i>Par</i>
          </span>
        </span>
        <span className="m-who">
          {me?.name}
          <span className="mute small">{me?.company}</span>
        </span>
      </header>
      <main className="m-page">
        <h1>My messages</h1>
        <ErrorBanner error={error} />
        {list && !list.length && <p className="mute">You have no messages.</p>}
        {list?.map((n) => (
          <Link key={n.id} href={`/p/notices/${n.id}`} className="card" style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b>{n.subject}</b>
              {n.acknowledged ? <Pill tone="green">Acknowledged</Pill> : <Pill tone="amber">Please read</Pill>}
            </div>
            <div className="mute small">
              {n.typeLabel} · {formatDateTime(n.issuedAt)}
            </div>
          </Link>
        ))}
        <button
          className="btn ghost sm"
          style={{ marginTop: 16 }}
          onClick={async () => {
            await api('/portal/logout', { method: 'POST' }).catch(() => undefined);
            router.replace('/p/login');
          }}
        >
          Sign out
        </button>
      </main>
    </>
  );
}
