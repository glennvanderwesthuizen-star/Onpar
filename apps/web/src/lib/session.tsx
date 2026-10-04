'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from './api';

export interface Me {
  id: string;
  name: string;
  email: string;
  mustChangePassword: boolean;
  role: string;
  roleLabel: string;
  company: { id: string; name: string };
  siteIds: string[] | null;
  permissions: string[];
}

const Ctx = createContext<{ me: Me; can: (p: string) => boolean; signOut: () => void; refresh: () => Promise<void> } | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);

  const refresh = () =>
    api<Me>('/auth/me')
      .then(setMe)
      .catch(() => {
        // Come back here after signing in (for example a scanned ID badge).
        const here = window.location.pathname + window.location.search;
        router.replace(here && here !== '/' ? `/login?next=${encodeURIComponent(here)}` : '/login');
      });
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  if (!me) return <div className="page mute">Loading…</div>;
  const signOut = () => {
    api('/auth/logout', { method: 'POST' })
      .catch(() => undefined)
      .finally(() => router.replace('/login'));
  };
  return <Ctx.Provider value={{ me, can: (p) => me.permissions.includes(p), signOut, refresh }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
