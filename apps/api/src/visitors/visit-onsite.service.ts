import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { OVERSTAY_ACTION_LABELS, OverstayAction, overstayActionError, overstayDealtWith, PassKind, sastTime, StayAnswer, stayText, stayUntil, vehicleLine, visitDueAt, visitorName } from '@onpar/rules';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { VisitApprovalService } from './visit-approval.service';
import { Gate, GuardActor, VisitExitService } from './visit-exit.service';
import { VisitorSetupService } from './visitor-setup.service';

/** A visitor on site, as the lists show it. Never an ID number. */
export interface OnSiteRow {
  id: string;
  type: 'vehicle' | 'pedestrian';
  visitor: string;
  vehicle: string | null;
  pax: number | null;
  visiting: string;
  unitId: string | null;
  unitName: string | null;
  category: string;
  gateName: string;
  enteredAt: Date;
  /** Time on site, in words. */
  stay: string;
  /** When they should have left. Null: no limit. */
  dueAt: Date | null;
  overdue: boolean;
  /** How long past their time, in words. */
  overBy: string | null;
  /** The guard's latest action on the overstay. */
  action: { action: OverstayAction; label: string; note: string; at: Date; by: string; handoverId: string | null } | null;
  /** Overdue and not dealt with: the guard must act. */
  needsAction: boolean;
  /** Registered by the customer as a contractor. */
  contractor: boolean;
  /** A staff member of the unit. */
  staff: boolean;
  /** What the customer answered when asked about the stay: "Still busy until 21:00" or "Should have left". */
  customerSays: string | null;
  /** When the customer was last asked whether the visitor is still busy. */
  askedAt: Date | null;
}

/**
 * Who is on site, overstays and the shift handover (visitor management, step 6). A visitor
 * past their time shows in red at the gate. If the guard does nothing, the supervisor is told
 * after the site's escalation time. Before a gate guard goes off duty he accounts for every
 * overstay and signs the list off; the incoming guard acknowledges it.
 */
