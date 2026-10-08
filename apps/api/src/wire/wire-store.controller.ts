import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { DEFAULT_WIRE_ITEMS, goalProgress, GoalGuard, sastDate, WIRE_ITEM_CATEGORIES, WIRE_ITEM_CATEGORY_LABELS, WireItem, wireItemErrors, WireSettings } from '@onpar/rules';
import { z } from 'zod';
import { CurrentGuard, CurrentUser, GuardOrSelfAuthGuard, GuardPrincipal, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody, throwIfErrors } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { WireService } from './wire.service';

const ItemBody = z.object({
  name: z.string().trim().max(120),
  category: z.enum(WIRE_ITEM_CATEGORIES),
  barbs: z.number().int(),
  costRand: z.number().min(0).max(1_000_000).nullable().default(null),
  monthsService: z.number().int().default(0),
  wireAtLeast: z.number().int().default(0),
  needsGrade: z.enum(['A', 'B', 'C', 'D', 'E']).nullable().default(null),
  monthsAtStandard: z.number().int().default(0),
  inStore: z.boolean().default(true),
  active: z.boolean().default(true),
});
const GoalBody = z.union([z.object({ itemId: z.string().uuid() }), z.object({ ownWords: z.string().trim().min(3, 'Say what your goal is.').max(200) }), z.object({ clear: z.literal(true) })]);
const HandInBody = z.object({ eventId: z.string().uuid(), itemId: z.string().uuid() });
const CancelBody = z.object({ reason: z.string().trim().min(5, 'Give the reason. The guard reads it.').max(500) });

const ITEM_COLUMNS = `id, name, category, barbs, cost_rand::float AS "costRand", months_service AS "monthsService", wire_at_least AS "wireAtLeast",
  needs_grade AS "needsGrade", months_at_standard AS "monthsAtStandard", in_store AS "inStore", active`;

type Item = WireItem & { costRand: number | null };

/** The goals and store table, and where a guard stands against it. */
@Injectable()
export class WireStoreService {
  constructor(private readonly wire: WireService) {}

