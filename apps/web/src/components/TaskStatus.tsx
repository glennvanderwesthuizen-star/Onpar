'use client';

import { Pill } from './ui';

export function TaskStatus({ status, review }: { status: string; review?: string | null }) {
  switch (status) {
    case 'completed':
      return <Pill tone="green">Done</Pill>;
    case 'overdue':
      return <Pill tone="amber">Overdue</Pill>;
    case 'missed':
      return <Pill tone="red">Missed</Pill>;
    case 'could_not_complete':
      return (
        <Pill tone={review === 'not_accepted' ? 'red' : review === 'accepted' ? 'blue' : 'amber'}>
          Could not complete{review === 'accepted' ? ' · accepted' : review === 'not_accepted' ? ' · not accepted' : ' · to review'}
        </Pill>
      );
    case 'cancelled':
      return <Pill tone="grey">Cancelled</Pill>;
    case 'upcoming':
      return <Pill tone="grey">Upcoming</Pill>;
    default:
      return <Pill tone="blue">To do</Pill>;
  }
}
