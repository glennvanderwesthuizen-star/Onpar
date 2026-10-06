'use client';

import { AlertsList } from '@/components/AlertsList';

/** Customer app: every alert sent to this customer. */
export default function CustomerAlerts() {
  return <AlertsList base="/c/alerts" settingsHref="/c/account" />;
}
