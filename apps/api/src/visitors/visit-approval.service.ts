import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CallContact, CallOutcome, VISIT_STATUS_LABELS, VisitStatus, vehicleLine, visitorName } from '@onpar/rules';
import { Tx } from '../db/db.service';
import { AuditEntry, AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { VisitorSetupService } from './visitor-setup.service';

/** A visit as the approval steps need it. */
interface VisitRow {
  id: string;
  siteId: string;
  siteName: string;
  gateName: string;
  unitId: string | null;
  unitName: string | null;
  status: VisitStatus;
  deniedReason: string | null;
  type: 'vehicle' | 'pedestrian';
  surname: string;
  names: string;
  registration: string | null;
  make: string | null;
  model: string | null;
  colour: string | null;
  pax: number | null;
  category: string;
  at: Date;
  respondBy: Date | null;
  asked: number;
  hasFace: boolean;
}

interface Contact {
  customerId: string;
  /** What the guard sees: never the number. */
  label: string;
  phone: string;
}

const VISIT_SELECT = `SELECT v.id, v.site_id AS "siteId", s.name AS "siteName", g.name AS "gateName", v.unit_id AS "unitId", u.name AS "unitName", v.status,
    v.denied_reason AS "deniedReason", v.type, p.surname, p.names, ve.registration, ve.make, ve.model, ve.colour, v.pax_in AS "pax", c.name AS "category",
    v.captured_at AS "at", v.respond_by AS "respondBy", v.asked, v.face_photo_key IS NOT NULL AS "hasFace"
  FROM visits v JOIN sites s ON s.id = v.site_id JOIN site_gates g ON g.id = v.gate_id JOIN visitor_people p ON p.id = v.person_id
  LEFT JOIN visitor_vehicles ve ON ve.id = v.vehicle_id LEFT JOIN site_units u ON u.id = v.unit_id JOIN visitor_categories c ON c.id = v.category_id`;

const ALREADY: Partial<Record<VisitStatus, string>> = {
  on_site: 'This visitor has already been let in.',
  denied: 'This visitor has already been refused.',
  denied_no_response: 'Nobody answered in time, so the visitor was turned away.',
};

type Actor = Pick<AuditEntry, 'actorType' | 'actorId' | 'actorLabel'>;

/**
 * The approval of a visit (visitor management, step 3). The customers of the unit are asked
 * in the customer app, and the first answer counts. If nobody answers before the site's wait
 * is over, the guard phones the unit and records how the call went. Every answer, call and
 * outcome is kept, and each ends in the audit trail.
 */
@Injectable()
export class VisitApprovalService {
  constructor(
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly setup: VisitorSetupService,
  ) {}

  async load(tx: Tx, visitId: string, lock = false): Promise<VisitRow | null> {
    return (await tx.query(`${VISIT_SELECT} WHERE v.id = $1${lock ? ' FOR UPDATE OF v' : ''}`, [visitId])).rows[0] ?? null;
  }

  /** The customers a visit is for: the people of the unit, or the client when the visitor is here for the office. */
  private async customers(tx: Tx, siteId: string, unitId: string | null) {
    return (
      await tx.query(
        `SELECT id, full_name AS name, phone, second_contact_name AS "secondName", second_contact_phone AS "secondPhone"
           FROM customers WHERE site_id = $1 AND active AND (($2::uuid IS NOT NULL AND unit_id = $2::uuid) OR ($2::uuid IS NULL AND kind = 'client'))
          ORDER BY created_at, id`,
        [siteId, unitId],
      )
    ).rows as { id: string; name: string; phone: string; secondName: string; secondPhone: string }[];
  }

  /**
   * The numbers the gate may phone: the unit's main number (its first person with a number) and,
   * where the site allows it, a second contact. The guard is shown the label only.
   */
  async contacts(tx: Tx, v: Pick<VisitRow, 'siteId' | 'unitId' | 'unitName'>): Promise<Partial<Record<CallContact, Contact>>> {
    const people = await this.customers(tx, v.siteId, v.unitId);
    const where = v.unitName ? `Unit ${v.unitName}` : 'The office';
    const main = people.find((p) => p.phone.trim());
    const out: Partial<Record<CallContact, Contact>> = {};
    if (main) out.primary = { customerId: main.id, label: where, phone: main.phone.trim() };
    if (!(await this.setup.settings(tx, v.siteId)).secondContact) return out;
    const withSecond = people.find((p) => p.secondPhone.trim());
    const other = people.find((p) => p.phone.trim() && p.id !== main?.id);
    if (withSecond) out.second = { customerId: withSecond.id, label: `${where}, second contact`, phone: withSecond.secondPhone.trim() };
    else if (other) out.second = { customerId: other.id, label: `${where}, second number`, phone: other.phone.trim() };
    return out;
  }

  /** Asks the customers of the unit to accept or refuse, and starts the wait. */
  async request(tx: Tx, visitId: string, note?: string): Promise<void> {
    const v = (await this.load(tx, visitId))!;
    const people = await this.customers(tx, v.siteId, v.unitId);
    const { noResponseSeconds } = await this.setup.settings(tx, v.siteId);
    // With nobody to ask, there is nothing to wait for: the gate may phone at once.
    await tx.query(`UPDATE visits SET approval_requested_at = now(), asked = $2, respond_by = now() + make_interval(secs => $3) WHERE id = $1`, [visitId, people.length, people.length ? noResponseSeconds : 0]);
    if (!people.length) return;
    const who = visitorName(v.surname, v.names);
    const how = v.type === 'pedestrian' ? 'On foot' : `${vehicleLine({ registration: v.registration ?? '', colour: v.colour, make: v.make, model: v.model })}${v.pax ? `, ${v.pax} passenger${v.pax === 1 ? '' : 's'}` : ''}`;
    await this.notifications.record(tx, {
      userIds: [],
      customerIds: people.map((p) => p.id),
      kind: 'visitor_request',
      title: `Visitor at ${v.gateName}`,
      body: `${who}. ${how}. ${note ? `${note} ` : ''}Open to accept or refuse.`,
      // The locked screen of a phone names nobody.
      lockScreen: 'A visitor is at the gate. Open On Par to answer.',
      url: `/c/visits/${v.id}`,
      siteId: v.siteId,
      entityType: 'visit',
      entityId: v.id,
    });
  }

  /** A visitor let in on a pass: the approval is recorded as such, and the unit's people are told who arrived. */
  async arrivedOnPass(tx: Tx, visitId: string, _passId: string, mismatch: string[]): Promise<void> {
    const v = (await this.load(tx, visitId))!;
    await tx.query(`INSERT INTO visit_approvals (company_id, visit_id, method, outcome) VALUES (app_company_id(), $1, 'pass', 'approved')`, [visitId]);
    const people = await this.customers(tx, v.siteId, v.unitId);
    if (!people.length) return;
    const who = visitorName(v.surname, v.names);
    const how = v.type === 'pedestrian' ? 'on foot' : `in ${vehicleLine({ registration: v.registration ?? '', colour: v.colour, make: v.make, model: v.model })}`;
    // One identifier matched and another did not: the visitor is let in and the customer told (spec: partial match).
    const odd = mismatch.length ? ` The ${mismatch.join(' and ')} did not match what you gave the gate.` : '';
    await this.notifications.record(tx, {
      userIds: [],
      customerIds: people.map((p) => p.id),
      kind: 'visitor_arrived',
      title: `Your visitor arrived at ${v.gateName}`,
      body: `${who} was let in, ${how}.${odd}`,
      lockScreen: 'A visitor you were expecting has arrived.',
      url: `/c/visits/${v.id}`,
      siteId: v.siteId,
      entityType: 'visit',
      entityId: v.id,
    });
  }

  /** Whether this customer is one of the people the visit is for. */
  isFor(v: Pick<VisitRow, 'siteId' | 'unitId'>, me: { siteId: string; unitId: string | null; customerKind: 'client' | 'tenant' }): boolean {
    if (v.siteId !== me.siteId) return false;
    return v.unitId ? v.unitId === me.unitId : me.customerKind === 'client';
  }

  /** A customer accepts or refuses in the app. The first answer counts. */
  async decideInApp(tx: Tx, me: { customerId: string; name: string; siteId: string; unitId: string | null; customerKind: 'client' | 'tenant' }, visitId: string, accept: boolean) {
    const v = await this.load(tx, visitId, true);
    if (!v || !this.isFor(v, me)) throw new NotFoundException('Visitor not found.');
    if (v.status !== 'awaiting_approval') throw new ConflictException(ALREADY[v.status] ?? 'This visitor has already been dealt with.');
    await this.close(tx, v, accept ? 'on_site' : 'denied', accept ? null : 'customer');
    await tx.query(`INSERT INTO visit_approvals (company_id, visit_id, method, outcome, customer_id) VALUES (app_company_id(), $1, 'push', $2, $3)`, [v.id, accept ? 'approved' : 'denied', me.customerId]);
    await this.audit.record(tx, { actorType: 'customer', actorId: me.customerId, actorLabel: me.name, action: accept ? 'visit.approve' : 'visit.deny', entityType: 'visit', entityId: v.id, after: { method: 'push' } });
    await this.tellOthers(tx, v, me.customerId, `${me.name} ${accept ? 'accepted' : 'refused'} ${visitorName(v.surname, v.names)}.`);
    return { status: accept ? 'on_site' : 'denied' };
  }

  /** The guard is about to phone: hands the phone the number (it is not shown to him) and records the call being made. */
  async dial(tx: Tx, guard: Actor & { deviceId: string | null }, visitId: string, siteId: string, contact: CallContact) {
    const v = await this.awaiting(tx, visitId, siteId);
    this.requireTimeUp(v);
    const c = (await this.contacts(tx, v))[contact];
    if (!c) throw new BadRequestException(contact === 'second' ? 'There is no second number for this unit.' : 'No phone number is set for this unit.');
    await this.audit.record(tx, { actorType: guard.actorType, actorId: guard.actorId, actorLabel: guard.actorLabel, action: 'visit.dial', entityType: 'visit', entityId: v.id, after: { contact, customerId: c.customerId, deviceId: guard.deviceId } });
    return { number: c.phone, label: c.label };
  }

  /** What the guard recorded after the call: approved, denied or no answer. */
  async callOutcome(tx: Tx, guard: Actor & { employeeId: string; deviceId: string | null }, visitId: string, siteId: string, input: { eventId: string; contact: CallContact; outcome: CallOutcome }) {
    if ((await tx.query('SELECT 1 FROM visit_approvals WHERE event_id = $1', [input.eventId])).rowCount) return;
    const v = await this.awaiting(tx, visitId, siteId);
    this.requireTimeUp(v);
    const c = (await this.contacts(tx, v))[input.contact];
    await tx.query(
      `INSERT INTO visit_approvals (company_id, visit_id, method, outcome, customer_id, contact, guard_id, device_id, event_id) VALUES (app_company_id(), $1, 'phone', $2, $3, $4, $5, $6, $7)`,
      [v.id, input.outcome, c?.customerId ?? null, input.contact, guard.employeeId, guard.deviceId, input.eventId],
    );
    await this.audit.record(tx, { actorType: guard.actorType, actorId: guard.actorId, actorLabel: guard.actorLabel, action: 'visit.call_outcome', entityType: 'visit', entityId: v.id, after: { contact: input.contact, outcome: input.outcome, deviceId: guard.deviceId } });
    if (input.outcome === 'no_answer') return;
    const approved = input.outcome === 'approved';
    await this.close(tx, v, approved ? 'on_site' : 'denied', approved ? null : 'phone');
    await this.tellOthers(tx, v, null, `${visitorName(v.surname, v.names)} was ${approved ? 'approved' : 'refused'} by phone at the gate.`);
  }

  /** Nobody could be reached: the visitor is turned away and the visit closed as "Denied, no response". */
  async noResponse(tx: Tx, guard: Actor & { employeeId: string; deviceId: string | null }, visitId: string, siteId: string, eventId: string) {
    if ((await tx.query('SELECT 1 FROM visit_approvals WHERE event_id = $1', [eventId])).rowCount) return;
    const v = await this.awaiting(tx, visitId, siteId);
    this.requireTimeUp(v);
    await tx.query(`INSERT INTO visit_approvals (company_id, visit_id, method, outcome, guard_id, device_id, event_id) VALUES (app_company_id(), $1, 'phone', 'no_response', $2, $3, $4)`, [v.id, guard.employeeId, guard.deviceId, eventId]);
    await this.close(tx, v, 'denied_no_response', 'no_response');
    await this.audit.record(tx, { actorType: guard.actorType, actorId: guard.actorId, actorLabel: guard.actorLabel, action: 'visit.no_response', entityType: 'visit', entityId: v.id, after: { deviceId: guard.deviceId } });
    await this.tellOthers(tx, v, null, `Nobody answered, so ${visitorName(v.surname, v.names)} was turned away.`);
  }

  /** Where a visit stands, for the gate phone's waiting screen. */
  async gateState(tx: Tx, visitId: string, siteId: string) {
    const v = await this.load(tx, visitId);
    if (!v || v.siteId !== siteId) throw new NotFoundException('Visitor not found.');
    const now = (await tx.query('SELECT now() AS now')).rows[0].now as Date;
    const answers = (
      await tx.query(
        `SELECT a.method, a.outcome, a.contact, c.full_name AS customer FROM visit_approvals a LEFT JOIN customers c ON c.id = a.customer_id WHERE a.visit_id = $1 ORDER BY a.at, a.id`,
        [visitId],
      )
    ).rows as { method: 'push' | 'phone' | 'pass'; outcome: string; contact: CallContact | null; customer: string | null }[];
    const final = [...answers].reverse().find((a) => a.outcome !== 'no_answer');
    const waiting = v.status === 'awaiting_approval';
    const secondsLeft = waiting && v.respondBy ? Math.max(0, Math.ceil((v.respondBy.getTime() - now.getTime()) / 1000)) : 0;
    const contacts = waiting ? await this.contacts(tx, v) : {};
    const tried = (c: CallContact) => answers.some((a) => a.method === 'phone' && a.contact === c);
    return {
      id: v.id,
      status: v.status,
      statusLabel: VISIT_STATUS_LABELS[v.status],
      visitor: visitorName(v.surname, v.names),
      vehicle: v.type === 'pedestrian' ? 'On foot' : vehicleLine({ registration: v.registration ?? '', colour: v.colour, make: v.make, model: v.model }),
      visiting: v.unitName ? `Unit ${v.unitName}` : 'The office',
      /** How many people were asked in the app. */
      asked: v.asked,
      secondsLeft,
      /** The wait is over (or there was nobody to ask): the guard may phone. */
      canDial: waiting && secondsLeft === 0,
      dial: {
        primary: contacts.primary ? { label: contacts.primary.label, tried: tried('primary') } : null,
        second: contacts.second ? { label: contacts.second.label, tried: tried('second') } : null,
      },
      /** How it ended, in the guard's words. */
      decided: !waiting && final ? (final.method === 'pass' ? `Expected by ${v.unitName ? `unit ${v.unitName}` : 'the office'}` : final.method === 'push' ? `${final.outcome === 'approved' ? 'Accepted' : 'Refused'} by ${final.customer ?? 'the customer'} in the app` : final.outcome === 'no_response' ? 'Nobody answered' : `${final.outcome === 'approved' ? 'Approved' : 'Denied'} by phone`) : null,
      blocked: v.deniedReason === 'barred' ? 'This visitor is on the barred list. Do not let them in. Your supervisor has been told.' : null,
    };
  }

  private async awaiting(tx: Tx, visitId: string, siteId: string): Promise<VisitRow> {
    const v = await this.load(tx, visitId, true);
    if (!v || v.siteId !== siteId) throw new NotFoundException('Visitor not found.');
    if (v.status !== 'awaiting_approval') throw new ConflictException(ALREADY[v.status] ?? 'This visitor has already been dealt with.');
    return v;
  }

  /** The gate phones only once the customers have had their time to answer in the app. */
  private requireTimeUp(v: VisitRow) {
    if (v.respondBy && v.respondBy.getTime() > Date.now() + 2000) throw new ConflictException('The customer still has time to answer in the app. Wait for the countdown to finish.');
  }

  private async close(tx: Tx, v: VisitRow, status: VisitStatus, deniedReason: string | null) {
    await tx.query(`UPDATE visits SET status = $2, denied_reason = $3, decided_at = now(), entry_at = CASE WHEN $2 = 'on_site' THEN now() ELSE entry_at END WHERE id = $1`, [v.id, status, deniedReason]);
  }

  /** Tells the unit's people how the request ended, so nobody is left looking at an open request. */
  private async tellOthers(tx: Tx, v: VisitRow, exceptCustomerId: string | null, body: string) {
    const ids = (await this.customers(tx, v.siteId, v.unitId)).map((p) => p.id).filter((id) => id !== exceptCustomerId);
    if (!ids.length) return;
    await this.notifications.record(tx, {
      userIds: [],
      customerIds: ids,
      kind: 'visitor_answered',
      title: 'Visitor answered',
      body,
      lockScreen: 'A visitor request was answered.',
      url: `/c/visits/${v.id}`,
      siteId: v.siteId,
      entityType: 'visit',
      entityId: v.id,
    });
  }
}
