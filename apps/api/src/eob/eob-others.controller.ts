import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Post, Query, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { EOB_BANNER, EobCategory, eobEntryError, reconcileTime } from '@onpar/rules';
import { z } from 'zod';
import { CurrentCustomer, CurrentGuard, CustomerAuthGuard, CustomerPrincipal, GuardAuthGuard, GuardPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { eobEntries } from './eob.controller';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isoTime = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const GuardEntry = z.object({ eventId: z.string().uuid(), text: z.string(), trustedAt: isoTime, deviceClock: isoTime });

/**
 * Guards write in the Occurrence Book from the post phone (owner, 9 Oct 2026, D-51). The time is
 * the phone's trusted time, so an entry written with no signal keeps the moment it was written.
 */
@Controller('device/occurrence-book')
@UseGuards(GuardAuthGuard)
export class GuardEobController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(200)
  write(@CurrentGuard() guard: GuardPrincipal, @Body() body: unknown) {
    const b = parseBody(GuardEntry, body);
    const problem = eobEntryError(b.text);
    if (problem) throw new BadRequestException({ message: problem, errors: { text: problem } });
    const time = reconcileTime(b.trustedAt, b.deviceClock, new Date());
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    if (!guard.siteId) throw new BadRequestException('This phone is not at a site.');
    return this.db.withTenant(guard.companyId, async (tx) => {
      const done = (await tx.query('SELECT id FROM ob_entries WHERE event_id = $1', [b.eventId])).rows[0];
      if (done) return { id: done.id as string };
      const id = (
        await tx.query(
          `INSERT INTO ob_entries (company_id, site_id, occurred_at, text, written_by_employee, device_id, event_id, late_synced) VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [guard.siteId, time.officialAt, b.text.trim(), guard.employeeId, guard.deviceId, b.eventId, time.lateSynced],
        )
      ).rows[0].id as string;
      await this.audit.record(tx, { actorType: 'employee', actorId: guard.employeeId, actorLabel: 'Guard', action: 'eob.write', entityType: 'ob_entry', entityId: id, after: { deviceId: guard.deviceId } });
      return { id };
    });
  }
}

/**
 * The client of a site (the estate manager) reads the book in the customer app (owner, 9 Oct 2026,
 * D-51: "transparency is there"). Read only, without photos; tenants do not see it.
 */
@Controller('customer/occurrence-book')
@UseGuards(CustomerAuthGuard)
export class CustomerEobController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  book(@CurrentCustomer() me: CustomerPrincipal, @Query('date') date?: string) {
    if (me.customerKind !== 'client') throw new ForbiddenException('The Occurrence Book is for the client of the site.');
    return this.db.withTenant(me.companyId, async (tx) => {
      const day = date && DAY.test(date) ? date : ((await tx.query(`SELECT to_char(now() AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS d`)).rows[0].d as string);
      const entries = (await eobEntries(tx, me.siteId, day)).map((e) => ({ ...e, photo: null }));
      const counts: Partial<Record<EobCategory, number>> = {};
      for (const e of entries) counts[e.category] = (counts[e.category] ?? 0) + 1;
      await this.audit.record(tx, { actorType: 'customer', actorId: me.customerId, actorLabel: me.name, action: 'eob.client_view', entityType: 'site', entityId: me.siteId, after: { day } });
      const site = (await tx.query('SELECT name FROM sites WHERE id = $1', [me.siteId])).rows[0]?.name as string;
      return { site, date: day, banner: EOB_BANNER, entries, counts };
    });
  }
}
