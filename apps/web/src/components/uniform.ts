/** Pill colours for uniform order statuses. */
export const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'blue' | 'grey'> = {
  requested: 'amber',
  approved: 'blue',
  ready: 'blue',
  with_supervisor: 'blue',
  received: 'green',
  declined: 'grey',
};
