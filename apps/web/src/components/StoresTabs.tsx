'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from '@/lib/session';

/**
 * Uniform and re-orders as one place (owner, 9 Oct 2026: "one uniform and re-order setup").
 * Re-orders are replacement kit and site supplies; uniform orders are what guards order on the
 * post phone. Shown only to people who may see both.
 */
export function StoresTabs() {
  const { can } = useSession();
  const path = usePathname();
  if (!can('uniform.view') || !can('reorders.view')) return null;
  const tabs = [
    { href: '/uniform', label: 'Uniform orders' },
    { href: '/reorders', label: 'Re-orders' },
  ];
  return (
    <nav className="section-tabs" aria-label="Stores">
      {tabs.map((t) => {
        const on = path === t.href || path.startsWith(`${t.href}/`);
        return (
          <Link key={t.href} href={t.href} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
