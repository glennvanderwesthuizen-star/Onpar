'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, getToken, setToken } from './api';

export interface Me {
  id: string;
  name: string;
  role: string;
  roleLabel: string;
  company: { id: string; name: string };
  siteIds: string[] | null;
  permissions: string[];
}

const Ctx = createContext<{ me: Me; can: (p: string) => boolean; signOut: () => void } | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    api<Me>('/auth/me')
      .then(setMe)
      .catch(() => router.replace('/login'));
  }, [router]);

  if (!me) return <div className="page mute">Loading…</div>;
  const signOut = () => {
    setToken(null);
    router.replace('/login');
  };
  return <Ctx.Provider value={{ me, can: (p) => me.permissions.includes(p), signOut }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
