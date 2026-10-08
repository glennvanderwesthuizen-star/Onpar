import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { maskIdNumber, normaliseCell, normaliseIdNumber, normalisePlate, passErrors, PassKind, passWhen } from '@onpar/rules';
import { CustomerPrincipal } from '../common/auth';
import { throwIfErrors } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { VisitorSetupService } from './visitor-setup.service';

export interface PassBody {
  kind: PassKind;
  visitorName: string;
  categoryId: string | null;
  contractor: boolean;
  maxWorkers: number | null;
  leaveBy: string | null;
  gateId: string | null;
  idNumber: string;
  cell: string;
  registration: string;
  visitDate: string | null;
  time: string | null;
  days: number[];
  hoursFrom: string | null;
  hoursTo: string | null;
  startDate: string | null;
  endDate: string | null;
}

/** A pass that matches the visitor at the gate. */
export interface PassMatch {
  passId: string;
  kind: PassKind;
  unitId: string | null;
  unitName: string | null;
  categoryId: string;
  category: string;
  visitorName: string;
  by: string;
  /** A contractor the customer registered: how many workers may come with him, and when he must be gone. */
  contractor: boolean;
  maxWorkers: number | null;
  leaveBy: string | null;
  /** The gate the customer named, when it is not this one. */
  namedGate: string | null;
  /** What did not match what the customer gave ("number plate"); the visitor is still let in and the customer told. */
  mismatch: string[];
}

const COLUMNS = `p.id, p.kind, p.visitor_name AS "visitorName", p.unit_id AS "unitId", u.name AS "unitName", p.category_id AS "categoryId", c.name AS category, c.kind AS "categoryKind",
  p.gate_id AS "gateId", g.name AS "gateName", p.id_number, p.cell, p.registration, to_char(p.visit_date, 'YYYY-MM-DD') AS "visitDate", to_char(p.time_from, 'HH24:MI') AS time,
  p.days, to_char(p.hours_from, 'HH24:MI') AS "hoursFrom", to_char(p.hours_to, 'HH24:MI') AS "hoursTo", to_char(p.start_date, 'YYYY-MM-DD') AS "startDate",
  to_char(p.end_date, 'YYYY-MM-DD') AS "endDate", p.status, p.created_at AS "createdAt", cu.full_name AS by,
  p.contractor, p.max_workers AS "maxWorkers", to_char(COALESCE(p.leave_by, CASE WHEN p.contractor THEN c.limit_until END), 'HH24:MI') AS "leaveBy"`;
const FROM = `visitor_passes p JOIN visitor_categories c ON c.id = p.category_id JOIN customers cu ON cu.id = p.created_by
  LEFT JOIN site_units u ON u.id = p.unit_id LEFT JOIN site_gates g ON g.id = p.gate_id`;
/** South African time now, as a plain timestamp. */
const LOCAL = `(now() AT TIME ZONE 'Africa/Johannesburg')`;
/** A pass that can no longer be used: its day or its last day has passed. */
const OVER = `((p.kind = 'once' AND p.visit_date < ${LOCAL}::date) OR (p.kind = 'ongoing' AND p.end_date IS NOT NULL AND p.end_date < ${LOCAL}::date))`;
/** A pass that applies at this moment. With a time, one hour either side; a regular on its days, hours and dates. */
const APPLIES_NOW = `(
  (p.kind = 'once' AND ((p.time_from IS NULL AND p.visit_date = ${LOCAL}::date)
     OR (p.time_from IS NOT NULL AND ${LOCAL} BETWEEN (p.visit_date + p.time_from) - interval '1 hour' AND (p.visit_date + p.time_from) + interval '1 hour')))
  OR (p.kind = 'ongoing' AND (p.start_date IS NULL OR p.start_date <= ${LOCAL}::date) AND (p.end_date IS NULL OR p.end_date >= ${LOCAL}::date)
     AND (p.days IS NULL OR extract(isodow FROM ${LOCAL})::int = ANY(p.days)) AND (p.hours_from IS NULL OR ${LOCAL}::time BETWEEN p.hours_from AND p.hours_to)))`;
/** The passes that are a customer's: for their unit, or for the office when they are the client. */
const MINE = `p.site_id = $1 AND (($2::uuid IS NOT NULL AND p.unit_id = $2::uuid) OR (p.unit_id IS NULL AND $3 = 'client'))`;

