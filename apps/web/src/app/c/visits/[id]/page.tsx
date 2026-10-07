'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { CustomerVisit, VisitRequest } from '@/components/CustomerVisits';
import { ErrorBanner } from '@/components/ui';

/** One visitor (visitor management, step 3): where the alert "A visitor is at the gate" lands. */
export default function CustomerVisitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [visit, setVisit] = useState<CustomerVisit | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    api<CustomerVisit>(`/customer/visits/${id}`).then(setVisit).catch(setError);
  }, [id]);
  // While it waits, someone else in the unit or the guard by phone may answer it.
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <>
      <h1 className="m-h1">Visitor</h1>
      {!visit && <ErrorBanner error={error} />}
      {!visit && !error && <p className="mute">Loading…</p>}
      {visit && <VisitRequest visit={visit} onChange={(v) => (v ? setVisit(v) : load())} />}
      <Link className="btn ghost m-wide" style={{ marginTop: 12, textDecoration: 'none' }} href="/c">
        Back to Home
      </Link>
    </>
  );
}
