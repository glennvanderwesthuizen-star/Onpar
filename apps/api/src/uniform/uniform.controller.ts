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
  addDays,
  guardPaysStatement,
  isDue,
  nextDueDate,
  orderTotals,
  reconcileTime,
  sastDate,
  LineDecision,
  ROLE_LABELS,
  UNIFORM_NEXT,
  UNIFORM_STATUS_LABELS,
  UniformStatus,
} from '@onpar/rules';
import { CurrentGuard, CurrentUser, GuardAuthGuard, GuardPrincipal, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { PinService } from '../device-api/pin.service';
import { RosterService } from '../roster/roster.service';

const isoTime = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the date.');

const ItemsBody = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        name: z.string().trim().min(2, 'Name the item.').max(60),
        variant: z.string().trim().max(60).default(''),
        sizes: z.array(z.string().trim().min(1).max(12)).max(30).default([]),
        priceCents: z.number().int().min(0).max(10_000_000),
        renewalMonths: z.number().int().min(1).max(60).default(12),
        active: z.boolean().default(true),
      }),
    )
    .max(200),
});
const SiteListBody = z.object({ lines: z.array(z.object({ itemId: z.string().uuid(), quantity: z.number().int().min(1).max(20) })).max(100) });
const DecideBody = z.object({
  lines: z
    .array(z.object({ lineId: z.string().uuid(), decision: z.enum(['company', 'guard', 'declined']), note: z.string().trim().max(500).default('') }))
    .min(1),
  note: z.string().trim().max(1000).default(''),
});
const NoteBody = z.object({ note: z.string().trim().max(1000).default('') });
const IssueBody = z.object({
  employeeId: z.string().uuid(),
  itemId: z.string().uuid({ message: 'Choose the item.' }),
  size: z.string().trim().max(12).default(''),
  quantity: z.number().int().min(1).max(20),
  issuedOn: date,
  account: z.enum(['company', 'guard']).default('company'),
  note: z.string().trim().max(500).default(''),
});
const OrderBody = z.object({
  eventId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        size: z.string().trim().max(12).default(''),
        quantity: z.number().int().min(1).max(20),
        reason: z.string().trim().max(500).default(''),
      }),
    )
    .min(1, 'Tick at least one item.')
    .max(50),
  trustedAt: isoTime,
  deviceClock: isoTime,
});
const ReceiveBody = z.object({
  pin: z.string().regex(/^\d{4,6}$/, 'Your PIN is 4 to 6 digits.'),
  agreeToPay: z.boolean().default(false),
  trustedAt: isoTime,
  deviceClock: isoTime,
});

const ITEM_COLUMNS = `i.id, i.name, i.variant, i.sizes, i.price_cents AS "priceCents", i.renewal_months AS "renewalMonths", i.active`;
const label = (name: string, variant: string) => (variant ? `${name} (${variant})` : name);

async function nextNumber(tx: Tx): Promise<number> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('uniform-number:' || app_company_id()::text))`);
  return (await tx.query('SELECT coalesce(max(number), 0) + 1 AS n FROM uniform_orders')).rows[0].n;
}

function history(tx: Tx, orderId: string, actor: { type: 'user' | 'employee'; id: string; label: string; role: string }, status: string, note = '', at?: Date) {
  return tx.query(
    `INSERT INTO uniform_order_history (company_id, order_id, at, actor_type, actor_id, actor_label, actor_role, status_after, note)
     VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
    [orderId, at ?? new Date(), actor.type, actor.id, actor.label, actor.role, status, note],
  );
}

const userActor = (u: UserPrincipal) => ({ type: 'user' as const, id: u.userId, label: u.name, role: ROLE_LABELS[u.role] });

