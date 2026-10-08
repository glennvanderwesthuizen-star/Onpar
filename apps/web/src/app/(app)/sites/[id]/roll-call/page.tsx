'use client';

import Link from 'next/link';
import { use } from 'react';
import { RollCall } from '@/components/RollCall';

export default function RollCallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <>
      <p>
        <Link href={`/sites/${id}`}>← Back to the site</Link>
      </p>
      <h1>Emergency roll-call</h1>
      <RollCall siteId={id} full />
    </>
  );
}
