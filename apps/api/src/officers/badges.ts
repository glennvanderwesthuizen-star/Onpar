import { randomBytes } from 'node:crypto';
import { Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { badgeUrl, isBadgeToken } from '@onpar/rules';
import { z } from 'zod';
import { assertSiteAccess, CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { CONFIG, Config } from '../config';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';

/** A new random card code: 18 bytes, 24 characters, no personal information. */
export function newBadgeToken(): string {
  return randomBytes(18).toString('base64url');
}

/** Gives a guard a valid ID card if he has none. Returns the valid card's code. */
export async function ensureBadge(tx: Tx, employeeId: string, userId: string | null): Promise<string> {
  const valid = (await tx.query('SELECT token FROM employee_badges WHERE employee_id = $1 AND revoked_at IS NULL', [employeeId])).rows[0];
  if (valid) return valid.token;
  const token = newBadgeToken();
  await tx.query(
    'INSERT INTO employee_badges (company_id, employee_id, token, issued_by) VALUES (app_company_id(), $1, $2, $3)',
    [employeeId, token, userId],
  );
  return token;
}

/** The guard a valid card belongs to (for the post phone), or why it does not sign in. */
export async function badgeOwner(tx: Tx, token: string): Promise<{ employeeId: string } | 'cancelled' | null> {
  if (!isBadgeToken(token)) return null;
  const b = (await tx.query('SELECT employee_id, revoked_at FROM employee_badges WHERE token = $1', [token])).rows[0];
  if (!b) return null;
  return b.revoked_at ? 'cancelled' : { employeeId: b.employee_id };
}

const ReissueBody = z.object({ reason: z.string().trim().min(3, 'Say why, e.g. card lost.').max(300) });

@Controller()
@UseGuards(UserAuthGuard)
export class BadgesController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /** Cards to print: every active guard at the sites the user can see, each given a card if he has none. */
  @Get('badges')
  @RequirePermission('officers.enrol')
  list(@CurrentUser() user: UserPrincipal, @Query('siteId') siteId?: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const rows = (
        await tx.query(
          `SELECT e.id, e.full_name AS "fullName", e.tsf_number AS "tsfNumber", s.id AS "siteId", s.name AS "siteName",
                  EXISTS (SELECT 1 FROM employee_photos p WHERE p.employee_id = e.id AND p.kind = 'face') AS "hasPhoto"
             FROM employees e JOIN sites s ON s.id = e.home_site_id
            WHERE e.status = 'active' AND ($1::uuid[] IS NULL OR e.home_site_id = ANY($1::uuid[]))
              AND ($2::uuid IS NULL OR e.home_site_id = $2)
            ORDER BY lower(s.name), lower(e.full_name)`,
          [user.siteIds, siteId || null],
        )
      ).rows;
      const out = [];
      for (const r of rows) {
        const token = await ensureBadge(tx, r.id, user.userId);
        const issued = (await tx.query('SELECT issued_at FROM employee_badges WHERE token = $1', [token])).rows[0].issued_at;
        out.push({ ...r, qr: badgeUrl(this.config.webOrigin, token), issuedAt: issued });
      }
      return out;
    });
  }

  /**
   * A supervisor scanned a card with a phone camera and signed in. Opens the guard's record only
   * for someone allowed to see that guard; every scan is audited.
   */
  @Get('badges/scan/:token')
  @RequirePermission('officers.view')
  scan(@CurrentUser() user: UserPrincipal, @Param('token') token: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const b = isBadgeToken(token)
        ? (
            await tx.query(
              `SELECT b.employee_id, b.revoked_at, b.revoke_reason, e.full_name, e.home_site_id
                 FROM employee_badges b JOIN employees e ON e.id = b.employee_id WHERE b.token = $1`,
              [token],
            )
          ).rows[0]
        : null;
      if (!b) throw new NotFoundException('This is not an ID card of your company.');
      assertSiteAccess(user, b.home_site_id);
      await this.audit.byUser(tx, user, {
        action: 'officer.badge_scan',
        entityType: 'employee',
        entityId: b.employee_id,
        after: { cancelledCard: !!b.revoked_at },
      });
      return { employeeId: b.employee_id, fullName: b.full_name, cancelledAt: b.revoked_at, cancelReason: b.revoke_reason };
    });
  }

  /** A lost, stolen or damaged card: the old card stops working at once and a new one is issued. */
  @Post('officers/:id/badge/reissue')
  @RequirePermission('officers.enrol')
  reissue(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parseBody(ReissueBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const e = (await tx.query('SELECT home_site_id FROM employees WHERE id = $1', [id])).rows[0];
      if (!e) throw new NotFoundException('Officer not found.');
      assertSiteAccess(user, e.home_site_id);
      await tx.query(
        'UPDATE employee_badges SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE employee_id = $1 AND revoked_at IS NULL',
        [id, user.userId, reason],
      );
      const token = await ensureBadge(tx, id, user.userId);
      await this.audit.byUser(tx, user, { action: 'officer.badge_reissue', entityType: 'employee', entityId: id, reason });
      return { qr: badgeUrl(this.config.webOrigin, token) };
    });
  }
}
