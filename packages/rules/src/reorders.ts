/** Re-orders and issued kit (brief section 6.7). */

/** The standard kit list. A company can change it; uniform has sizes, equipment has asset numbers. */
export const DEFAULT_KIT: { name: string; tracking: 'size' | 'asset' }[] = [
  { name: 'Shirt', tracking: 'size' },
  { name: 'Trousers', tracking: 'size' },
  { name: 'Jacket', tracking: 'size' },
  { name: 'Boots or shoes', tracking: 'size' },
  { name: 'Cap', tracking: 'size' },
  { name: 'Belt', tracking: 'size' },
  { name: 'Reflective vest', tracking: 'size' },
  { name: 'Raincoat', tracking: 'size' },
  { name: 'Radio', tracking: 'asset' },
  { name: 'Torch', tracking: 'asset' },
  { name: 'Key set', tracking: 'asset' },
];

export const REORDER_STAGES = ['requested', 'ordered', 'assigned', 'delivered', 'received'] as const;
export type ReorderStage = (typeof REORDER_STAGES)[number];
export const REORDER_STAGE_LABELS: Record<ReorderStage, string> = {
  requested: 'Requested',
  ordered: 'Ordered',
  assigned: 'Assigned for delivery',
  delivered: 'Delivered',
  received: 'Received',
};

/**
 * What management can do, and the stage each needs. "Assigned" means assigned
 * to a person to deliver it (the brief's assumption, decision D-09).
 * Received is confirmed by the guard on the device.
 */
export const REORDER_ACTIONS = {
  ordered: { from: ['requested'], label: 'Mark as ordered' },
  assigned: { from: ['requested', 'ordered', 'assigned'], label: 'Assign for delivery' },
  delivered: { from: ['assigned'], label: 'Mark as delivered' },
} as const satisfies Record<string, { from: readonly ReorderStage[]; label: string }>;
export type ReorderAction = keyof typeof REORDER_ACTIONS;

/** The guard can confirm receipt once it has been delivered, or earlier if it arrived first. */
export function canConfirmReceipt(stage: ReorderStage): boolean {
  return stage === 'delivered' || stage === 'assigned' || stage === 'ordered';
}
