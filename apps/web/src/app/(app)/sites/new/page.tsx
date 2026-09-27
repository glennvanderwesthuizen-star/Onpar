'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { EMPTY_SITE, SiteForm } from '@/components/SiteForm';

export default function NewSitePage() {
  const router = useRouter();
  return (
    <>
      <div className="head">
        <div>
          <Link href="/sites" className="mute small">
            ← Sites
          </Link>
          <h1>New site</h1>
        </div>
      </div>
      <SiteForm
        initial={EMPTY_SITE}
        onSave={async (v) => {
          const site = await api<{ id: string }>('/sites', { method: 'POST', json: v });
          router.replace(`/sites/${site.id}`);
        }}
      />
    </>
  );
}
