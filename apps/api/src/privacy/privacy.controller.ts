import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { RetentionService } from './retention.service';

const RetentionBody = z.object({
  enabled: z.boolean(),
  selfieMonths: z.number().int().min(1, 'At least 1 month.').max(120),
  patrolPhotoMonths: z.number().int().min(1, 'At least 1 month.').max(120),
  reason: z.string().trim().min(3, 'Say why, for example "periods confirmed by our POPIA adviser".'),
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
      const count = (rows: { kind: string }[], kind: string) => rows.filter((r) => r.kind === kind).length;
      return {
        settings,
        wouldRemoveNow: { selfies: count(due, 'selfie'), patrolPhotos: count(due, 'patrol_photo') },
        removed: {
          selfies: removed.find((r) => r.kind === 'selfie')?.n ?? 0,
          patrolPhotos: removed.find((r) => r.kind === 'patrol_photo')?.n ?? 0,
          last: removed.reduce<string | null>((m, r) => (!m || r.last > m ? r.last : m), null),
        },
      };
    });
  }

  @Put('retention')
  @RequirePermission('privacy.manage')
  update(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const b = parseBody(RetentionBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const before = await this.retention.settings(tx);
      await tx.query(
        `INSERT INTO retention_settings (company_id, enabled, selfie_months, patrol_photo_months, updated_by, updated_at)
         VALUES (app_company_id(), $1, $2, $3, $4, now())
         ON CONFLICT (company_id) DO UPDATE SET enabled = $1, selfie_months = $2, patrol_photo_months = $3, updated_by = $4, updated_at = now()`,
        [b.enabled, b.selfieMonths, b.patrolPhotoMonths, user.userId],
      );
      const { reason, ...after } = b;
      await this.audit.byUser(tx, user, { action: 'privacy.retention_update', entityType: 'company', entityId: user.companyId, before, after, reason });
      return after;
    });
  }
}
