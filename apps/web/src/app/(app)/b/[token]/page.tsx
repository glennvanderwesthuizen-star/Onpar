'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { ErrorBanner, formatDateTime } from '@/components/ui';

interface Scan {
  employeeId: string;
  fullName: string;
  cancelledAt: string | null;
  cancelReason: string | null;
}

/**
 * Where a guard's ID badge QR code leads when scanned with an ordinary phone camera. Signing in
 * comes first (the layout sends visitors to the sign-in page and back here). Then the guard's
 * record opens, if this user may see that guard. The scan is recorded.
 */
export default function BadgeScanPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api<Scan>(`/badges/scan/${encodeURIComponent(token)}`)
      .then((s) => {
        if (!s.cancelledAt) router.replace(`/officers/${s.employeeId}`);
        else setScan(s);
      })
      .catch(setError);
  }, [token, router]);

  if (error) {
    return (
      <div className="card">
        <h1>ID card</h1>
        <ErrorBanner error={error} />
        <p className="mute">If you think this card is genuine, check that you are signed in with the right company account.</p>
      </div>
    );
  }
  if (!scan) return <p className="mute">Checking the card…</p>;
  return (
    <div className="card" style={{ borderColor: 'var(--red)', borderWidth: 2 }}>
      <h1>Cancelled card</h1>
      <p>
        This card belonged to <b>{scan.fullName}</b> and was cancelled on {formatDateTime(scan.cancelledAt!)}
        {scan.cancelReason ? `: ${scan.cancelReason}` : ''}. It no longer signs in on the post phones.
      </p>
      <Link className="btn" href={`/officers/${scan.employeeId}`}>
        Open {scan.fullName.split(' ')[0]}&apos;s record
      </Link>
    </div>
  );
}
