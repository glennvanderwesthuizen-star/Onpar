import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { assertSiteAccess, CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';

const PostingBody = z.object({ deviceId: z.string().uuid().nullable() });

/**
 * Lock or roam (owner, 7 Oct 2026). Each guard of a site is either locked to one position (a
 * post phone such as "Main gate") or roams. A locked guard is the primary on that phone while
 * he is on duty there; coming on duty elsewhere is allowed, with a warning and an alert.
 */
@Controller('sites/:siteId/postings')
@UseGuards(UserAuthGuard)
export class PostingsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private async site(tx: Tx, user: UserPrincipal, siteId: string) {
    assertSiteAccess(user, siteId);
    if (!(await tx.query('SELECT 1 FROM sites WHERE id = $1', [siteId])).rowCount) throw new NotFoundException('Site not found.');
  }

  /** The site's positions (its post phones) and its guards, with where each is locked. */
  @Get()
  @RequirePermission('roster.view')
  list(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const positions = (
        await tx.query(`SELECT id AS "deviceId", COALESCE(NULLIF(post_name, ''), label) AS name FROM devices WHERE site_id = $1 AND status NOT IN ('retired','disabled') ORDER BY lower(COALESCE(NULLIF(post_name, ''), label))`, [siteId])
      ).rows;
      const guards = (
        await tx.query(
          `SELECT e.id AS "employeeId", e.full_name AS name, p.device_id AS "deviceId" FROM employees e LEFT JOIN guard_postings p ON p.employee_id = e.id AND p.site_id = $1
            WHERE e.status = 'active' AND (e.home_site_id = $1 OR EXISTS (SELECT 1 FROM roster_allocations a WHERE a.employee_id = e.id AND a.site_id = $1 AND a.end_date IS NULL))
            ORDER BY lower(e.full_name)`,
          [siteId],
        )
      ).rows;
      return { positions, guards };
    });
  }

  /** Locks a guard to a position, or lets him roam (deviceId null). */
  @Put(':employeeId')
  @RequirePermission('roster.manage')
  set(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Param('employeeId', ParseUUIDPipe) employeeId: string, @Body() body: unknown) {
    const b = parseBody(PostingBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      if (!(await tx.query('SELECT 1 FROM employees WHERE id = $1', [employeeId])).rowCount) throw new NotFoundException('Officer not found.');
      const before = (await tx.query('SELECT device_id AS "deviceId" FROM guard_postings WHERE site_id = $1 AND employee_id = $2 FOR UPDATE', [siteId, employeeId])).rows[0] ?? { deviceId: null };
      if (b.deviceId) {
        if (!(await tx.query('SELECT 1 FROM devices WHERE id = $1 AND site_id = $2', [b.deviceId, siteId])).rowCount) throw new BadRequestException({ message: 'Choose a position of this site.', errors: { deviceId: 'Unknown position.' } });
        await tx.query(
          `INSERT INTO guard_postings (company_id, site_id, employee_id, device_id, set_by) VALUES (app_company_id(), $1, $2, $3, $4)
           ON CONFLICT (site_id, employee_id) DO UPDATE SET device_id = excluded.device_id, set_by = excluded.set_by, set_at = now()`,
          [siteId, employeeId, b.deviceId, user.userId],
        );
      } else {
        await tx.query('DELETE FROM guard_postings WHERE site_id = $1 AND employee_id = $2', [siteId, employeeId]);
      }
      await this.audit.byUser(tx, user, { action: 'guard_posting.set', entityType: 'employee', entityId: employeeId, before, after: { siteId, deviceId: b.deviceId } });
      return { ok: true };
    });
  }
}
