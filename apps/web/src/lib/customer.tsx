'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/** The signed-in customer (phase 3, D-39): the client or a tenant of a site. */
export interface Customer {
  id: string;
  kind: 'client' | 'tenant';
  kindLabel: string;
  fullName: string;
  email: string;
  phone: string;
  secondContactName: string;
  secondContactPhone: string;
  muteExitAlerts: boolean;
  mustChangePassword: boolean;
  siteName: string;
  siteAddress: string;
  unitName: string | null;
  companyName: string;
}

const Ctx = createContext<{ me: Customer; refresh: () => Promise<void>; signOut: () => void } | null>(null);

export function CustomerProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Customer | null>(null);

  // Asked for directly, so that a member of staff who lands here is sent to their own pages
  // rather than to the sign-in page.
  const refresh = async () => {
    const r = await fetch('/api/customer/me', { headers: { 'X-Requested-With': 'OnPar' } }).catch(() => null);
    if (r?.ok) return setMe(await r.json());
    const staff = await fetch('/api/auth/me', { headers: { 'X-Requested-With': 'OnPar' } }).catch(() => null);
    if (staff?.ok) return router.replace('/start');
    const here = window.location.pathname + window.location.search;
    router.replace(`/login?next=${encodeURIComponent(here)}`);
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!me) return <div className="page mute">Loading…</div>;
  const signOut = () => {
    fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'OnPar' } })
      .catch(() => undefined)
      .finally(() => router.replace('/login'));
  };
  return <Ctx.Provider value={{ me, refresh, signOut }}>{children}</Ctx.Provider>;
}

export function useCustomer() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCustomer outside CustomerProvider');
  return v;
}