/** The guard's uniform: what his site list entitles him to, what he last received, and when each is next due. */
async function guardKit(tx: Tx, employeeId: string, siteId: string | null, today: string) {
  if (!siteId) return [];
  const rows = (
    await tx.query(
      `SELECT ${ITEM_COLUMNS}, l.quantity AS entitled,
              last.issued_on AS "lastIssued", last.size AS "lastSize"
         FROM site_uniform_list l JOIN uniform_items i ON i.id = l.item_id
         LEFT JOIN LATERAL (SELECT to_char(issued_on, 'YYYY-MM-DD') AS issued_on, size FROM uniform_issues
                             WHERE employee_id = $1 AND item_id = i.id ORDER BY issued_on DESC, created_at DESC LIMIT 1) last ON true
        WHERE l.site_id = $2 AND i.active
        ORDER BY i.sort_order, i.name, i.variant`,
      [employeeId, siteId],
    )
  ).rows;
  return rows.map((r) => ({
    itemId: r.id,
    name: r.name,
    variant: r.variant,
    label: label(r.name, r.variant),
    sizes: r.sizes,
    entitled: r.entitled,
    lastIssued: r.lastIssued,
    lastSize: r.lastSize,
    nextDue: nextDueDate(r.lastIssued, r.renewalMonths),
    due: isDue(r.lastIssued, today, r.renewalMonths),
  }));
}

/** An order with its lines, totals and history. */
async function orderDetail(tx: Tx, id: string) {
  const o = (
    await tx.query(
      `SELECT o.id, o.number, o.status, o.requested_at AS "requestedAt", o.late_synced AS "lateSynced", o.received_at AS "receivedAt",
              o.handed_over_at AS "handedOverAt", hu.full_name AS "handedOverBy", o.guard_agreed_cents AS "guardAgreedCents",
              o.guard_agreed_statement AS "guardAgreedStatement",
              o.site_id AS "siteId", s.name AS "siteName", o.employee_id AS "employeeId", e.full_name AS "employeeName",
              e.employee_number AS "employeeNumber"
         FROM uniform_orders o JOIN sites s ON s.id = o.site_id JOIN employees e ON e.id = o.employee_id
         LEFT JOIN users hu ON hu.id = o.handed_over_by
        WHERE o.id = $1`,
      [id],
    )
  ).rows[0];
  if (!o) return null;
  const lines = (
    await tx.query(
      `SELECT l.id, l.item_id AS "itemId", i.name, i.variant, l.size, l.quantity, l.was_due AS "wasDue", l.reason, l.decision,
              l.decision_note AS "decisionNote", CASE WHEN l.decision IS NULL THEN i.price_cents ELSE l.unit_price_cents END AS "unitPriceCents"
         FROM uniform_order_lines l JOIN uniform_items i ON i.id = l.item_id WHERE l.order_id = $1 ORDER BY i.sort_order, i.name, i.variant`,
      [id],
    )
  ).rows.map((l) => ({ ...l, label: label(l.name, l.variant) }));
  const historyRows = (
    await tx.query(
      `SELECT at, actor_label AS "actorLabel", actor_role AS "actorRole", status_after AS "statusAfter", note
         FROM uniform_order_history WHERE order_id = $1 ORDER BY at, id`,
      [id],
    )
  ).rows;
  return {
    ...o,
    statusLabel: UNIFORM_STATUS_LABELS[o.status as UniformStatus],
    lines,
    totals: orderTotals(lines.map((l) => ({ quantity: l.quantity, decision: l.decision, unitPriceCents: l.unitPriceCents }))),
    history: historyRows,
  };
}

