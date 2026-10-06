'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Where the home-screen icon opens. One icon serves everyone, so this sends each person to
 * their own place: a supervisor to the phone view, other staff to the website, a customer to
 * the customer app, and anyone not signed in to the sign-in page.
 */
export default function Start() {
  const router = useRouter();
  useEffect(() => {
    const get = (path: string) => fetch(`/api${path}`, { headers: { 'X-Requested-With': 'OnPar' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    (async () => {
      const staff = await get('/auth/me');
      if (staff) return router.replace(staff.permissions?.includes('attendance.view') && window.innerWidth <= 640 ? '/m' : '/');
      const customer = await get('/customer/me');
      router.replace(customer ? '/c' : '/login');
    })();
  }, [router]);
  return <div className="page mute">Loading…</div>;
}
