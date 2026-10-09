import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { RETENTION_GROUPS, RetentionService } from './retention.service';

const RetentionBody = z.object({
  enabled: z.boolean(),
  selfieMonths: z.number().int().min(1, 'At least 1 month.').max(120),
  patrolPhotoMonths: z.number().int().min(1, 'At least 1 month.').max(120),
  boloMediaDays: z.number().int().min(7, 'At least 7 days.').max(3650).default(90),
  visitorMonths: z.number().int().min(1, 'At least 1 month.').max(120).default(12),
  recordPhotoMonths: z.number().int().min(1, 'At least 1 month.').max(120).default(12),
  staffSnapshotDays: z.number().int().min(1, 'At least 1 day.').max(3650).default(30),
  reason: z.string().trim().min(3, 'Say why, for example "periods confirmed by our POPIA adviser".'),
});

const FaceBody = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(3, 'Say why, for example "trial agreed with the guards at Estate ABC".'),
});

/** POPIA settings (brief section 9). Retention periods are for legal to confirm; On Par only applies them. */
@Controller('privacy')
@UseGuards(UserAuthGuard)
export class PrivacyController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly retention: RetentionService,
  ) {}

  /** The settings, what would be removed if switched on now, and what has been removed so far. */
  @Get('retention')
  @RequirePermission('privacy.manage')
  get(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const settings = await this.retention.settings(tx);
      const due = await this.retention.due(tx, settings, new Date());
      const removed = (await tx.query(`SELECT kind, count(*)::int AS n, max(removed_at) AS last FROM retention_log GROUP BY kind`)).rows;
      const groups = Object.entries(RETENTION_GROUPS) as [keyof typeof RETENTION_GROUPS, readonly string[]][];
      const dueKeys = new Set<string>();
      const wouldRemoveNow = Object.fromEntries(groups.map(([g]) => [g, 0])) as Record<keyof typeof RETENTION_GROUPS, number>;
      for (const r of due) {
        if (dueKeys.has(r.key)) continue;
        dueKeys.add(r.key);
        const g = groups.find(([, kinds]) => kinds.includes(r.kind));
        if (g) wouldRemoveNow[g[0]] += 1;
      }
      const removedBy = Object.fromEntries(groups.map(([g, kinds]) => [g, removed.filter((r) => kinds.includes(r.kind)).reduce((n, r) => n + r.n, 0)]));
      return {
        settings,
        wouldRemoveNow,
        removed: { ...removedBy, last: removed.reduce<string | null>((m, r) => (!m || r.last > m ? r.last : m), null) },
      };
    });
  }

  /** Automatic face matching (D-36 stage 2): off until switched on here. */
  @Get('face-matching')
  @RequirePermission('privacy.manage')
  faceMatching(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const r = (await tx.query('SELECT face_matching FROM retention_settings')).rows[0];
      const counts = (await tx.query(`SELECT verdict, count(*)::int AS n FROM face_matches GROUP BY verdict`)).rows;
      return { enabled: !!r?.face_matching, results: Object.fromEntries(counts.map((c) => [c.verdict, c.n])) };
    });
  }

  @Put('face-matching')
  @RequirePermission('privacy.manage')
  setFaceMatching(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const b = parseBody(FaceBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const before = !!(await tx.query('SELECT face_matching FROM retention_settings')).rows[0]?.face_matching;
      await tx.query(
        `INSERT INTO retention_settings (company_id, face_matching, updated_by, updated_at) VALUES (app_company_id(), $1, $2, now())
         ON CONFLICT (company_id) DO UPDATE SET face_matching = $1, updated_by = $2, updated_at = now()`,
        [b.enabled, user.userId],
      );
      await this.audit.byUser(tx, user, {
        action: 'privacy.face_matching',
        entityType: 'company',
        entityId: user.companyId,
        before: { enabled: before },
        after: { enabled: b.enabled },
        reason: b.reason,
      });
      return { enabled: b.enabled };
    });
  }

  @Put('retention')
  @RequirePermission('privacy.manage')
  update(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const b = parseBody(RetentionBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const before = await this.retention.settings(tx);
      await tx.query(
        `INSERT INTO retention_settings (company_id, enabled, selfie_months, patrol_photo_months, bolo_media_days, visitor_months, record_photo_months, staff_snapshot_days, updated_by, updated_at)
         VALUES (app_company_id(), $1, $2, $3, $5, $6, $7, $8, $4, now())
         ON CONFLICT (company_id) DO UPDATE SET enabled = $1, selfie_months = $2, patrol_photo_months = $3, bolo_media_days = $5, visitor_months = $6,
           record_photo_months = $7, staff_snapshot_days = $8, updated_by = $4, updated_at = now()`,
        [b.enabled, b.selfieMonths, b.patrolPhotoMonths, user.userId, b.boloMediaDays, b.visitorMonths, b.recordPhotoMonths, b.staffSnapshotDays],
      );
      const { reason, ...after } = b;
      await this.audit.byUser(tx, user, { action: 'privacy.retention_update', entityType: 'company', entityId: user.companyId, before, after, reason });
      return after;
    });
  }
}
