import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  canConfirmReceipt,
  reconcileTime,
  sastDate,
  DEFAULT_KIT,
  REORDER_ACTIONS,
  REORDER_STAGE_LABELS,
  ReorderAction,
  ReorderStage,
  ROLE_LABELS,
} from '@onpar/rules';
import {
  CurrentGuard,
  CurrentUser,
  GuardAuthGuard,
  GuardPrincipal,
  RequirePermission,
  UserAuthGuard,
  UserPrincipal,
} from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';

const isoTime = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const GuardReorderBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('personal'),
    eventId: z.string().uuid(),
    issuedItemId: z.string().uuid({ message: 'Choose the item to replace.' }),
    comment: z.string().trim().min(3, 'Say why it needs replacing, for example damaged while chasing a suspect.').max(1000),
    trustedAt: isoTime,
    deviceClock: isoTime,
  }),
  z.object({
    kind: z.literal('site'),
    eventId: z.string().uuid(),
    item: z.string().trim().min(2, 'Say what the site needs, for example toilet paper.').max(200),
    quantity: z.string().trim().max(100).default(''),
    comment: z.string().trim().max(1000).default(''),
    trustedAt: isoTime,
    deviceClock: isoTime,
  }),
]);
const ReceivedBody = z.object({ eventId: z.string().uuid(), note: z.string().trim().max(500).default(''), trustedAt: isoTime, deviceClock: isoTime });
const ActBody = z.object({ note: z.string().trim().max(1000).default(''), assigneePersonId: z.string().uuid().nullable().optional() });
const CatalogueBody = z.object({
  items: z
    .array(z.object({ name: z.string().trim().min(2, 'Name the item.').max(60), tracking: z.enum(['size', 'asset']), active: z.boolean().default(true) }))
    .min(1, 'Keep at least one item.')
    .max(60),
});
const IssueBody = z.object({
  item: z.string().trim().min(2, 'Choose the item.'),
  size: z.string().trim().max(20).optional(),
  assetNumber: z.string().trim().max(40).optional(),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the date.'),
});

const COLUMNS = `r.id, r.number, r.kind, r.item, r.size, r.asset_number AS "assetNumber", r.quantity, r.comment, r.stage,
  r.requested_at AS "requestedAt", r.received_at AS "receivedAt", r.late_synced AS "lateSynced",
  r.site_id AS "siteId", s.name AS "siteName", e.full_name AS "employeeName", e.employee_number AS "employeeNumber",
  p.name AS "assigneeName", p.phone AS "assigneePhone", r.assignee_person_id AS "assigneePersonId"`;
const FROM = `reorders r JOIN sites s ON s.id = r.site_id JOIN employees e ON e.id = r.employee_id LEFT JOIN people p ON p.id = r.assignee_person_id`;

async function nextNumber(tx: Tx): Promise<number> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('reorder-number:' || app_company_id()::text))`);
  return (await tx.query('SELECT coalesce(max(number), 0) + 1 AS n FROM reorders')).rows[0].n;
}

async function catalogue(tx: Tx) {
  const rows = (await tx.query('SELECT name, tracking, active FROM kit_catalogue ORDER BY sort_order, name')).rows;
  return rows.length ? rows : DEFAULT_KIT.map((k) => ({ ...k, active: true }));
}

function history(
  tx: Tx,
  reorderId: string,
  actor: { type: 'user' | 'employee'; id: string; label: string; role: string },
  h: { stage: ReorderStage; note?: string; assigneePersonId?: string | null; at?: Date; eventId?: string | null; lateSynced?: boolean },
) {
  return tx.query(
    `INSERT INTO reorder_history (company_id, reorder_id, at, actor_type, actor_id, actor_label, actor_role, stage_after, note,
                                  assignee_person_id, event_id, late_synced)
     VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [reorderId, h.at ?? new Date(), actor.type, actor.id, actor.label, actor.role, h.stage, h.note ?? '', h.assigneePersonId ?? null, h.eventId ?? null, !!h.lateSynced],
  );
}

