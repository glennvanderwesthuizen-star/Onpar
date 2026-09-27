import { Injectable } from '@nestjs/common';
import {
  computeScore,
  mergeScoring,
  queryDeadline,
  sastDate,
  EventType,
  EVENT_TYPES,
  ScoringConfig,
} from '@onpar/rules';
import { Tx } from '../db/db.service';

export interface AutoEvent {
  employeeId: string;
  siteId: string | null;
  date: string;
  type: EventType;
  sourceType: 'attendance' | 'task' | 'report' | 'training' | 'patrol';
  sourceId: string;
  evidence: string;
  /** Only for patrol points, which come from the site's allocation rather than the rules table. */
  impact?: number;
}

/**
 * The scoring engine. The only place that decides points: other modules
 * report what happened, and this turns it into events using the company's
 * current rules (section 6.8: never hard-code points elsewhere).
 */
@Injectable()
export class ScoringService {
  async config(tx: Tx): Promise<ScoringConfig> {
    const row = (await tx.query('SELECT config FROM scoring_settings')).rows[0];
    return mergeScoring(row?.config);
  }

  /**
   * Records an automatic event. Uses the points in force now, so a later rule
   * change only affects later events. Safe to call twice for the same thing.
   * Types worth 0 points are still recorded, so the history is complete.
   */
  async record(tx: Tx, e: AutoEvent): Promise<string | null> {
    const c = await this.config(tx);
    const r = await tx.query(
      `INSERT INTO performance_events (company_id, employee_id, site_id, event_date, event_type, impact, source_type,
                                       source_id, evidence, created_by_type)
       VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, 'system')
       ON CONFLICT (source_type, source_id, event_type, employee_id)
         WHERE source_id IS NOT NULL AND reverses_event_id IS NULL AND source_type <> 'manual'
       DO NOTHING
       RETURNING id`,
      [e.employeeId, e.siteId, e.date, e.type, e.impact ?? c.points[e.type], e.sourceType, e.sourceId, e.evidence],
    );
    return r.rows[0]?.id ?? null;
  }

  /**
   * Adds an event that exactly offsets another, on the same day, so the
   * original stays visible. Returns null if it was already reversed.
   */
  async reverse(
    tx: Tx,
    eventId: string,
    reason: string,
    by: { type: 'system' } | { type: 'user'; id: string; label: string },
  ): Promise<string | null> {
    const ev = (await tx.query('SELECT * FROM performance_events WHERE id = $1', [eventId])).rows[0];
    if (!ev || ev.event_type === 'reversal') return null;
    const r = await tx.query(
      `INSERT INTO performance_events (company_id, employee_id, site_id, event_date, event_type, impact, source_type,
                                       source_id, evidence, reverses_event_id, created_by_type, created_by,
                                       created_by_label, reason)
       VALUES (app_company_id(), $1, $2, $3, 'reversal', $4, 'reversal', $5, $6, $5, $7, $8, $9, $10)
       ON CONFLICT (reverses_event_id) DO NOTHING
       RETURNING id`,
      [
        ev.employee_id,
        ev.site_id,
        ev.event_date,
        -Number(ev.impact),
        eventId,
        `Reverses: ${EVENT_TYPES[ev.event_type as EventType]?.label ?? ev.event_type}`,
        by.type,
        by.type === 'user' ? by.id : null,
        by.type === 'user' ? by.label : 'System',
        reason,
      ],
    );
    return r.rows[0]?.id ?? null;
  }

  /**
   * Reverses every live (not yet reversed) automatic event of a type for a
   * source, for all officers it applied to. Returns the first reversal's ID, or null if none.
   */
  async reverseFor(tx: Tx, sourceType: string, sourceId: string, type: EventType, reason: string, by: Parameters<ScoringService['reverse']>[3]) {
    const events = (
      await tx.query(
        `SELECT e.id FROM performance_events e
          WHERE e.source_type = $1 AND e.source_id = $2 AND e.event_type = $3
            AND NOT EXISTS (SELECT 1 FROM performance_events r WHERE r.reverses_event_id = e.id)`,
        [sourceType, sourceId, type],
      )
    ).rows;
    let first: string | null = null;
    for (const ev of events) first ??= await this.reverse(tx, ev.id, reason, by);
    return first;
  }

  /** An employee's score today, with every event in the window and why. */
  async employeeScore(tx: Tx, employeeId: string, now = new Date()) {
    const c = await this.config(tx);
    const today = sastDate(now);
    const events = (
      await tx.query(
        `SELECT e.id, e.event_date AS "date", e.event_type AS "type", e.impact::float AS "impact", e.source_type AS "sourceType",
                e.source_id AS "sourceId", e.evidence, e.reverses_event_id AS "reversesEventId", e.created_by_label AS "createdBy",
                e.reason, e.created_at AS "createdAt", s.name AS "siteName",
                r.id AS "reversedBy", q.id AS "queryId", q.status AS "queryStatus", q.text AS "queryText",
                q.answer AS "queryAnswer", q.answer_due AS "queryAnswerDue"
           FROM performance_events e
           LEFT JOIN sites s ON s.id = e.site_id
           LEFT JOIN performance_events r ON r.reverses_event_id = e.id
           LEFT JOIN score_queries q ON q.event_id = e.id
          WHERE e.employee_id = $1 AND e.event_date >= $2 AND e.event_date <= $3
          ORDER BY e.event_date DESC, e.created_at DESC`,
        [employeeId, computeScore([], today, c).from, today],
      )
    ).rows.map((e) => ({
      ...e,
      label: e.type === 'reversal' ? 'Reversal' : EVENT_TYPES[e.type as EventType]?.label ?? e.type,
      queryUntil: e.impact < 0 && e.type !== 'reversal' ? queryDeadline(e.date, c) : null,
      canQuery: e.impact < 0 && e.type !== 'reversal' && !e.reversedBy && !e.queryId && today <= queryDeadline(e.date, c),
    }));
    return { ...computeScore(events, today, c), events };
  }
}
