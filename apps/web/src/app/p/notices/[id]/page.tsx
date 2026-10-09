'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { ErrorBanner, formatDateTime } from '@/components/ui';

interface Notice {
  id: string;
  typeLabel: string;
  subject: string;
  body: string;
  issuedAt: string;
  acknowledged: string | null;
  ackText: string;
}

/** One message. Opening it is recorded; acknowledging it does not mean agreeing. */
export default function PortalNotice({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [n, setN] = useState<Notice | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Notice>(`/portal/notices/${id}`)
      .then(setN)
      .catch((e) => (e instanceof ApiError && e.status === 401 ? router.replace('/p/login') : setError(e)));
  }, [id, router]);

  async function ack() {
    setBusy(true);
    try {
      const r = await api<Notice>(`/portal/notices/${id}/acknowledge`, { method: 'POST' });
      setN((x) => (x ? { ...x, acknowledged: r.acknowledged } : x));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="m-page">
      <p>
        <Link href="/p">← My messages</Link>
      </p>
      <ErrorBanner error={error} />
      {n && (
        <>
          <div className="card">
            <div className="mute small">
              {n.typeLabel} · {formatDateTime(n.issuedAt)}
            </div>
            <h2>{n.subject}</h2>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{n.body}</div>
          </div>
          {n.acknowledged ? (
            <div className="banner ok">You acknowledged receipt on {formatDateTime(n.acknowledged)}.</div>
          ) : (
            <div className="card">
              <p>{n.ackText}</p>
              <button className="btn" style={{ width: '100%', minHeight: 52 }} disabled={busy} onClick={ack}>
                I acknowledge receipt
              </button>
              <p className="mute small" style={{ marginTop: 8 }}>
                If you do not agree, you may still acknowledge receipt, and then speak to HR or your representative.
              </p>
            </div>
          )}
        </>
      )}
    </main>
  );
}
