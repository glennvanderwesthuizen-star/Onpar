'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBanner, formatDate } from './ui';

interface Badge {
  issuedAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
}

/** The guard's ID badge on his record: print it, reissue it (cancels the old card), and its history. */
export function BadgeActions({ officer, onDone }: { officer: { id: string; badges: Badge[] }; onDone: () => void }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const current = officer.badges.find((b) => !b.cancelledAt);
  const cancelled = officer.badges.filter((b) => b.cancelledAt);

  async function reissue() {
    setBusy(true);
    setError(null);
    try {
      await api(`/officers/${officer.id}/badge/reissue`, { method: 'POST', json: { reason } });
      setAsking(false);
      setReason('');
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minWidth: 260 }}>
      <div className="small mute" style={{ marginBottom: 6 }}>
        ID badge{current ? `: issued ${formatDate(current.issuedAt)}` : ''}
      </div>
      <div className="row">
        <Link className="btn ghost" href={`/officers/cards?ids=${officer.id}`}>
          Print ID badge
        </Link>
        {current && (
          <button className="btn ghost" onClick={() => setAsking(!asking)}>
            Reissue (lost or damaged)
          </button>
        )}
      </div>
      {asking && (
        <div style={{ marginTop: 8 }}>
          <p className="small" style={{ margin: '0 0 6px' }}>
            The old card stops working at once, on every post phone. Print the new one afterwards.
          </p>
          <div className="row">
            <input style={{ flex: 1 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why, e.g. card lost" />
            <button className="btn" disabled={busy || reason.trim().length < 3} onClick={reissue}>
              Cancel old card and reissue
            </button>
          </div>
          <ErrorBanner error={error} />
        </div>
      )}
      {cancelled.length > 0 && (
        <div className="small mute" style={{ marginTop: 8 }}>
          Cancelled cards:{' '}
          {cancelled.map((b) => `${formatDate(b.cancelledAt!)} (${b.cancelReason})`).join('; ')}
        </div>
      )}
    </div>
  );
}