/**
 * Passes (visitor management, step 4): a customer tells the gate in advance who is coming, for
 * one visit or as a regular. A visitor who matches a pass on one identifier is let in without
 * the customer being asked; if another identifier does not match, the customer is told.
 */
@Injectable()
export class VisitPassService implements OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly setup: VisitorSetupService,
  ) {}

  /** The pass, if any, that lets this visitor in now. An earlier one-visit pass is preferred to a regular's. */
  async match(tx: Tx, siteId: string, gateId: string, v: { idNumber?: string; registration?: string; cell?: string }): Promise<PassMatch | null> {
    if (!v.idNumber && !v.registration && !v.cell) return null;
    const p = (
      await tx.query(
        `SELECT ${COLUMNS} FROM ${FROM}
          WHERE p.site_id = $1 AND p.status = 'active' AND ${APPLIES_NOW}
            AND ((p.id_number IS NOT NULL AND p.id_number = $2) OR (p.registration IS NOT NULL AND p.registration = $3) OR (p.cell IS NOT NULL AND p.cell = $4))
          ORDER BY (p.kind = 'once') DESC, p.created_at LIMIT 1`,
        [siteId, v.idNumber ?? null, v.registration ?? null, v.cell ?? null],
      )
    ).rows[0];
    if (!p) return null;
    const mismatch: string[] = [];
    if (p.registration && v.registration && p.registration !== v.registration) mismatch.push('number plate');
    if (p.id_number && v.idNumber && p.id_number !== v.idNumber) mismatch.push('ID number');
    return {
      passId: p.id,
      kind: p.kind,
      unitId: p.unitId,
      unitName: p.unitName,
      categoryId: p.categoryId,
      category: p.category,
      visitorName: p.visitorName,
      by: p.by,
      contractor: p.contractor,
      maxWorkers: p.maxWorkers,
      leaveBy: p.leaveBy,
      namedGate: p.gateId && p.gateId !== gateId ? p.gateName : null,
      mismatch,
    };
  }

  /**
   * The pass a gate phone with no signal let a visitor in on (gate without signal). Found by its id
   * and not by the time now: it fitted when the guard checked it, even if it is used or over by the
   * time the visit reaches the server.
   */
  async forOffline(tx: Tx, siteId: string, gateId: string, passId: string, v: { idNumber?: string; registration?: string }): Promise<PassMatch | null> {
    const p = (await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE p.id = $1 AND p.site_id = $2`, [passId, siteId])).rows[0];
    if (!p) return null;
    const mismatch: string[] = [];
    if (p.registration && v.registration && p.registration !== v.registration) mismatch.push('number plate');
    if (p.id_number && v.idNumber && p.id_number !== v.idNumber) mismatch.push('ID number');
    return {
      passId: p.id,
      kind: p.kind,
      unitId: p.unitId,
      unitName: p.unitName,
      categoryId: p.categoryId,
      category: p.category,
      visitorName: p.visitorName,
      by: p.by,
      contractor: p.contractor,
      maxWorkers: p.maxWorkers,
      leaveBy: p.leaveBy,
      namedGate: p.gateId && p.gateId !== gateId ? p.gateName : null,
      mismatch,
    };
  }

  /**
   * The passes a gate phone keeps for when it has no signal: every active pass that can apply today
   * or tomorrow, with what the phone needs to match and time it itself.
   */
  async forPack(tx: Tx, siteId: string) {
    return (
      await tx.query(
        `SELECT ${COLUMNS} FROM ${FROM}
          WHERE p.site_id = $1 AND p.status = 'active' AND NOT ${OVER}
            AND ((p.kind = 'once' AND p.visit_date <= ${LOCAL}::date + 1) OR (p.kind = 'ongoing' AND (p.start_date IS NULL OR p.start_date <= ${LOCAL}::date + 1)))
          ORDER BY (p.kind = 'once') DESC, p.created_at LIMIT 500`,
        [siteId],
      )
    ).rows.map((p) => ({
      id: p.id as string,
      kind: p.kind as PassKind,
      visitorName: p.visitorName as string,
      unitId: (p.unitId ?? null) as string | null,
      visiting: p.unitName ? `Unit ${p.unitName}` : 'The office',
      category: p.category as string,
      by: p.by as string,
      gateId: (p.gateId ?? null) as string | null,
      gateName: (p.gateName ?? null) as string | null,
      idNumber: (p.id_number ?? null) as string | null,
      registration: (p.registration ?? null) as string | null,
      cell: (p.cell ?? null) as string | null,
      visitDate: (p.visitDate ?? null) as string | null,
      time: (p.time ?? null) as string | null,
      days: (p.days ?? null) as number[] | null,
      hoursFrom: (p.hoursFrom ?? null) as string | null,
      hoursTo: (p.hoursTo ?? null) as string | null,
      startDate: (p.startDate ?? null) as string | null,
      endDate: (p.endDate ?? null) as string | null,
      contractor: !!p.contractor,
      maxWorkers: (p.maxWorkers ?? null) as number | null,
      leaveBy: (p.leaveBy ?? null) as string | null,
    }));
  }

  /** A one-visit pass is used up by one entry, where the site limits it to one. */
  async used(tx: Tx, passId: string, visitId: string, entryLimit: boolean) {
    await tx.query(`UPDATE visitor_passes SET used_at = now(), used_visit_id = $2, status = CASE WHEN status = 'active' AND kind = 'once' AND $3 THEN 'used' ELSE status END WHERE id = $1`, [passId, visitId, entryLimit]);
  }

  /** The gate's "Expected today" list: every pass that applies some time today, soonest first. */
  async expectedToday(tx: Tx, siteId: string) {
    return (
      await tx.query(
        `SELECT ${COLUMNS} FROM ${FROM}
          WHERE p.site_id = $1 AND p.status = 'active'
            AND ((p.kind = 'once' AND p.visit_date = ${LOCAL}::date)
              OR (p.kind = 'ongoing' AND (p.start_date IS NULL OR p.start_date <= ${LOCAL}::date) AND (p.end_date IS NULL OR p.end_date >= ${LOCAL}::date)
                  AND (p.days IS NULL OR extract(isodow FROM ${LOCAL})::int = ANY(p.days))))
          ORDER BY (p.kind = 'once') DESC, coalesce(p.time_from, p.hours_from, '00:00'), lower(p.visitor_name) LIMIT 200`,
        [siteId],
      )
    ).rows.map((p) => ({
      id: p.id as string,
      visitorName: p.visitorName as string,
      visiting: p.unitName ? `Unit ${p.unitName}` : 'The office',
      category: p.category as string,
      when: p.kind === 'once' ? (p.time ? `About ${p.time}` : 'Any time today') : p.hoursFrom ? `${p.hoursFrom} to ${p.hoursTo}` : 'Any time today',
      gateName: (p.gateName ?? null) as string | null,
      // What the gate matches on, without showing the numbers in full.
      knownBy: [p.id_number ? 'ID number' : null, p.registration ? `plate ${p.registration}` : null, p.cell ? `cell ending ${String(p.cell).slice(-4)}` : null].filter(Boolean).join(', '),
    }));
  }

  /** What a customer can choose from when making a pass. */
  async options(tx: Tx, me: CustomerPrincipal) {
    const categories = (await this.setup.categories(tx, me.siteId)).filter((c) => c.active).map((c) => ({ id: c.id, name: c.name }));
    const gates = (await tx.query('SELECT id, name FROM site_gates WHERE site_id = $1 AND active ORDER BY created_at, lower(name)', [me.siteId])).rows;
    return { categories, gates, today: await this.today(tx) };
  }

  /** A customer's passes: those still in use first, then the last few that ended. */
  async list(tx: Tx, me: CustomerPrincipal) {
    const rows = (
      await tx.query(
        `SELECT ${COLUMNS}, ${OVER} AS over FROM ${FROM} WHERE ${MINE} AND (p.status = 'active' AND NOT ${OVER} OR p.created_at > now() - interval '30 days')
          ORDER BY (p.status = 'active' AND NOT ${OVER}) DESC, p.created_at DESC LIMIT 100`,
        [me.siteId, me.unitId, me.customerKind],
      )
    ).rows.map(shape);
    return { current: rows.filter((r) => r.state === 'current'), past: rows.filter((r) => r.state !== 'current').slice(0, 10) };
  }

  async create(tx: Tx, me: CustomerPrincipal, b: PassBody, from?: { visitId: string; idNumber: string | null; registration: string | null }) {
    // A contractor goes under the site's contractor kind (which carries the usual time to be gone by); anyone else is a visitor.
    const active = (await this.setup.categories(tx, me.siteId)).filter((c) => c.active);
    const category = b.contractor ? (active.find((c) => c.contractor) ?? active[0]) : b.categoryId ? active.find((c) => c.id === b.categoryId) : (active.find((c) => !c.contractor) ?? active[0]);
    if (!category) throw new BadRequestException({ message: 'Choose the kind of visitor.', errors: { categoryId: 'Choose the kind of visitor.' } });
    b = { ...b, categoryId: category.id, maxWorkers: b.contractor ? b.maxWorkers : null, leaveBy: b.contractor ? b.leaveBy : null };
    // Made from an approved visit: the ID number and number plate come from that visit, which the customer never sees in full.
    const idNumber = from ? (from.idNumber ?? '') : b.idNumber;
    const registration = from ? (from.registration ?? '') : b.registration;
    throwIfErrors(passErrors({ ...b, idNumber, registration }, await this.today(tx)));
    if (b.gateId && !(await tx.query('SELECT 1 FROM site_gates WHERE id = $1 AND site_id = $2 AND active', [b.gateId, me.siteId])).rowCount) {
      throw new BadRequestException({ message: 'Choose a gate of this site.', errors: { gateId: 'Unknown gate.' } });
    }
    const once = b.kind === 'once';
    const id = (
      await tx.query(
        `INSERT INTO visitor_passes (company_id, site_id, unit_id, created_by, category_id, gate_id, visitor_name, id_number, cell, registration, kind, visit_date, time_from,
                                     days, hours_from, hours_to, start_date, end_date, from_visit_id, contractor, max_workers, leave_by)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12::time, $13::smallint[], $14::time, $15::time, $16::date, $17::date, $18, $19, $20, $21::time) RETURNING id`,
        [
          me.siteId,
          me.unitId,
          me.customerId,
          b.categoryId,
          b.gateId,
          b.visitorName.trim(),
          normaliseIdNumber(idNumber) || null,
          normaliseCell(b.cell) || null,
          normalisePlate(registration) || null,
          b.kind,
          once ? b.visitDate : null,
          once ? b.time : null,
          once || !b.days.length || b.days.length === 7 ? null : [...new Set(b.days)].sort((x, y) => x - y),
          once ? null : b.hoursFrom,
          once ? null : b.hoursTo,
          once ? null : b.startDate,
          once ? null : b.endDate,
          from?.visitId ?? null,
          b.contractor,
          b.maxWorkers,
          b.leaveBy,
        ],
      )
    ).rows[0].id as string;
    await this.audit.byAccount(tx, me, { action: 'pass.create', entityType: 'visitor_pass', entityId: id, after: { kind: b.kind, categoryId: b.categoryId, contractor: b.contractor, maxWorkers: b.maxWorkers, leaveBy: b.leaveBy, gateId: b.gateId, fromVisitId: from?.visitId ?? null, when: passWhen(b) } });
    return { id };
  }

  /** "Let this visitor in next time": a pass made from a visitor the customer's unit has approved. */
  async createFromVisit(tx: Tx, me: CustomerPrincipal, visitId: string, b: PassBody) {
    const v = (
      await tx.query(
        `SELECT v.status, p.id_number AS "idNumber", ve.registration, p.surname, p.names FROM visits v JOIN visitor_people p ON p.id = v.person_id LEFT JOIN visitor_vehicles ve ON ve.id = v.vehicle_id
          WHERE v.id = $4 AND v.site_id = $1 AND (($2::uuid IS NOT NULL AND v.unit_id = $2::uuid) OR (v.unit_id IS NULL AND $3 = 'client'))`,
        [me.siteId, me.unitId, me.customerKind, visitId],
      )
    ).rows[0];
    if (!v) throw new NotFoundException('Visitor not found.');
    if (!['on_site', 'exited'].includes(v.status)) throw new ConflictException('Only a visitor you have let in can be given a pass.');
    return this.create(tx, me, b, { visitId, idNumber: v.idNumber, registration: v.registration });
  }

  async cancel(tx: Tx, me: CustomerPrincipal, id: string) {
    const r = await tx.query(`UPDATE visitor_passes p SET status = 'cancelled', cancelled_at = now(), cancelled_by = $5 WHERE p.id = $4 AND ${MINE} AND p.status = 'active' RETURNING p.id`, [me.siteId, me.unitId, me.customerKind, id, me.customerId]);
    if (!r.rowCount) throw new NotFoundException('That visitor is not on your list.');
    await this.audit.byAccount(tx, me, { action: 'pass.cancel', entityType: 'visitor_pass', entityId: id });
    return { ok: true };
  }

  startTimer(everyMs = 30 * 60_000) {
    const tick = () => this.endingTick().catch((e) => console.error(`Pass check failed: ${e.message}`));
    tick();
    this.timer = setInterval(tick, everyMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Tells the customer once when a fixed-period contractor has three days or fewer left (spec: notifications). */
  async endingTick(): Promise<number> {
    const companies = await this.db.query<{ scheduler_company_ids: string }>('SELECT * FROM scheduler_company_ids()');
    let told = 0;
    for (const { scheduler_company_ids: companyId } of companies) {
      await this.db.withTenant(companyId, async (tx) => {
        const ending = (
          await tx.query(
            `SELECT p.id, p.site_id AS "siteId", p.unit_id AS "unitId", p.visitor_name AS "visitorName", to_char(p.end_date, 'YYYY-MM-DD') AS "endDate"
               FROM visitor_passes p JOIN visitor_categories c ON c.id = p.category_id
              WHERE p.status = 'active' AND p.kind = 'ongoing' AND p.end_date IS NOT NULL AND p.expiry_told_at IS NULL
                AND p.end_date BETWEEN ${LOCAL}::date AND ${LOCAL}::date + 3 FOR UPDATE OF p`,
          )
        ).rows;
        for (const p of ending) {
          const people = (
            await tx.query(`SELECT id FROM customers WHERE site_id = $1 AND active AND (($2::uuid IS NOT NULL AND unit_id = $2::uuid) OR ($2::uuid IS NULL AND kind = 'client'))`, [p.siteId, p.unitId])
          ).rows.map((r) => r.id as string);
          await tx.query('UPDATE visitor_passes SET expiry_told_at = now() WHERE id = $1', [p.id]);
          if (!people.length) continue;
          await this.notifications.record(tx, {
            userIds: [],
            customerIds: people,
            kind: 'visitor_pass_ending',
            title: 'A contractor’s time is nearly up',
            body: `${p.visitorName} can come in until ${p.endDate}. After that the gate will ask you each time, unless you give a new end date.`,
            lockScreen: 'A regular visitor’s time is nearly up.',
            url: '/c/visitors',
            siteId: p.siteId,
            entityType: 'visitor_pass',
            entityId: p.id,
          });
          told++;
        }
      });
    }
    return told;
  }

  private async today(tx: Tx): Promise<string> {
    return (await tx.query(`SELECT to_char(${LOCAL}, 'YYYY-MM-DD') AS d`)).rows[0].d;
  }
}

function shape(p: Record<string, any>) {
  const state = p.status === 'cancelled' ? 'cancelled' : p.status === 'used' ? 'used' : p.over ? 'ended' : 'current';
  return {
    id: p.id as string,
    kind: p.kind as PassKind,
    visitorName: p.visitorName as string,
    category: p.category as string,
    gateName: (p.gateName ?? null) as string | null,
    when: passWhen({ kind: p.kind, visitDate: p.visitDate, time: p.time, days: p.days, hoursFrom: p.hoursFrom, hoursTo: p.hoursTo, startDate: p.startDate, endDate: p.endDate }),
    // The ID number shows its last four characters only: it may have come from a scan at the gate.
    idNumber: p.id_number ? maskIdNumber(p.id_number) : null,
    cell: (p.cell ?? null) as string | null,
    registration: (p.registration ?? null) as string | null,
    by: p.by as string,
    contractor: p.contractor as boolean,
    maxWorkers: (p.maxWorkers ?? null) as number | null,
    leaveBy: (p.contractor ? p.leaveBy : null) as string | null,
    state,
    stateLabel: { current: p.kind === 'once' ? 'Expected' : 'Regular', used: 'Arrived', ended: 'Ended', cancelled: 'Removed' }[state] as string,
  };
}
