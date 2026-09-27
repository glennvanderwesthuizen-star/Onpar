'use client';

import { REORDER_STAGE_LABELS, ReorderStage } from '@onpar/rules';
import { Pill } from './ui';

export interface Reorder {
  id: string;
  number: number;
  kind: 'personal' | 'site';
  item: string;
  size: string | null;
  assetNumber: string | null;
  quantity: string | null;
  comment: string;
  stage: ReorderStage;
  requestedAt: string;
  receivedAt: string | null;
  lateSynced: boolean;
  siteName: string;
  employeeName: string;
  employeeNumber: string;
  assigneeName: string | null;
  assigneePhone: string | null;
  assigneePersonId: string | null;
}

export function StagePillR({ stage }: { stage: ReorderStage }) {
  return <Pill tone={stage === 'received' ? 'green' : stage === 'requested' ? 'amber' : 'blue'}>{REORDER_STAGE_LABELS[stage]}</Pill>;
}

export function itemText(r: Pick<Reorder, 'item' | 'size' | 'assetNumber' | 'quantity'>) {
  return [r.item, r.size && `size ${r.size}`, r.assetNumber && `asset ${r.assetNumber}`, r.quantity].filter(Boolean).join(' · ');
}
