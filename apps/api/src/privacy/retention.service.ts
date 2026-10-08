import { GoneException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { DbService, Tx } from '../db/db.service';
import { StorageService } from '../storage/storage.service';

export interface RetentionSettings {
  enabled: boolean;
  selfieMonths: number;
  patrolPhotoMonths: number;
  /** BOLO photos, videos and voice notes (POPIA P-3, P-5). */
  boloMediaDays: number;
  /** Visitor photos, document photos and a visitor's details (visitor specification: 12 months). */
  visitorMonths: number;
}
export const DEFAULT_RETENTION: RetentionSettings = { enabled: false, selfieMonths: 12, patrolPhotoMonths: 12, boloMediaDays: 90, visitorMonths: 12 };

/** What retention removes that is a record to anonymise, not a file. */
const RECORD_KINDS = new Set(['visitor_person', 'visitor_vehicle', 'visitor_pass']);

/**
 * Removes selfies, patrol photos and BOLO media once they pass the company's retention period
 * (brief section 9: proposed 12 months, to be confirmed with legal). Off until a
 * company switches it on. The record stays; only the image is removed, and logged.
 */
@Injectable()
export class RetentionService implements OnModuleDestroy {
  private readonly log = new Logger('Retention');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
  ) {}

  /** Runs once a day. */
  startTimer(everyMs = 24 * 60 * 60 * 1000) {
    const tick = () => this.runAll(new Date()).catch((e) => this.log.error(`Retention run failed: ${e.message}`));
    tick();
    this.timer = setInterval(tick, everyMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async settings(tx: Tx): Promise<RetentionSettings> {
    const r = (await tx.query('SELECT enabled, selfie_months AS "selfieMonths", patrol_photo_months AS "patrolPhotoMonths", bolo_media_days AS "boloMediaDays", visitor_months AS "visitorMonths" FROM retention_settings')).rows[0];
    return r ?? DEFAULT_RETENTION;
  }

  /** Photos past their period and not yet removed. */
  async due(tx: Tx, s: RetentionSettings, now: Date) {
    return (
      await tx.query(
        `SELECT 'selfie' AS kind, d.selfie_key AS key, d.id AS source_id, d.official_at AS taken_at
           FROM declarations d
          WHERE d.selfie_key IS NOT NULL AND d.official_at < $1::timestamptz - make_interval(months => $2)
            AND NOT EXISTS (SELECT 1 FROM retention_log l WHERE l.storage_key = d.selfie_key)
         UNION ALL
         SELECT 'patrol_photo', v.photo_key, v.patrol_id, v.scanned_at
           FROM patrol_visits v
          WHERE v.photo_key IS NOT NULL AND v.scanned_at < $1::timestamptz - make_interval(months => $3)
            AND NOT EXISTS (SELECT 1 FROM retention_log l WHERE l.storage_key = v.photo_key)
         UNION ALL
         SELECT 'bolo_media', m.key, b.id, b.reported_at
           FROM bolos b CROSS JOIN LATERAL (VALUES (b.photo_key), (b.voice_key), (b.video_key)) AS m(key)
          WHERE m.key IS NOT NULL AND b.reported_at < $1::timestamptz - make_interval(days => $4)
            AND NOT EXISTS (SELECT 1 FROM retention_log l WHERE l.storage_key = m.key)
         UNION ALL
         SELECT 'visit_photo', v.face_photo_key, v.id, v.captured_at
           FROM visits v
          WHERE v.face_photo_key IS NOT NULL AND v.captured_at < $1::timestamptz - make_interval(months => $5) AND v.status <> 'on_site'
            AND NOT EXISTS (SELECT 1 FROM retention_log l WHERE l.storage_key = v.face_photo_key)
         UNION ALL
         SELECT 'visit_document', d.storage_key, d.visit_id, v.captured_at
           FROM visit_documents d JOIN visits v ON v.id = d.visit_id
          WHERE v.captured_at < $1::timestamptz - make_interval(months => $5) AND v.status <> 'on_site'
            AND NOT EXISTS (SELECT 1 FROM retention_log l WHERE l.storage_key = d.storage_key)
         UNION ALL
         SELECT 'visit_exception_photo', x.photo_key, x.id, x.raised_at
           FROM visit_exceptions x
          WHERE x.photo_key IS NOT NULL AND x.raised_at < $1::timestamptz - make_interval(months => $5)
            AND NOT EXISTS (SELECT 1 FROM retention_log l WHERE l.storage_key = x.photo_key)
         UNION ALL
         -- A visitor not seen for the period: name and numbers anonymised (not while recorded as on site).
         SELECT 'visitor_person', 'visitor_person:' || p.id, p.id, p.last_seen
           FROM visitor_people p
          WHERE p.last_seen < $1::timestamptz - make_interval(months => $5)
            AND NOT EXISTS (SELECT 1 FROM visits v WHERE v.person_id = p.id AND v.status IN ('on_site','awaiting_approval'))
            AND NOT EXISTS (SELECT 1 FROM retention_log l WHERE l.storage_key = 'visitor_person:' || p.id)
         UNION ALL
         SELECT 'visitor_vehicle', 'visitor_vehicle:' || ve.id, ve.id, ve.last_seen
           FROM visitor_vehicles ve
          WHERE ve.last_seen < $1::timestamptz - make_interval(months => $5)
            AND NOT EXISTS (SELECT 1 FROM visits v WHERE v.vehicle_id = ve.id AND v.status IN ('on_site','awaiting_approval'))
            AND NOT EXISTS (SELECT 1 FROM retention_log l WHERE l.storage_key = 'visitor_vehicle:' || ve.id)
         UNION ALL
         -- An announcement that ended (or was cancelled) the period ago: the numbers it was matched on.
         SELECT 'visitor_pass', 'visitor_pass:' || ps.id, ps.id, ps.created_at
           FROM visitor_passes ps
          WHERE coalesce(ps.end_date, ps.visit_date, ps.created_at::date) < ($1::timestamptz - make_interval(months => $5))::date
            AND (ps.status <> 'active' OR ps.kind = 'once' OR ps.end_date IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM retention_log l WHERE l.storage_key = 'visitor_pass:' || ps.id)
          ORDER BY 4`,
        [now, s.selfieMonths, s.patrolPhotoMonths, s.boloMediaDays, s.visitorMonths],
      )
    ).rows as { kind: string; key: string; source_id: string; taken_at: Date }[];
  }

  async runAll(now: Date) {
    const companies = await this.db.query<{ scheduler_company_ids: string }>('SELECT * FROM scheduler_company_ids()');
    let removed = 0;
    for (const { scheduler_company_ids: companyId } of companies) removed += await this.run(companyId, now);
    return removed;
  }

  /** Removes what is due for one company, if it has switched retention on. */
  async run(companyId: string, now: Date): Promise<number> {
    return this.db.withTenant(companyId, async (tx) => {
      const s = await this.settings(tx);
      if (!s.enabled) return 0;
      const items = await this.due(tx, s, now);
      for (const it of items) {
        // If removing a file fails, the whole run rolls back and the next run tries again (removing twice is harmless).
        await tx.query(
          `INSERT INTO retention_log (company_id, kind, storage_key, source_id, taken_at) VALUES (app_company_id(), $1, $2, $3, $4)`,
          [it.kind, it.key, it.source_id, it.taken_at],
        );
        if (RECORD_KINDS.has(it.kind)) await this.anonymise(tx, it.kind, it.source_id);
        else await this.storage.remove(it.key);
      }
      return items.length;
    });
  }

  /** A visitor's details replaced, so the visit still counts but no longer says who it was. */
  private async anonymise(tx: Tx, kind: string, id: string) {
    if (kind === 'visitor_person') await tx.query(`UPDATE visitor_people SET id_number = 'REMOVED-' || id, surname = 'Removed under retention', names = '' WHERE id = $1`, [id]);
    if (kind === 'visitor_vehicle') await tx.query(`UPDATE visitor_vehicles SET registration = 'REMOVED-' || id, vin = '' WHERE id = $1`, [id]);
    if (kind === 'visitor_pass') await tx.query(`UPDATE visitor_passes SET id_number = 'REMOVED', cell = NULL, registration = NULL, visitor_name = 'Removed under retention' WHERE id = $1`, [id]);
  }

  /** Stops a removed photo being served; says why instead of "not found". */
  async assertNotRemoved(tx: Tx, key: string) {
    if ((await tx.query('SELECT 1 FROM retention_log WHERE storage_key = $1', [key])).rowCount) {
      throw new GoneException('This photo was removed under the retention policy. The record itself is kept.');
    }
  }
}
