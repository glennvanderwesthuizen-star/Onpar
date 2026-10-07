'use client';

import { CustomerPasses } from '@/components/CustomerPasses';
import { CustomerStaff } from '@/components/UnitStaff';

/** Customer app, Visitors (visitor management, step 4): tell the gate who is coming, and keep a list of regulars. */
export default function CustomerVisitorsPage() {
  return (
    <>
      <CustomerPasses />
      <CustomerStaff />
    </>
  );
}