/** Uniform on the website: catalogue, site lists, orders, stores and deliveries (D-33). */
@Controller('uniform')
@UseGuards(UserAuthGuard)
export class UniformController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly roster: RosterService,
  ) {}

  @Get('items')
  @RequirePermission('uniform.view')
  items(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) =>
      (await tx.query(`SELECT ${ITEM_COLUMNS} FROM uniform_items i ORDER BY i.sort_order, i.name, i.variant`)).rows,
    );
  }

  /** Adds and changes catalogue items. Items are never deleted (orders refer to them); retire them instead. */
  @Put('items')
  @RequirePermission('uniform.catalogue')
  saveItems(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const b = parseBody(ItemsBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      for (const [i, it] of b.items.entries()) {
        const sizes = [...new Set(it.sizes)];
        if (it.id) {
          const r = await tx.query(
            `UPDATE uniform_items SET name = $2, variant = $3, sizes = $4, price_cents = $5, renewal_months = $6, active = $7, sort_order = $8 WHERE id = $1`,
            [it.id, it.name, it.variant, sizes, it.priceCents, it.renewalMonths, it.active, i],
          );
          if (!r.rowCount) throw new NotFoundException('Item not found.');
        } else {
          await tx.query(
            `INSERT INTO uniform_items (company_id, name, variant, sizes, price_cents, renewal_months, active, sort_order)
             VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7)`,
            [it.name, it.variant, sizes, it.priceCents, it.renewalMonths, it.active, i],
          );
        }
      }
      await this.audit.byUser(tx, user, { action: 'uniform.catalogue_save', entityType: 'uniform_items', entityId: null, after: { items: b.items.length } });
      return (await tx.query(`SELECT ${ITEM_COLUMNS} FROM uniform_items i ORDER BY i.sort_order, i.name, i.variant`)).rows;
    }).catch((e) => {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('Two items have the same name and type.');
      throw e;
    });
  }

  @Get('sites/:siteId/list')
  @RequirePermission('uniform.view')
  siteList(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string) {
    if (user.siteIds && !user.siteIds.includes(siteId)) throw new NotFoundException('Site not found.');
    return this.db.withTenant(user.companyId, async (tx) =>
      (
        await tx.query(
          `SELECT l.item_id AS "itemId", l.quantity, i.name, i.variant FROM site_uniform_list l JOIN uniform_items i ON i.id = l.item_id
            WHERE l.site_id = $1 ORDER BY i.sort_order, i.name, i.variant`,
          [siteId],
        )
      ).rows,
    );
  }

  @Put('sites/:siteId/list')
  @RequirePermission('uniform.catalogue')
  saveSiteList(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Body() body: unknown) {
    const b = parseBody(SiteListBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      if (!(await tx.query('SELECT 1 FROM sites WHERE id = $1', [siteId])).rowCount) throw new NotFoundException('Site not found.');
      await tx.query('DELETE FROM site_uniform_list WHERE site_id = $1', [siteId]);
      for (const l of b.lines) {
        await tx.query('INSERT INTO site_uniform_list (company_id, site_id, item_id, quantity) VALUES (app_company_id(), $1, $2, $3)', [siteId, l.itemId, l.quantity]);
      }
      await this.audit.byUser(tx, user, { action: 'uniform.site_list_save', entityType: 'site', entityId: siteId, after: { lines: b.lines } });
      return { ok: true };
    });
  }

  /** Orders, newest first. Site managers and supervisors see their own sites; stores and managers see all. */
  @Get('orders')
  @RequirePermission('uniform.view')
  orders(@CurrentUser() user: UserPrincipal, @Query('status') status?: string) {
    const statuses = status === 'open' ? ['requested', 'approved', 'ready', 'with_supervisor'] : status ? status.split(',') : null;
    return this.db.withTenant(user.companyId, async (tx) => {
      const rows = (
        await tx.query(
          `SELECT o.id, o.number, o.status, o.requested_at AS "requestedAt", o.handed_over_at AS "handedOverAt",
                  s.name AS "siteName", e.full_name AS "employeeName", e.employee_number AS "employeeNumber",
                  (SELECT count(*)::int FROM uniform_order_lines l WHERE l.order_id = o.id) AS lines,
                  (SELECT count(*)::int FROM uniform_order_lines l WHERE l.order_id = o.id AND NOT l.was_due) AS "notDue"
             FROM uniform_orders o JOIN sites s ON s.id = o.site_id JOIN employees e ON e.id = o.employee_id
            WHERE ($1::uuid[] IS NULL OR o.site_id = ANY($1::uuid[])) AND ($2::text[] IS NULL OR o.status = ANY($2::text[]))
            ORDER BY o.requested_at DESC LIMIT 300`,
          [user.siteIds, statuses],
        )
      ).rows;
      return rows.map((r) => ({ ...r, statusLabel: UNIFORM_STATUS_LABELS[r.status as UniformStatus] }));
    });
  }

  @Get('orders/:id')
  @RequirePermission('uniform.view')
  order(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const o = await orderDetail(tx, id);
      if (!o || (user.siteIds && !user.siteIds.includes(o.siteId))) throw new NotFoundException('Order not found.');
      // When the guard is next on duty, so the supervisor delivers it then.
      const today = sastDate(new Date());
      const days = (await this.roster.days(tx, [o.employeeId], today, addDays(today, 14))).get(o.employeeId)!;
      const next = days.find((d) => d.status === 'working');
      return { ...o, nextOnDuty: next && next.status === 'working' ? { date: next.date, shiftName: next.shiftName, startTime: next.startTime } : null };
    });
  }

  /** A manager or administrator decides every line: company account, guard's account, or not issued. */
  @Post('orders/:id/decide')
  @HttpCode(200)
  @RequirePermission('uniform.review')
  decide(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(DecideBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const o = (await tx.query('SELECT id, site_id, status FROM uniform_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!o || (user.siteIds && !user.siteIds.includes(o.site_id))) throw new NotFoundException('Order not found.');
      if (o.status !== 'requested') throw new ConflictException('This order has already been decided.');
      const lines = (await tx.query('SELECT l.id, i.price_cents FROM uniform_order_lines l JOIN uniform_items i ON i.id = l.item_id WHERE l.order_id = $1', [id])).rows;
      const byId = new Map(b.lines.map((l) => [l.lineId, l]));
      const errors: Record<string, string> = {};
      for (const l of lines) {
        const d = byId.get(l.id);
        if (!d) errors[l.id] = 'Choose what to do with this item.';
        else if (d.decision === 'declined' && d.note.length < 3) errors[l.id] = 'Say why it is not issued.';
      }
      if (Object.keys(errors).length) throw new BadRequestException({ message: 'Decide every item; say why for any not issued.', errors });
      for (const l of lines) {
        const d = byId.get(l.id)!;
        await tx.query('UPDATE uniform_order_lines SET decision = $2, decision_note = $3, unit_price_cents = $4 WHERE id = $1', [l.id, d.decision, d.note, l.price_cents]);
      }
      const allDeclined = b.lines.every((l) => l.decision === 'declined');
      const status: UniformStatus = allDeclined ? 'declined' : 'approved';
      await tx.query('UPDATE uniform_orders SET status = $2 WHERE id = $1', [id, status]);
      const count = (k: LineDecision) => b.lines.filter((l) => l.decision === k).length;
      const summary = `${count('company')} company account, ${count('guard')} guard's account, ${count('declined')} not issued.`;
      await history(tx, id, userActor(user), status, [summary, b.note].filter(Boolean).join(' '));
      await this.audit.byUser(tx, user, { action: 'uniform.decide', entityType: 'uniform_order', entityId: id, after: { lines: b.lines } });
      return orderDetail(tx, id);
    });
  }

  /** Stores: the items are packed and ready for the supervisor to collect. */
  @Post('orders/:id/ready')
  @HttpCode(200)
  @RequirePermission('uniform.stores')
  ready(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.step(user, id, 'ready', parseBody(NoteBody, body).note || 'Items packed and ready for collection.');
  }

  /** The supervisor collected the items from stores, to deliver to the guard. */
  @Post('orders/:id/collected')
  @HttpCode(200)
  @RequirePermission('uniform.deliver')
  collected(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.step(user, id, 'collected', parseBody(NoteBody, body).note || `Collected from stores by ${user.name}.`);
  }

  /** Stores confirms it handed the items to the supervisor (the second side of the collection). */
  @Post('orders/:id/handed-over')
  @HttpCode(200)
  @RequirePermission('uniform.stores')
  handedOver(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const note = parseBody(NoteBody, body).note;
    return this.db.withTenant(user.companyId, async (tx) => {
      const o = (await tx.query('SELECT id, status, handed_over_at FROM uniform_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!o) throw new NotFoundException('Order not found.');
      if (o.handed_over_at) return orderDetail(tx, id);
      if (!['ready', 'with_supervisor'].includes(o.status)) throw new ConflictException('The items are not ready for collection yet.');
      await tx.query('UPDATE uniform_orders SET handed_over_at = now(), handed_over_by = $2 WHERE id = $1', [id, user.userId]);
      await history(tx, id, userActor(user), o.status, note || 'Stores confirms the items were handed to the supervisor.');
      return orderDetail(tx, id);
    });
  }

  private step(user: UserPrincipal, id: string, step: 'ready' | 'collected', note: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const o = (await tx.query('SELECT id, site_id, status FROM uniform_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!o || (user.siteIds && !user.siteIds.includes(o.site_id))) throw new NotFoundException('Order not found.');
      const rule = UNIFORM_NEXT[step];
      if (!rule.from.includes(o.status)) {
        throw new ConflictException(step === 'ready' ? 'Only an approved order can be marked ready.' : 'The items are not ready for collection yet.');
      }
      await tx.query('UPDATE uniform_orders SET status = $2 WHERE id = $1', [id, rule.to]);
      await history(tx, id, userActor(user), rule.to, note);
      await this.audit.byUser(tx, user, { action: `uniform.${step}`, entityType: 'uniform_order', entityId: id });
      return orderDetail(tx, id);
    });
  }

  /**
   * The supervisor's uniform tasks: orders ready to collect at stores, and orders he holds,
   * to give each guard when he is next on duty (from the roster).
   */
  @Get('deliveries')
  @RequirePermission('uniform.deliver')
  deliveries(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const rows = (
        await tx.query(
          `SELECT o.id, o.number, o.status, o.employee_id AS "employeeId", e.full_name AS "employeeName", e.employee_number AS "employeeNumber",
                  s.name AS "siteName", o.handed_over_at AS "handedOverAt",
                  (SELECT string_agg(l.quantity || ' × ' || i.name || CASE WHEN i.variant <> '' THEN ' (' || i.variant || ')' ELSE '' END
                                     || CASE WHEN l.size <> '' THEN ' ' || l.size ELSE '' END, ', ' ORDER BY i.sort_order)
                     FROM uniform_order_lines l JOIN uniform_items i ON i.id = l.item_id
                    WHERE l.order_id = o.id AND l.decision IN ('company','guard')) AS items
             FROM uniform_orders o JOIN sites s ON s.id = o.site_id JOIN employees e ON e.id = o.employee_id
            WHERE o.status IN ('ready','with_supervisor') AND ($1::uuid[] IS NULL OR o.site_id = ANY($1::uuid[]))
            ORDER BY o.status, s.name, e.full_name`,
          [user.siteIds],
        )
      ).rows;
      const today = sastDate(new Date());
      const ids = [...new Set(rows.map((r) => r.employeeId))];
      const days = ids.length ? await this.roster.days(tx, ids, today, addDays(today, 14)) : new Map();
      return rows.map((r) => {
        const next = (days.get(r.employeeId) ?? []).find((d: { status: string }) => d.status === 'working');
        return {
          ...r,
          statusLabel: UNIFORM_STATUS_LABELS[r.status as UniformStatus],
          nextOnDuty: next ? { date: next.date, shiftName: next.shiftName, startTime: next.startTime, today: next.date === today } : null,
        };
      });
    });
  }

  /** A guard's uniform table (as on his phone), for managers. */
  @Get('officers/:id')
  @RequirePermission('uniform.view')
  officer(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const e = (await tx.query('SELECT id, full_name, home_site_id FROM employees WHERE id = $1', [id])).rows[0];
      if (!e || (user.siteIds && !user.siteIds.includes(e.home_site_id))) throw new NotFoundException('Officer not found.');
      const issues = (
        await tx.query(
          `SELECT u.id, to_char(u.issued_on, 'YYYY-MM-DD') AS "issuedOn", u.size, u.quantity, u.account, u.note, i.name, i.variant
             FROM uniform_issues u JOIN uniform_items i ON i.id = u.item_id WHERE u.employee_id = $1 ORDER BY u.issued_on DESC, u.created_at DESC`,
          [id],
        )
      ).rows.map((r) => ({ ...r, label: label(r.name, r.variant) }));
      return { kit: await guardKit(tx, id, e.home_site_id, sastDate(new Date())), issues };
    });
  }

  /** Records uniform issued outside an order, for example a new guard's starter kit. Starts the 12 months. */
  @Post('issues')
  @RequirePermission('uniform.issue')
  issue(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const b = parseBody(IssueBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const e = (await tx.query('SELECT id, home_site_id FROM employees WHERE id = $1', [b.employeeId])).rows[0];
      if (!e || (user.siteIds && !user.siteIds.includes(e.home_site_id))) throw new NotFoundException('Officer not found.');
      const item = (await tx.query('SELECT id, sizes FROM uniform_items WHERE id = $1', [b.itemId])).rows[0];
      if (!item) throw new BadRequestException({ message: 'Choose the item.', errors: { itemId: 'Choose the item.' } });
      if (item.sizes.length && !item.sizes.includes(b.size)) throw new BadRequestException({ message: 'Choose one of the sizes.', errors: { size: 'Choose a size.' } });
      const { id } = (
        await tx.query(
          `INSERT INTO uniform_issues (company_id, employee_id, item_id, size, quantity, issued_on, account, note, recorded_by)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [b.employeeId, b.itemId, b.size, b.quantity, b.issuedOn, b.account, b.note, user.userId],
        )
      ).rows[0];
      await this.audit.byUser(tx, user, { action: 'uniform.issue', entityType: 'employee', entityId: b.employeeId, after: b });
      return { id };
    });
  }
}

/** Uniform on the post phone (D-33): the guard's kit table, ordering, and signing for a delivery. */
@Controller('device/uniform')
@UseGuards(GuardAuthGuard)
export class GuardUniformController {
  constructor(
    private readonly db: DbService,
    private readonly pins: PinService,
  ) {}

  @Get()
  mine(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      const kit = await guardKit(tx, guard.employeeId, guard.siteId, sastDate(new Date()));
      const ids = (
        await tx.query(
          `SELECT id FROM uniform_orders WHERE employee_id = $1 AND (status NOT IN ('received','declined') OR requested_at > now() - interval '60 days')
            ORDER BY requested_at DESC LIMIT 20`,
          [guard.employeeId],
        )
      ).rows.map((r) => r.id);
      const orders = [];
      for (const id of ids) {
        const o = (await orderDetail(tx, id))!;
        orders.push({
          id: o.id,
          number: o.number,
          status: o.status,
          statusLabel: o.statusLabel,
          requestedAt: o.requestedAt,
          lines: o.lines.map((l: { label: string; size: string; quantity: number; decision: string | null; decisionNote: string; unitPriceCents: number }) => ({ label: l.label, size: l.size, quantity: l.quantity, decision: l.decision, decisionNote: l.decisionNote, unitPriceCents: l.unitPriceCents })),
          guardCents: o.totals.guardCents,
          canReceive: o.status === 'with_supervisor',
          agreeStatement: o.totals.guardCents > 0 ? guardPaysStatement(o.totals.guardCents) : null,
        });
      }
      return { kit, orders };
    });
  }

  /** One order for several items. Items not yet due need a reason. Safe to retry. */
  @Post('orders')
  @HttpCode(200)
  order(@CurrentGuard() guard: GuardPrincipal, @Body() body: unknown) {
    const b = parseBody(OrderBody, body);
    const time = reconcileTime(b.trustedAt, b.deviceClock, new Date());
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    if (!guard.siteId) throw new BadRequestException('This phone is not assigned to a site.');
    return this.db.withTenant(guard.companyId, async (tx) => {
      const seen = (await tx.query('SELECT id, number FROM uniform_orders WHERE event_id = $1', [b.eventId])).rows[0];
      if (seen) return seen;
      const kit = new Map((await guardKit(tx, guard.employeeId, guard.siteId, sastDate(time.officialAt))).map((k) => [k.itemId, k]));
      const errors: Record<string, string> = {};
      const seenItems = new Set<string>();
      for (const l of b.lines) {
        const k = kit.get(l.itemId);
        if (!k) errors[l.itemId] = 'This item is not on your site uniform list.';
        else if (seenItems.has(l.itemId)) errors[l.itemId] = 'Each item once per order.';
        else if (l.quantity > k.entitled) errors[l.itemId] = `You may order up to ${k.entitled}.`;
        else if (k.sizes.length && !k.sizes.includes(l.size)) errors[l.itemId] = 'Choose your size.';
        else if (!k.due && l.reason.length < 3) errors[l.itemId] = `Not due until ${k.nextDue}: say why you need it now.`;
        seenItems.add(l.itemId);
      }
      if (Object.keys(errors).length) throw new BadRequestException({ message: Object.values(errors)[0], errors });
      const open = (await tx.query(`SELECT number FROM uniform_orders WHERE employee_id = $1 AND status = 'requested'`, [guard.employeeId])).rows[0];
      if (open) throw new ConflictException(`You already have uniform order #${open.number} waiting for approval.`);
      const number = await nextNumber(tx);
      const { id } = (
        await tx.query(
          `INSERT INTO uniform_orders (company_id, number, employee_id, site_id, device_id, requested_at, late_synced, event_id)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [number, guard.employeeId, guard.siteId, guard.deviceId, time.officialAt, time.lateSynced, b.eventId],
        )
      ).rows[0];
      for (const l of b.lines) {
        await tx.query(
          `INSERT INTO uniform_order_lines (company_id, order_id, item_id, size, quantity, was_due, reason) VALUES (app_company_id(), $1, $2, $3, $4, $5, $6)`,
          [id, l.itemId, l.size, l.quantity, kit.get(l.itemId)!.due, l.reason],
        );
      }
      const name = (await tx.query('SELECT full_name FROM employees WHERE id = $1', [guard.employeeId])).rows[0].full_name;
      await history(tx, id, { type: 'employee', id: guard.employeeId, label: name, role: 'Security officer' }, 'requested', `${b.lines.length} item(s) ordered.`, time.officialAt);
      return { id, number };
    });
  }

  /**
   * The guard signs for his uniform with his PIN. For guard's-account items he must also
   * agree to pay the amount shown; that signed statement is recorded for payroll (L-08:
   * the app never deducts anything). The issue starts each item's next 12 months.
   */
  @Post('orders/:id/receive')
  @HttpCode(200)
  receive(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(ReceiveBody, body);
    const time = reconcileTime(b.trustedAt, b.deviceClock, new Date());
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    return this.db.withTenant(guard.companyId, async (tx) => {
      const o = (await tx.query('SELECT id, employee_id, status FROM uniform_orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!o || o.employee_id !== guard.employeeId) throw new NotFoundException('Order not found.');
      if (o.status === 'received') return { ok: true };
      if (o.status !== 'with_supervisor') throw new ConflictException('Your supervisor does not have this order yet.');
      await this.pins.check(guard.companyId, { employeeId: guard.employeeId }, b.pin, guard.deviceId, null);
      const lines = (
        await tx.query(`SELECT id, item_id, size, quantity, decision, unit_price_cents FROM uniform_order_lines WHERE order_id = $1 AND decision IN ('company','guard')`, [id])
      ).rows;
      const { guardCents } = orderTotals(lines.map((l) => ({ quantity: l.quantity, decision: l.decision, unitPriceCents: l.unit_price_cents })));
      if (guardCents > 0 && !b.agreeToPay) {
        throw new BadRequestException({ message: 'Some items are on your account. Read the amount and agree to it to sign.', errors: { agreeToPay: 'Agree to sign.' } });
      }
      const on = sastDate(time.officialAt);
      for (const l of lines) {
        await tx.query(
          `INSERT INTO uniform_issues (company_id, employee_id, item_id, size, quantity, issued_on, account, order_line_id)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7)`,
          [guard.employeeId, l.item_id, l.size, l.quantity, on, l.decision, l.id],
        );
      }
      const statement = guardCents > 0 ? guardPaysStatement(guardCents) : null;
      await tx.query(
        `UPDATE uniform_orders SET status = 'received', received_at = $2, guard_agreed_cents = $3, guard_agreed_statement = $4 WHERE id = $1`,
        [id, time.officialAt, guardCents > 0 ? guardCents : null, statement],
      );
      const name = (await tx.query('SELECT full_name FROM employees WHERE id = $1', [guard.employeeId])).rows[0].full_name;
      await history(
        tx,
        id,
        { type: 'employee', id: guard.employeeId, label: name, role: 'Security officer' },
        'received',
        statement ? `Signed for the items with his PIN. ${statement}` : 'Signed for the items with his PIN.',
        time.officialAt,
      );
      return { ok: true };
    });
  }
}