  /** The owner's table. A company that has none yet is given the rule book's list the first time. */
  async items(tx: Tx): Promise<Item[]> {
    const read = async () => (await tx.query(`SELECT ${ITEM_COLUMNS} FROM wire_items ORDER BY active DESC, sort, lower(name)`)).rows as Item[];
    const rows = await read();
    if (rows.length) return rows;
    for (const [i, x] of DEFAULT_WIRE_ITEMS.entries()) {
      await tx.query(
        `INSERT INTO wire_items (company_id, name, category, barbs, cost_rand, months_service, wire_at_least, needs_grade, months_at_standard, in_store, sort)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
        [x.name, x.category, x.barbs, x.costRand, x.monthsService, x.wireAtLeast, x.needsGrade, x.monthsAtStandard, x.inStore, i],
      );
    }
    return read();
  }

  /** Where a guard stands: grade, service, barbs, run, pace and courses this year. */
  async standing(tx: Tx, employeeId: string): Promise<(GoalGuard & { name: string; site: string | null }) | null> {
    const g = await this.wire.guard(tx, employeeId);
    if (!g) return null;
    const e = (await tx.query(`SELECT e.psira_grade, s.name AS site FROM employees e LEFT JOIN sites s ON s.id = e.home_site_id WHERE e.id = $1`, [employeeId])).rows[0];
    const today = sastDate(new Date());
    const [jy, jm, jd] = g.joinedOn.split('-').map(Number);
    const [y, m, d] = today.split('-').map(Number);
    const monthsService = Math.max(0, (y - jy) * 12 + (m - jm) - (d < jd ? 1 : 0));
    const courses = (
      await tx.query(`SELECT count(*)::int AS n FROM wire_handins WHERE employee_id = $1 AND category = 'training' AND status <> 'cancelled' AND requested_at > now() - interval '12 months'`, [employeeId])
    ).rows[0].n as number;
    return { name: g.name, site: e?.site ?? null, grade: e?.psira_grade ?? null, monthsService, wireTotal: g.wireTotal, available: g.available, streak: g.streak, pace: g.pace, coursesThisYear: courses };
  }

  /** His goal with its steps; marks it reached the first time it is. */
  async goal(tx: Tx, employeeId: string, standing: GoalGuard, settings: WireSettings, items: Item[]) {
    const row = (await tx.query(`SELECT id, item_id, own_words, set_at, reached_at FROM wire_goals WHERE employee_id = $1 AND ended_at IS NULL`, [employeeId])).rows[0];
    if (!row) return null;
    if (!row.item_id) return { id: row.id as string, itemId: null, name: row.own_words as string, ownWords: true, steps: [], ready: false, monthsToGo: null, setAt: row.set_at };
    const item = items.find((i) => i.id === row.item_id);
    if (!item) return null;
    const p = goalProgress(item, standing, settings);
    if (p.ready && !row.reached_at) await tx.query('UPDATE wire_goals SET reached_at = now() WHERE id = $1', [row.id]);
    return { id: row.id as string, itemId: item.id, name: item.name, ownWords: false, ...p, setAt: row.set_at };
  }
}

/** The owner's goals and store table, the planning view and the fulfilment queue. */
@Controller('wire')
@UseGuards(UserAuthGuard)
export class WireStoreController {
  constructor(
    private readonly db: DbService,
    private readonly wire: WireService,
    private readonly store: WireStoreService,
    private readonly audit: AuditService,
  ) {}

  @Get('store')
  @RequirePermission('wire.view')
  overview(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const { settings } = await this.wire.settings(tx);
      const items = await this.store.items(tx);
      // Who is aiming at what, and when they will be ready.
      const goals = (
        await tx.query(
          `SELECT g.employee_id FROM wire_goals g JOIN employees e ON e.id = g.employee_id
            WHERE g.ended_at IS NULL AND e.status = 'active' AND ($1::uuid[] IS NULL OR e.home_site_id = ANY($1::uuid[]))`,
          [user.siteIds],
        )
      ).rows.map((r) => r.employee_id as string);
      const aiming: { employeeId: string; name: string; site: string | null; goal: string; itemId: string | null; ready: boolean; monthsToGo: number | null; nextStep: string | null }[] = [];
      for (const id of goals) {
        const st = (await this.store.standing(tx, id))!;
        const g = await this.store.goal(tx, id, st, settings, items);
        if (!g) continue;
        aiming.push({ employeeId: id, name: st.name, site: st.site, goal: g.name, itemId: g.itemId, ready: g.ready, monthsToGo: g.monthsToGo, nextStep: g.steps.find((x) => !x.done)?.toGo ?? null });
      }
      aiming.sort((a, b) => a.goal.localeCompare(b.goal) || (a.monthsToGo ?? 999) - (b.monthsToGo ?? 999));
      const plan = items
        .filter((i) => aiming.some((a) => a.itemId === i.id))
        .map((i) => {
          const mine = aiming.filter((a) => a.itemId === i.id);
          const soon = mine.filter((a) => a.monthsToGo !== null && a.monthsToGo <= 3);
          return { itemId: i.id, name: i.name, aiming: mine.length, readyNow: mine.filter((a) => a.ready).length, withinThreeMonths: soon.length, costWithinThreeMonths: i.costRand === null ? null : soon.length * i.costRand };
        });
      const handins = (
        await tx.query(
          `SELECT h.id, h.item_name AS "itemName", h.barbs, h.cost_rand::float AS "costRand", h.status, h.requested_at AS "requestedAt", h.done_at AS "doneAt", h.cancel_reason AS "cancelReason",
                  e.full_name AS guard, s.name AS site, u.full_name AS "doneBy"
             FROM wire_handins h JOIN employees e ON e.id = h.employee_id LEFT JOIN sites s ON s.id = h.site_id LEFT JOIN users u ON u.id = h.done_by
            WHERE ($1::uuid[] IS NULL OR h.site_id = ANY($1::uuid[])) AND (h.status = 'requested' OR h.done_at > now() - interval '60 days')
            ORDER BY (h.status = 'requested') DESC, h.requested_at`,
          [user.siteIds],
        )
      ).rows;
      return { storeOpen: settings.storeOpen, coursesPerYear: settings.coursesPerYear, categories: WIRE_ITEM_CATEGORY_LABELS, items, aiming, plan, handins };
    });
  }

  @Post('items')
  @RequirePermission('wire.manage')
  addItem(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const b = parseBody(ItemBody, body);
    throwIfErrors(wireItemErrors(b));
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.store.items(tx);
      if ((await tx.query('SELECT 1 FROM wire_items WHERE lower(name) = lower($1)', [b.name])).rowCount) throw new ConflictException({ message: 'There is already a row with that name.', errors: { name: 'Already in the table.' } });
      const id = (
        await tx.query(
          `INSERT INTO wire_items (company_id, name, category, barbs, cost_rand, months_service, wire_at_least, needs_grade, months_at_standard, in_store, active, sort)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, (SELECT coalesce(max(sort), 0) + 1 FROM wire_items)) RETURNING id`,
          [b.name, b.category, b.barbs, b.costRand, b.monthsService, b.wireAtLeast, b.needsGrade, b.monthsAtStandard, b.inStore, b.active],
        )
      ).rows[0].id;
      await this.audit.byUser(tx, user, { action: 'wire.item_create', entityType: 'wire_item', entityId: id, after: b });
      return { id };
    });
  }

  /** Changes a row. A hand-in already made keeps the price it was made at. */
  @Put('items/:id')
  @RequirePermission('wire.manage')
  updateItem(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(ItemBody, body);
    throwIfErrors(wireItemErrors(b));
    return this.db.withTenant(user.companyId, async (tx) => {
      const before = (await tx.query(`SELECT ${ITEM_COLUMNS} FROM wire_items WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!before) throw new NotFoundException('Row not found.');
      if ((await tx.query('SELECT 1 FROM wire_items WHERE lower(name) = lower($1) AND id <> $2', [b.name, id])).rowCount) throw new ConflictException({ message: 'There is already a row with that name.', errors: { name: 'Already in the table.' } });
      await tx.query(
        `UPDATE wire_items SET name = $2, category = $3, barbs = $4, cost_rand = $5, months_service = $6, wire_at_least = $7, needs_grade = $8, months_at_standard = $9,
                in_store = $10, active = $11, updated_at = now() WHERE id = $1`,
        [id, b.name, b.category, b.barbs, b.costRand, b.monthsService, b.wireAtLeast, b.needsGrade, b.monthsAtStandard, b.inStore, b.active],
      );
      await this.audit.byUser(tx, user, { action: 'wire.item_update', entityType: 'wire_item', entityId: id, before, after: b });
      return { ok: true };
    });
  }

  /** The hand-in has been supplied: the course booked, the airtime sent, the kit issued. */
  @Post('handins/:id/supply')
  @RequirePermission('wire.manage')
  @HttpCode(200)
  supply(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const r = await tx.query(`UPDATE wire_handins SET status = 'supplied', done_by = $2, done_at = now() WHERE id = $1 AND status = 'requested' RETURNING id`, [id, user.userId]);
      if (!r.rowCount) throw new ConflictException('This hand-in is not waiting to be supplied.');
      await this.audit.byUser(tx, user, { action: 'wire.handin_supply', entityType: 'wire_handin', entityId: id });
      return { ok: true };
    });
  }

  /** Cancels a hand-in not yet supplied. The barbs go back to available; the Wire total never changed. */
  @Post('handins/:id/cancel')
  @RequirePermission('wire.manage')
  @HttpCode(200)
  cancel(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parseBody(CancelBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const h = (await tx.query(`SELECT employee_id, site_id, barbs, item_name FROM wire_handins WHERE id = $1 AND status = 'requested' FOR UPDATE`, [id])).rows[0];
      if (!h) throw new ConflictException('This hand-in is not waiting to be supplied.');
      await tx.query(`UPDATE wire_handins SET status = 'cancelled', done_by = $2, done_at = now(), cancel_reason = $3 WHERE id = $1`, [id, user.userId, reason]);
      await tx.query(
        `INSERT INTO wire_entries (company_id, employee_id, site_id, entry_date, kind, rule, barbs, source_key, note, created_by)
         VALUES (app_company_id(), $1, $2, $3, 'returned', 'hand_in', $4, $5, $6, $7)`,
        [h.employee_id, h.site_id, sastDate(new Date()), h.barbs, `returned:${id}`, `${h.item_name}: ${reason}`, user.userId],
      );
      await this.audit.byUser(tx, user, { action: 'wire.handin_cancel', entityType: 'wire_handin', entityId: id, reason });
      return { ok: true };
    });
  }
}

