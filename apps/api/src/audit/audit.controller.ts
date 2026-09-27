import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { DbService } from '../db/db.service';

@Controller('audit')
@UseGuards(UserAuthGuard)
@RequirePermission('audit.view')
export class AuditController {
  constructor(private readonly db: DbService) {}

  @Get()
  list(@CurrentUser() user: UserPrincipal, @Query('entityId') entityId?: string, @Query('limit') limit?: string) {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.db.withTenant(user.companyId, async (tx) => {
      const r = await tx.query(
        `SELECT id, at, actor_type, actor_label, action, entity_type, entity_id, before, after, reason
           FROM audit_log
          WHERE ($1::uuid IS NULL OR entity_id = $1::uuid)
          ORDER BY at DESC, id DESC LIMIT $2`,
        [entityId || null, n],
      );
      return r.rows;
    });
  }
}