/** Re-orders and kit for supervisors and managers (section 6.7). */
@Controller()
@UseGuards(UserAuthGuard)
export class ReordersController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get('reorders')
  @RequirePermission('reorders.view')
  list(@CurrentUser() user: UserPrincipal, @Query('status') status = 'open', @Query('siteId') siteId?: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const rows = (
        await tx.query(
          `SELECT ${COLUMNS} FROM ${FROM}
            WHERE ($1 = 'all' OR ($1 = 'open' AND r.stage <> 'received') OR ($1 = 'closed' AND r.stage = 'received'))
              AND ($2::uuid IS NULL OR r.site_id = $2::uuid) AND ($3::uuid[] IS NULL OR r.site_id = ANY($3::uuid[]))
            ORDER BY (r.stage = 'received'), r.number DESC LIMIT 500`,
          [status, siteId || null, user.siteIds],
        )
      ).rows;
      const counts = (
        await tx.query(
          `SELECT count(*) FILTER (WHERE stage <> 'received')::int AS open, count(*) FILTER (WHERE stage = 'requested')::int AS "waiting",
                  count(*) FILTER (WHERE stage = 'received')::int AS received
             FROM reorders WHERE ($1::uuid IS NULL OR site_id = $1::uuid) AND ($2::uuid[] IS NULL OR site_id = ANY($2::uuid[]))`,
          [siteId || null, user.siteIds],
        )
      ).rows[0];
      return { rows, counts };
    });
  }

  @Get('reorders/:id')
  @RequirePermission('reorders.view')
  get(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const r = (await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE r.id = $1`, [id])).rows[0];
      if (!r || (user.siteIds && !user.siteIds.includes(r.siteId))) throw new NotFoundException('Re-order not found.');
      const h = (
        await tx.query(
          `SELECT h.id, h.at, h.received_at AS "receivedAt", h.actor_label AS "actorLabel", h.actor_role AS "actorRole", h.stage_after AS "stage",
                  h.note, h.late_synced AS "lateSynced", p.name AS "assigneeName"
             FROM reorder_history h LEFT JOIN people p ON p.id = h.assignee_person_id WHERE h.reorder_id = $1 ORDER BY h.at, h.id`,
          [id],
        )
      ).rows;
      return { ...r, history: h };
    });
  }

  /** ordered | assigned | delivered. */
  @Post('reorders/:id/:action')
  @RequirePermission('reorders.manage')
  act(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Param('action') action: string, @Body() body: unknown) {
    if (!Object.hasOwn(REORDER_ACTIONS, action)) throw new NotFoundException('Unknown action.');
    const a = action as ReorderAction;
    const b = parseBody(ActBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const r = (await tx.query('SELECT * FROM reorders WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r || (user.siteIds && !user.siteIds.includes(r.site_id))) throw new NotFoundException('Re-order not found.');
      if (!(REORDER_ACTIONS[a].from as readonly string[]).includes(r.stage)) {
        throw new ConflictException(`This re-order is at “${REORDER_STAGE_LABELS[r.stage as ReorderStage]}”, so it cannot be ${REORDER_ACTIONS[a].label.toLowerCase()} now.`);
      }
      let assignee = r.assignee_person_id;
      if (a === 'assigned') {
        const p = (await tx.query('SELECT id FROM people WHERE id = $1 AND active', [b.assigneePersonId])).rows[0];
        if (!p) throw new BadRequestException({ message: 'Choose who will deliver it.', errors: { assigneePersonId: 'Choose a person.' } });
        assignee = p.id;
      }
      await tx.query('UPDATE reorders SET stage = $2, assignee_person_id = $3 WHERE id = $1', [id, a, assignee]);
      await history(tx, id, { type: 'user', id: user.userId, label: user.name, role: ROLE_LABELS[user.role] }, { stage: a, note: b.note, assigneePersonId: a === 'assigned' ? assignee : null });
      await this.audit.byUser(tx, user, { action: `reorder.${a}`, entityType: 'reorder', entityId: id, after: b });
      return { ok: true };
    });
  }

  @Get('kit/catalogue')
  @RequirePermission('officers.view')
  getCatalogue(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, (tx) => catalogue(tx));
  }

  /** Replaces the company's kit list (section 6.7: configurable per company). Items already issued are kept. */
  @Put('kit/catalogue')
  @RequirePermission('kit.manage')
  setCatalogue(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const { items } = parseBody(CatalogueBody, body);
    const names = items.map((i) => i.name.toLowerCase());
    if (new Set(names).size !== names.length) throw new BadRequestException('Each item can appear only once.');
    return this.db.withTenant(user.companyId, async (tx) => {
      const before = await catalogue(tx);
      await tx.query('DELETE FROM kit_catalogue');
      for (const [i, it] of items.entries()) {
        await tx.query('INSERT INTO kit_catalogue (company_id, name, tracking, active, sort_order) VALUES (app_company_id(), $1, $2, $3, $4)', [it.name, it.tracking, it.active, i]);
      }
      await this.audit.byUser(tx, user, { action: 'kit.catalogue', entityType: 'company', entityId: user.companyId, before, after: items });
      return catalogue(tx);
    });
  }

  /** Issues an item to an officer after enrolment, or records a replacement. Sets the issue date. */
  @Post('officers/:id/issued-items')
  @RequirePermission('kit.issue')
  issue(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(IssueBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const e = (await tx.query('SELECT home_site_id FROM employees WHERE id = $1', [id])).rows[0];
      if (!e || (user.siteIds && !user.siteIds.includes(e.home_site_id))) throw new NotFoundException('Officer not found.');
      const existing = (await tx.query('SELECT id FROM issued_items WHERE employee_id = $1 AND lower(item) = lower($2)', [id, b.item])).rows[0];
      let itemId: string;
      if (existing) {
        itemId = existing.id;
        await tx.query('UPDATE issued_items SET size = $2, asset_number = $3, issue_date = $4, updated_at = now() WHERE id = $1', [itemId, b.size || null, b.assetNumber || null, b.issueDate]);
      } else {
        itemId = (
          await tx.query(
            `INSERT INTO issued_items (company_id, employee_id, item, size, asset_number, issue_date) VALUES (app_company_id(), $1, $2, $3, $4, $5) RETURNING id`,
            [id, b.item, b.size || null, b.assetNumber || null, b.issueDate],
          )
        ).rows[0].id;
      }
      await this.audit.byUser(tx, user, { action: 'kit.issue', entityType: 'employee', entityId: id, after: b });
      return { id: itemId };
    });
  }
}

/** Re-orders on the guard's device: the Re-order category in the Report function (section 6.7). */
@Controller('device')
@UseGuards(GuardAuthGuard)
export class GuardReordersController {
  constructor(private readonly db: DbService) {}

  /** The guard's own issued kit, to pick from for a personal re-order. */
  @Get('kit')
  kit(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      return (
        await tx.query(
          `SELECT id, item, size, asset_number AS "assetNumber", issue_date AS "issueDate" FROM issued_items WHERE employee_id = $1 ORDER BY item`,
          [guard.employeeId],
        )
      ).rows;
    });
  }

  /** The guard's own re-orders, and open site re-orders at this site. */
  @Get('reorders')
  list(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      return (
        await tx.query(
          `SELECT ${COLUMNS}, (r.employee_id = $1) AS mine,
                  (r.stage IN ('ordered','assigned','delivered') AND (r.employee_id = $1 OR (r.kind = 'site' AND r.site_id = $2))) AS "canConfirm"
             FROM ${FROM}
            WHERE (r.employee_id = $1 AND (r.stage <> 'received' OR r.received_at > now() - interval '30 days'))
               OR (r.kind = 'site' AND r.site_id = $2 AND r.stage <> 'received')
            ORDER BY (r.stage = 'received'), r.number DESC`,
          [guard.employeeId, guard.siteId],
        )
      ).rows;
    });
  }

  /** Ask for a replacement. Personal: the size or asset number comes from the profile. Site: free text. Safe to retry. */
  @Post('reorders')
  @HttpCode(200)
  create(@CurrentGuard() guard: GuardPrincipal, @Body() body: unknown) {
    const b = parseBody(GuardReorderBody, body);
    const time = reconcileTime(b.trustedAt, b.deviceClock, new Date());
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    if (!guard.siteId) throw new BadRequestException('This device is not assigned to a site.');
    return this.db.withTenant(guard.companyId, async (tx) => {
      const seen = (await tx.query('SELECT id, number FROM reorders WHERE event_id = $1', [b.eventId])).rows[0];
      if (seen) return seen;
      let item: string;
      let size: string | null = null;
      let asset: string | null = null;
      let issuedItemId: string | null = null;
      if (b.kind === 'personal') {
        const it = (await tx.query('SELECT * FROM issued_items WHERE id = $1 AND employee_id = $2', [b.issuedItemId, guard.employeeId])).rows[0];
        if (!it) throw new BadRequestException({ message: 'Choose one of the items issued to you.', errors: { issuedItemId: 'Choose an item.' } });
        item = it.item;
        size = it.size;
        asset = it.asset_number;
        issuedItemId = it.id;
      } else {
        item = b.item;
      }
      const number = await nextNumber(tx);
      const { id } = (
        await tx.query(
          `INSERT INTO reorders (company_id, number, site_id, employee_id, device_id, kind, issued_item_id, item, size, asset_number, quantity,
                                 comment, requested_at, late_synced, event_id)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
          [number, guard.siteId, guard.employeeId, guard.deviceId, b.kind, issuedItemId, item, size, asset, b.kind === 'site' ? b.quantity || null : null, b.comment, time.officialAt, time.lateSynced, b.eventId],
        )
      ).rows[0];
      const name = (await tx.query('SELECT full_name FROM employees WHERE id = $1', [guard.employeeId])).rows[0].full_name;
      await history(tx, id, { type: 'employee', id: guard.employeeId, label: name, role: 'Security officer' }, { stage: 'requested', note: b.comment, at: time.officialAt, lateSynced: time.lateSynced });
      return { id, number, item, size, assetNumber: asset };
    });
  }

  /** The guard confirms the item arrived. A personal item's issue date updates to that day. */
  @Post('reorders/:id/received')
  @HttpCode(200)
  received(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(ReceivedBody, body);
    const time = reconcileTime(b.trustedAt, b.deviceClock, new Date());
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    return this.db.withTenant(guard.companyId, async (tx) => {
      const seen = (await tx.query('SELECT reorder_id FROM reorder_history WHERE event_id = $1', [b.eventId])).rows[0];
      if (seen) return { ok: true };
      const r = (await tx.query('SELECT * FROM reorders WHERE id = $1 FOR UPDATE', [id])).rows[0];
      const allowed = r && (r.employee_id === guard.employeeId || (r.kind === 'site' && r.site_id === guard.siteId));
      if (!allowed) throw new NotFoundException('Re-order not found.');
      if (!canConfirmReceipt(r.stage)) {
        throw new ConflictException(r.stage === 'received' ? 'Already received.' : 'This has not been ordered yet.');
      }
      await tx.query(`UPDATE reorders SET stage = 'received', received_at = $2 WHERE id = $1`, [id, time.officialAt]);
      if (r.kind === 'personal') {
        await tx.query('UPDATE issued_items SET issue_date = $2, updated_at = now() WHERE id = $1', [r.issued_item_id, sastDate(time.officialAt)]);
      }
      const name = (await tx.query('SELECT full_name FROM employees WHERE id = $1', [guard.employeeId])).rows[0].full_name;
      await history(tx, id, { type: 'employee', id: guard.employeeId, label: name, role: 'Security officer' }, { stage: 'received', note: b.note, at: time.officialAt, eventId: b.eventId, lateSynced: time.lateSynced });
      return { ok: true };
    });
  }
}