/** Goals and the store on the guard's phone. Barbs only: no rand amount ever reaches the phone. */
@Controller('device/wire')
@UseGuards(GuardOrSelfAuthGuard)
export class GuardWireStoreController {
  constructor(
    private readonly db: DbService,
    private readonly wire: WireService,
    private readonly store: WireStoreService,
  ) {}

  @Get('store')
  mine(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, (tx) => this.view(tx, guard.employeeId));
  }

  private async view(tx: Tx, employeeId: string) {
    const { settings } = await this.wire.settings(tx);
    const items = (await this.store.items(tx)).filter((i) => i.active);
    const st = (await this.store.standing(tx, employeeId))!;
    const goal = await this.store.goal(tx, employeeId, st, settings, items);
    const handins = (
      await tx.query(
        `SELECT h.id, h.item_name AS "itemName", h.barbs, h.status, to_char(h.requested_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS date, h.cancel_reason AS "cancelReason"
           FROM wire_handins h WHERE h.employee_id = $1 ORDER BY h.requested_at DESC LIMIT 20`,
        [employeeId],
      )
    ).rows;
    return {
      storeOpen: settings.storeOpen,
      available: st.available,
      wireTotal: st.wireTotal,
      goal,
      items: items.map((i) => {
        const p = goalProgress(i, st, settings);
        return { id: i.id, name: i.name, category: i.category, categoryLabel: WIRE_ITEM_CATEGORY_LABELS[i.category], barbs: i.barbs, inStore: i.inStore, ...p, canHandIn: settings.storeOpen && i.inStore && p.ready };
      }),
      handins,
    };
  }

  /** Sets his goal: a row of the table, his own words, or none. */
  @Post('goal')
  @HttpCode(200)
  setGoal(@CurrentGuard() guard: GuardPrincipal, @Body() body: unknown) {
    const b = parseBody(GoalBody, body);
    return this.db.withTenant(guard.companyId, async (tx) => {
      if ('itemId' in b && !(await tx.query('SELECT 1 FROM wire_items WHERE id = $1 AND active', [b.itemId])).rowCount) throw new NotFoundException('That goal is not in the list.');
      await tx.query('UPDATE wire_goals SET ended_at = now() WHERE employee_id = $1 AND ended_at IS NULL', [guard.employeeId]);
      if (!('clear' in b)) {
        await tx.query(`INSERT INTO wire_goals (company_id, employee_id, item_id, own_words) VALUES (app_company_id(), $1, $2, $3)`, [
          guard.employeeId,
          'itemId' in b ? b.itemId : null,
          'ownWords' in b ? b.ownWords : null,
        ]);
      }
      return this.view(tx, guard.employeeId);
    });
  }

  /**
   * Hands in barbs for something in the store, once the store is open and every step is done.
   * The hand-in and its ledger entry are written together, so a failure writes neither.
   */
  @Post('handin')
  @HttpCode(200)
  handIn(@CurrentGuard() guard: GuardPrincipal, @Body() body: unknown) {
    const b = parseBody(HandInBody, body);
    return this.db.withTenant(guard.companyId, async (tx) => {
      if ((await tx.query('SELECT 1 FROM wire_handins WHERE id = $1', [b.eventId])).rowCount) return this.view(tx, guard.employeeId);
      // One hand-in at a time per guard, so two taps cannot spend the same barbs twice.
      await tx.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [guard.employeeId]);
      const { settings } = await this.wire.settings(tx);
      if (!settings.storeOpen) throw new BadRequestException('The store opens soon. Your barbs are safe and waiting.');
      const item = (await this.store.items(tx)).find((i) => i.id === b.itemId && i.active && i.inStore);
      if (!item) throw new NotFoundException('That is not in the store.');
      const st = (await this.store.standing(tx, guard.employeeId))!;
      const p = goalProgress(item, st, settings);
      if (!p.ready) throw new BadRequestException(`Still to come: ${p.steps.find((x) => !x.done)?.toGo ?? 'a step'}.`);
      const e = (await tx.query('SELECT home_site_id FROM employees WHERE id = $1', [guard.employeeId])).rows[0];
      await tx.query(
        `INSERT INTO wire_handins (id, company_id, employee_id, site_id, item_id, item_name, category, barbs, cost_rand) VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8)`,
        [b.eventId, guard.employeeId, guard.siteId ?? e.home_site_id, item.id, item.name, item.category, item.barbs, item.costRand],
      );
      await tx.query(
        `INSERT INTO wire_entries (company_id, employee_id, site_id, entry_date, kind, rule, barbs, source_key, note)
         VALUES (app_company_id(), $1, $2, $3, 'handed_in', 'hand_in', $4, $5, $6)`,
        [guard.employeeId, guard.siteId ?? e.home_site_id, sastDate(new Date()), item.barbs, `handin:${b.eventId}`, item.name],
      );
      return this.view(tx, guard.employeeId);
    });
  }
}
