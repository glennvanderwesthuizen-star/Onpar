'use client';

import { Pill } from './ui';

export interface AttendanceRow {
  id: string;
  shiftName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  dutyOnAt: string;
  dutyFromAt: string | null;
  arrivalStatus: 'ON_TIME' | 'LATE' | 'UNSCHEDULED';
  lateMinutes: number;
  departureStatus: 'ON_TIME' | 'EARLY_DEPARTURE' | 'UNSCHEDULED' | null;
  earlyMinutes: number;
  exceptionReason: string | null;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  siteName: string;
  onDeclared: boolean;
  fromDeclared: boolean;
  selfiePending: boolean;
  lateSynced: boolean;
  clockDrift: boolean;
  onBehalf: boolean;
  hasComment: boolean;
}

export const time = (d: string | null) =>
  d ? new Date(d).toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit' }) : '—';

export function ArrivalPill({ row }: { row: Pick<AttendanceRow, 'arrivalStatus' | 'lateMinutes' | 'exceptionReason'> }) {
  if (row.arrivalStatus === 'LATE' && row.exceptionReason) return <Pill tone="blue">Late {row.lateMinutes} min · approved</Pill>;
  if (row.arrivalStatus === 'LATE') return <Pill tone="red">Late {row.lateMinutes} min</Pill>;
  if (row.arrivalStatus === 'UNSCHEDULED') return <Pill tone="grey">No matching shift</Pill>;
  return <Pill tone="green">On time</Pill>;
}

export function DeparturePill({ row }: { row: Pick<AttendanceRow, 'departureStatus' | 'earlyMinutes' | 'dutyFromAt' | 'exceptionReason'> }) {
  if (!row.dutyFromAt) return <Pill tone="blue">On duty</Pill>;
  if (row.departureStatus === 'EARLY_DEPARTURE') {
    return <Pill tone={row.exceptionReason ? 'blue' : 'amber'}>Left {row.earlyMinutes} min early{row.exceptionReason ? ' · approved' : ''}</Pill>;
  }
  return <Pill tone="green">Completed</Pill>;
}