@Injectable()
export class VisitOnSiteService implements OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly setup: VisitorSetupService,
    private readonly approval: VisitApprovalService,
    private readonly exits: VisitExitService,
  ) {}

  startTimer(everyMs = 60_000) {
    const tick = () => this.tick(new Date()).catch((e) => console.error(`Overstay check failed: ${e.message}`));
    this.timer = setInterval(tick, everyMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** When the site's last completed handover began: a confirmation from before it no longer counts. */
  private async lastHandover(tx: Tx, siteId: string): Promise<Date | null> {
    return (await tx.query('SELECT started_at FROM visit_handovers WHERE site_id = $1 AND signed_off_at IS NOT NULL ORDER BY signed_off_at DESC LIMIT 1', [siteId])).rows[0]?.started_at ?? null;
  }

  /** Everyone on site, overstays first (longest over at the top), then longest on site. `unit` narrows it to one customer's visitors. */
  async list(tx: Tx, siteId: string, now: Date, unit?: { unitId: string | null }): Promise<OnSiteRow[]> {
    const { checks } = await this.setup.settings(tx, siteId);
    const since = await this.lastHandover(tx, siteId);
    const rows = (
      await tx.query(
        `SELECT v.id, v.type, p.surname, p.names, ve.registration, ve.make, ve.model, ve.colour, v.pax_in AS pax, v.unit_id AS "unitId", u.name AS "unitName", c.name AS category,
                g.name AS "gateName", COALESCE(v.entry_at, v.captured_at) AS "enteredAt", c.limit_minutes AS "limitMinutes", to_char(c.limit_until, 'HH24:MI') AS "limitUntil",
                ps.kind AS "passKind", to_char(ps.visit_date, 'YYYY-MM-DD') AS "visitDate", to_char(ps.hours_to, 'HH24:MI') AS "hoursTo", to_char(ps.end_date, 'YYYY-MM-DD') AS "endDate",
                to_char(ps.leave_by, 'HH24:MI') AS "leaveBy", COALESCE(ps.contractor, false) AS contractor, v.leave_by AS "extendedTo", v.stay_asked_at AS "askedAt",
                sa.answer AS "stayAnswer", sa.until AS "stayUntil", st.full_name AS "staffName", to_char(st.hours_to, 'HH24:MI') AS "staffHoursTo",
                a.action, a.note, a.at AS "actionAt", a.handover_id AS "handoverId", e.full_name AS "actionBy"
           FROM visits v JOIN visitor_people p ON p.id = v.person_id LEFT JOIN visitor_vehicles ve ON ve.id = v.vehicle_id LEFT JOIN site_units u ON u.id = v.unit_id
           JOIN visitor_categories c ON c.id = v.category_id JOIN site_gates g ON g.id = v.gate_id LEFT JOIN visitor_passes ps ON ps.id = v.pass_id
           LEFT JOIN LATERAL (SELECT x.action, x.note, x.at, x.handover_id, x.guard_id FROM visit_overstay_actions x WHERE x.visit_id = v.id ORDER BY x.at DESC, x.id DESC LIMIT 1) a ON true
           LEFT JOIN employees e ON e.id = a.guard_id
           LEFT JOIN unit_staff st ON st.id = v.staff_id
           LEFT JOIN LATERAL (SELECT s.answer, s.until FROM visit_stay_answers s WHERE s.visit_id = v.id ORDER BY s.at DESC, s.id DESC LIMIT 1) sa ON true
          WHERE v.site_id = $1 AND v.status = 'on_site' AND ($2::boolean IS NOT TRUE OR v.unit_id IS NOT DISTINCT FROM $3::uuid)`,
        [siteId, !!unit, unit?.unitId ?? null],
      )
    ).rows;
    const out = rows.map((r): OnSiteRow => {
      const enteredAt = new Date(r.enteredAt);
      const dueAt = checks.overstayAlert
        ? visitDueAt({ entryAt: enteredAt, limitMinutes: r.limitMinutes, limitUntil: r.limitUntil, pass: r.passKind ? { kind: r.passKind as PassKind, visitDate: r.visitDate, hoursTo: r.hoursTo, endDate: r.endDate, leaveBy: r.leaveBy } : r.staffHoursTo ? { kind: 'ongoing', visitDate: null, hoursTo: r.staffHoursTo, endDate: null } : null, extendedTo: r.extendedTo ? new Date(r.extendedTo) : null })
        : null;
      const overdue = !!dueAt && dueAt.getTime() <= now.getTime();
      const action = r.action ? { action: r.action as OverstayAction, label: OVERSTAY_ACTION_LABELS[r.action as OverstayAction], note: r.note as string, at: new Date(r.actionAt), by: r.actionBy as string, handoverId: r.handoverId as string | null } : null;
      return {
        id: r.id,
        type: r.type,
        visitor: r.staffName ?? visitorName(r.surname, r.names),
        vehicle: r.type === 'vehicle' ? vehicleLine(r) : null,
        pax: r.pax,
        visiting: r.unitName ? `Unit ${r.unitName}` : 'The office',
        unitId: r.unitId,
        unitName: r.unitName,
        category: r.category,
        gateName: r.gateName,
        enteredAt,
        stay: stayText(now.getTime() - enteredAt.getTime()),
        dueAt,
        overdue,
        overBy: overdue ? stayText(now.getTime() - dueAt!.getTime()) : null,
        action,
        needsAction: overdue && !overstayDealtWith(action, since),
        contractor: r.contractor,
        staff: !!r.staffName,
        customerSays: r.stayAnswer === 'should_have_left' ? 'Should have left' : r.stayAnswer === 'extended' ? `Still busy until ${sastTime(new Date(r.stayUntil))}` : null,
        askedAt: r.askedAt ? new Date(r.askedAt) : null,
      };
    });
    return out.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.overdue ? a.dueAt!.getTime() - b.dueAt!.getTime() : a.enteredAt.getTime() - b.enteredAt.getTime()));
  }

  /** The numbers for the gate phone's home screen. */
  async counts(tx: Tx, siteId: string, now: Date) {
    const list = await this.list(tx, siteId, now);
    return { onSite: list.length, overstays: list.filter((v) => v.overdue).length, needAction: list.filter((v) => v.needsAction).length };
  }

  private async onSiteVisit(tx: Tx, siteId: string, visitId: string, now: Date): Promise<OnSiteRow> {
    if (!(await tx.query(`SELECT 1 FROM visits WHERE id = $1 AND site_id = $2 FOR UPDATE`, [visitId, siteId])).rowCount) throw new NotFoundException('Visitor not found.');
    const v = (await this.list(tx, siteId, now)).find((x) => x.id === visitId);
    if (!v) throw new ConflictException('This visitor is no longer on site.');
    return v;
  }

  /**
   * What the guard does about a visitor on site: phones the customer, confirms they are still
   * on site, or marks them as having left without being scanned out. Safe to send twice.
   * For a phone call the number goes to the phone to dial; the guard sees only whose it is.
   */
  async act(tx: Tx, gate: Gate, guard: GuardActor, visitId: string, input: { eventId: string; action: OverstayAction; note: string; handoverId: string | null }, now = new Date()) {
    const again = (await tx.query('SELECT visit_id, action FROM visit_overstay_actions WHERE event_id = $1', [input.eventId])).rows[0];
    const v = again && again.action === 'left' ? null : await this.onSiteVisit(tx, gate.siteId, visitId, now);
    const contact = input.action === 'dialled' && v ? (await this.approval.contacts(tx, { siteId: gate.siteId, unitId: v.unitId, unitName: v.unitName })).primary : undefined;
    const reply = () => (input.action === 'dialled' ? { ok: true, number: contact!.phone, label: contact!.label } : { ok: true });
    if (input.action === 'dialled' && !contact) throw new BadRequestException(`No phone number is set for ${v!.visiting}.`);
    if (again) return reply();
    const problem = overstayActionError(input.action, input.note);
    if (problem) throw new BadRequestException({ message: problem, errors: { note: problem } });
    // Only an overstay is phoned about or confirmed. Anyone on site can be marked as having left unscanned.
    if (input.action !== 'left' && !v!.overdue) throw new ConflictException('This visitor is not past their time.');
    if (input.handoverId) await this.openHandover(tx, input.handoverId, guard.employeeId);
    await tx.query(
      `INSERT INTO visit_overstay_actions (company_id, visit_id, handover_id, action, note, guard_id, device_id, event_id) VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7)`,
      [visitId, input.handoverId, input.action, input.note.trim(), guard.employeeId, guard.deviceId, input.eventId],
    );
    await this.audit.record(tx, {
      actorType: 'employee',
      actorId: guard.employeeId,
      actorLabel: guard.name,
      action: `visit.overstay_${input.action}`,
      entityType: 'visit',
      entityId: visitId,
      after: { gateId: gate.id, deviceId: guard.deviceId, handoverId: input.handoverId, note: input.note.trim(), overdue: v!.overdue, dueAt: v!.dueAt },
    });
    if (input.action === 'left') await this.exits.markLeft(tx, gate, guard, visitId, input.note.trim(), input.eventId);
    return reply();
  }

  // --- The shift handover ---------------------------------------------------------------------

  private async openHandover(tx: Tx, id: string, guardId: string) {
    const h = (await tx.query('SELECT id, site_id AS "siteId", started_at AS "startedAt", signed_off_at AS "signedOffAt", outgoing_guard AS "outgoingGuard" FROM visit_handovers WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!h || h.outgoingGuard !== guardId) throw new NotFoundException('Handover not found.');
    if (h.signedOffAt) throw new ConflictException('This handover has already been signed off.');
    return h as { id: string; siteId: string; startedAt: Date };
  }

  /** "Hand over shift": opens the outgoing guard's handover at this gate, or returns the one he already has open. */
  async start(tx: Tx, gate: Gate, guard: GuardActor, now = new Date()) {
    let id = (await tx.query('SELECT id FROM visit_handovers WHERE gate_id = $1 AND outgoing_guard = $2 AND signed_off_at IS NULL ORDER BY started_at DESC LIMIT 1', [gate.id, guard.employeeId])).rows[0]?.id as string | undefined;
    if (!id) {
      id = (await tx.query('INSERT INTO visit_handovers (company_id, site_id, gate_id, device_id, outgoing_guard) VALUES (app_company_id(), $1, $2, $3, $4) RETURNING id', [gate.siteId, gate.id, guard.deviceId, guard.employeeId])).rows[0].id as string;
      await this.audit.record(tx, { actorType: 'employee', actorId: guard.employeeId, actorLabel: guard.name, action: 'visit_handover.start', entityType: 'visit_handover', entityId: id, after: { gateId: gate.id, deviceId: guard.deviceId } });
    }
    return this.handoverView(tx, gate.siteId, id, now);
  }

  /** The handover as the outgoing guard works through it: every overstay needs an action taken in this handover. */
  private async handoverView(tx: Tx, siteId: string, id: string, now: Date) {
    const list = await this.list(tx, siteId, now);
    const visitors = list.map((v) => {
      const mine = v.action?.handoverId === id ? v.action : null;
      return { ...v, handoverAction: mine, todo: v.overdue && !mine };
    });
    const todo = visitors.filter((v) => v.todo).length;
    return { id, onSite: visitors.length, overstays: visitors.filter((v) => v.overdue).length, todo, canSignOff: todo === 0, visitors };
  }

  /** The outgoing guard signs off. Refused while an overstay has no action; one that was only phoned about goes to the supervisor as unresolved. */
  async signOff(tx: Tx, gate: Gate, guard: GuardActor, id: string, now = new Date()) {
    const done = (await tx.query('SELECT signed_off_at FROM visit_handovers WHERE id = $1 AND outgoing_guard = $2', [id, guard.employeeId])).rows[0];
    if (done?.signed_off_at) return { ok: true, id };
    await this.openHandover(tx, id, guard.employeeId);
    const view = await this.handoverView(tx, gate.siteId, id, now);
    if (!view.canSignOff) throw new ConflictException(`${view.todo} visitor${view.todo === 1 ? ' is' : 's are'} past their time. Deal with each one before you sign off.`);
    const unresolved = view.visitors.filter((v) => v.overdue && v.handoverAction?.action === 'dialled');
    const snapshot = view.visitors.map((v) => ({ visitId: v.id, overdue: v.overdue, overBy: v.overBy, action: v.handoverAction?.action ?? null, note: v.handoverAction?.note ?? '' }));
    await tx.query('UPDATE visit_handovers SET signed_off_at = now(), on_site_count = $2, overstay_count = $3, unresolved_count = $4, snapshot = $5 WHERE id = $1', [id, view.onSite, view.overstays, unresolved.length, JSON.stringify(snapshot)]);
    await this.audit.record(tx, {
      actorType: 'employee',
      actorId: guard.employeeId,
      actorLabel: guard.name,
      action: 'visit_handover.sign_off',
      entityType: 'visit_handover',
      entityId: id,
      after: { gateId: gate.id, deviceId: guard.deviceId, onSite: view.onSite, overstays: view.overstays, unresolved: unresolved.length, snapshot },
    });
    if (unresolved.length) {
      await this.notifications.recordForSite(tx, gate.siteId, {
        kind: 'visitor_handover',
        title: `Unresolved overstay at ${gate.siteName}`,
        body: `${guard.name} handed over at ${gate.name} with ${unresolved.length} overstay${unresolved.length === 1 ? '' : 's'} unresolved: the customer was phoned, with no result.`,
        lockScreen: 'A gate was handed over with an overstay unresolved.',
        url: `/sites/${gate.siteId}`,
        entityType: 'visit_handover',
        entityId: id,
      });
    }
    return { ok: true, id };
  }

  /** The last handover signed off at this gate by somebody else and not yet acknowledged: the incoming guard's to review. */
  async pending(tx: Tx, gate: Gate, guardId: string) {
    const h = (
      await tx.query(
        `SELECT h.id, h.signed_off_at AS "signedOffAt", h.on_site_count AS "onSite", h.overstay_count AS overstays, h.unresolved_count AS unresolved, h.snapshot, e.full_name AS "from"
           FROM visit_handovers h JOIN employees e ON e.id = h.outgoing_guard
          WHERE h.gate_id = $1 AND h.signed_off_at IS NOT NULL ORDER BY h.signed_off_at DESC LIMIT 1`,
        [gate.id],
      )
    ).rows[0];
    if (!h) return null;
    const mine = (await tx.query('SELECT acknowledged_at, outgoing_guard FROM visit_handovers WHERE id = $1', [h.id])).rows[0];
    if (mine.acknowledged_at || mine.outgoing_guard === guardId) return null;
    const { snapshot, ...rest } = h;
    return { ...rest, notes: await this.notes(tx, snapshot ?? []) };
  }

  /** The overstays of a signed-off handover, with what the outgoing guard did and wrote. */
  private async notes(tx: Tx, snapshot: { visitId: string; overdue: boolean; overBy: string | null; action: OverstayAction | null; note: string }[]) {
    const over = snapshot.filter((s) => s.overdue);
    if (!over.length) return [];
    const who = new Map(
      (
        await tx.query(
          `SELECT v.id, p.surname, p.names, ve.registration, u.name AS "unitName" FROM visits v JOIN visitor_people p ON p.id = v.person_id LEFT JOIN visitor_vehicles ve ON ve.id = v.vehicle_id
             LEFT JOIN site_units u ON u.id = v.unit_id WHERE v.id = ANY($1::uuid[])`,
          [over.map((s) => s.visitId)],
        )
      ).rows.map((r) => [r.id as string, r]),
    );
    return over.map((s) => {
      const v = who.get(s.visitId);
      return {
        visitor: v ? visitorName(v.surname, v.names) : 'Visitor',
        vehicle: (v?.registration as string | null) ?? null,
        visiting: v?.unitName ? `Unit ${v.unitName}` : 'The office',
        overBy: s.overBy,
        action: s.action ? OVERSTAY_ACTION_LABELS[s.action] : null,
        note: s.note,
      };
    });
  }

  /** The incoming guard has read the list. */
  async acknowledge(tx: Tx, gate: Gate, guard: GuardActor, id: string) {
    const h = (await tx.query('SELECT gate_id, outgoing_guard, signed_off_at, incoming_guard FROM visit_handovers WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!h || h.gate_id !== gate.id || !h.signed_off_at) throw new NotFoundException('Handover not found.');
    if (h.incoming_guard) return { ok: true };
    if (h.outgoing_guard === guard.employeeId) throw new ConflictException('The guard coming on duty acknowledges the handover, not the guard who handed over.');
    await tx.query('UPDATE visit_handovers SET incoming_guard = $2, acknowledged_at = now() WHERE id = $1', [id, guard.employeeId]);
    await this.audit.record(tx, { actorType: 'employee', actorId: guard.employeeId, actorLabel: guard.name, action: 'visit_handover.acknowledge', entityType: 'visit_handover', entityId: id, after: { gateId: gate.id, deviceId: guard.deviceId } });
    return { ok: true };
  }

  /** The site's last handovers, for the supervisor to review. */
  async handovers(tx: Tx, siteId: string) {
    const rows = (
      await tx.query(
        `SELECT h.id, h.started_at AS "startedAt", h.signed_off_at AS "signedOffAt", h.on_site_count AS "onSite", h.overstay_count AS overstays, h.unresolved_count AS unresolved, h.snapshot,
                g.name AS "gateName", o.full_name AS outgoing, i.full_name AS incoming, h.acknowledged_at AS "acknowledgedAt"
           FROM visit_handovers h JOIN site_gates g ON g.id = h.gate_id JOIN employees o ON o.id = h.outgoing_guard LEFT JOIN employees i ON i.id = h.incoming_guard
          WHERE h.site_id = $1 AND h.signed_off_at IS NOT NULL ORDER BY h.signed_off_at DESC LIMIT 30`,
        [siteId],
      )
    ).rows;
    const out = [];
    for (const { snapshot, ...h } of rows) out.push({ ...h, notes: await this.notes(tx, snapshot ?? []) });
    return out;
  }

  /** Asks the people of the unit whether a visitor past their time is still busy. They answer in the app. */
  private async askCustomer(tx: Tx, siteId: string, v: OnSiteRow, now: Date) {
    await tx.query('UPDATE visits SET stay_asked_at = $2 WHERE id = $1', [v.id, now]);
    const people = (
      await tx.query(`SELECT id FROM customers WHERE site_id = $1 AND active AND (($2::uuid IS NOT NULL AND unit_id = $2::uuid) OR ($2::uuid IS NULL AND kind = 'client'))`, [siteId, v.unitId])
    ).rows.map((r) => r.id as string);
    if (!people.length) return;
    const what = v.staff ? 'staff member' : v.contractor ? 'contractor' : 'visitor';
    await this.notifications.record(tx, {
      userIds: [],
      customerIds: people,
      kind: 'visitor_still_on_site',
      title: `Your ${what} is still on site`,
      body: `${v.visitor} was due to leave by ${sastTime(v.dueAt!)} and has not been scanned out. Open to tell the gate: still busy, or should have left.`,
      lockScreen: `A ${what} of yours is still on site. Open On Par to answer.`,
      url: `/c/visits/${v.id}`,
      siteId,
      entityType: 'visit',
      entityId: v.id,
    });
  }

  /**
   * A customer's answer about their visitor on site: "still busy until HH:MM" moves the time to
   * be gone by (and can be given at any time); "should have left" goes to the gate in red and
   * to the supervisor at once.
   */
  async answerStay(tx: Tx, me: { customerId: string; name: string; siteId: string; unitId: string | null; customerKind: 'client' | 'tenant' }, visitId: string, answer: StayAnswer, until: string | null, now = new Date()) {
    if (!(await tx.query('SELECT 1 FROM visits WHERE id = $1 AND site_id = $2 FOR UPDATE', [visitId, me.siteId])).rowCount) throw new NotFoundException('Visitor not found.');
    const v = (await this.list(tx, me.siteId, now)).find((x) => x.id === visitId && (x.unitId ? x.unitId === me.unitId : me.customerKind === 'client'));
    if (!v) throw new ConflictException('This visitor is no longer on site.');
    if (answer === 'extended') {
      const to = until ? stayUntil(now, until) : null;
      if (!to) throw new BadRequestException({ message: 'Choose the time they will be busy until.', errors: { until: 'Choose a time.' } });
      await tx.query('UPDATE visits SET leave_by = $2 WHERE id = $1', [visitId, to]);
      await tx.query(`INSERT INTO visit_stay_answers (company_id, visit_id, customer_id, answer, until) VALUES (app_company_id(), $1, $2, 'extended', $3)`, [visitId, me.customerId, to]);
      await this.audit.record(tx, { actorType: 'customer', actorId: me.customerId, actorLabel: me.name, action: 'visit.stay_extended', entityType: 'visit', entityId: visitId, before: { dueAt: v.dueAt }, after: { until: to } });
      return;
    }
    if (!v.overdue) throw new ConflictException('This visitor is not past their time.');
    await tx.query(`INSERT INTO visit_stay_answers (company_id, visit_id, customer_id, answer) VALUES (app_company_id(), $1, $2, 'should_have_left')`, [visitId, me.customerId]);
    await this.audit.record(tx, { actorType: 'customer', actorId: me.customerId, actorLabel: me.name, action: 'visit.stay_should_have_left', entityType: 'visit', entityId: visitId, after: { dueAt: v.dueAt } });
    // Straight to the supervisor: the customer does not know where this person is.
    await tx.query(
      `INSERT INTO visit_overstays (visit_id, company_id, site_id, due_at, flagged_at, supervisor_alerted_at) VALUES ($1, app_company_id(), $2, $3, $4, $4)
       ON CONFLICT (visit_id) DO UPDATE SET supervisor_alerted_at = COALESCE(visit_overstays.supervisor_alerted_at, excluded.supervisor_alerted_at)`,
      [visitId, me.siteId, v.dueAt, now],
    );
    const siteName = (await tx.query('SELECT name FROM sites WHERE id = $1', [me.siteId])).rows[0].name as string;
    await this.notifications.recordForSite(tx, me.siteId, {
      kind: 'visitor_overstay',
      title: `Visitor overstay at ${siteName}`,
      body: `${v.visitor}, visiting ${v.unitName ? `unit ${v.unitName}` : 'the office'}, is ${v.overBy} past their time. ${me.name} says they should have left.`,
      lockScreen: 'A visitor is on site past their time.',
      url: `/sites/${me.siteId}`,
      entityType: 'visit',
      entityId: visitId,
    });
  }

  // --- Escalation ----------------------------------------------------------------------------

  /**
   * Once a minute: notes each new overstay (the gate phone shows it to the guard), and tells
   * the supervisor about any the guard has not dealt with within the site's escalation time.
   */
  async tick(now: Date): Promise<number> {
    const companies = await this.db.query<{ scheduler_company_ids: string }>('SELECT * FROM scheduler_company_ids()');
    let told = 0;
    for (const { scheduler_company_ids: companyId } of companies) {
      await this.db.withTenant(companyId, async (tx) => {
        const sites = (await tx.query(`SELECT DISTINCT v.site_id AS id, s.name FROM visits v JOIN sites s ON s.id = v.site_id WHERE v.status = 'on_site'`)).rows as { id: string; name: string }[];
        for (const site of sites) {
          const settings = await this.setup.settings(tx, site.id);
          if (!settings.checks.overstayAlert) continue;
          const over = (await this.list(tx, site.id, now)).filter((v) => v.overdue);
          for (const v of over) {
            // Noted afresh when the customer gave a later time and that has passed too.
            await tx.query(
              `INSERT INTO visit_overstays (visit_id, company_id, site_id, due_at, flagged_at) VALUES ($1, app_company_id(), $2, $3, $4)
               ON CONFLICT (visit_id) DO UPDATE SET due_at = excluded.due_at, flagged_at = excluded.flagged_at, supervisor_alerted_at = NULL WHERE visit_overstays.due_at <> excluded.due_at`,
              [v.id, site.id, v.dueAt, now],
            );
            // First the customer is asked, automatically: is the visitor still busy? (owner, 7 Oct 2026: no phone calls by guards)
            if (!v.askedAt || v.askedAt.getTime() < v.dueAt!.getTime()) await this.askCustomer(tx, site.id, v, now);
            if (!v.needsAction) continue;
            const due = await tx.query(
              `UPDATE visit_overstays SET supervisor_alerted_at = $2 WHERE visit_id = $1 AND supervisor_alerted_at IS NULL AND flagged_at <= $2::timestamptz - make_interval(mins => $3) RETURNING visit_id`,
              [v.id, now, settings.overstayEscalationMinutes],
            );
            if (!due.rowCount) continue;
            told += 1;
            await this.notifications.recordForSite(tx, site.id, {
              kind: 'visitor_overstay',
              title: `Visitor overstay at ${site.name}`,
              body: `${v.visitor}, visiting ${v.unitName ? `unit ${v.unitName}` : 'the office'}, is ${v.overBy} past their time and the gate has not dealt with it.`,
              lockScreen: 'A visitor is on site past their time.',
              url: `/sites/${site.id}`,
              entityType: 'visit',
              entityId: v.id,
            });
          }
        }
      });
    }
    return told;
  }
}
