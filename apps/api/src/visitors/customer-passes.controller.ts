import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PASS_KINDS } from '@onpar/rules';
import { CurrentCustomer, CustomerAuthGuard, CustomerPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService } from '../db/db.service';
import { VisitPassService } from './visit-pass.service';

const text = (max: number) => z.string().trim().max(max).default('');
const optional = z.string().trim().nullable().default(null).transform((v) => v || null);
const PassBody = z.object({
  kind: z.enum(PASS_KINDS, { message: 'Choose one visit or a regular.' }),
  visitorName: text(120),
  categoryId: z.string().uuid('Choose the kind of visitor.'),
  gateId: z.string().uuid().nullable().default(null),
  idNumber: text(40),
  cell: text(40),
  registration: text(40),
  visitDate: optional,
  time: optional,
  days: z.array(z.number()).max(7).default([]),
  hoursFrom: optional,
  hoursTo: optional,
  startDate: optional,
  endDate: optional,
});

/**
 * Announced visitors in the customer app (visitor management, step 4): the client and the
 * tenants of a site tell the gate who is coming, for one visit or as a regular, and take
 * someone off the list again. A customer sees and changes only their own unit's list.
 */
@Controller('customer')
@UseGuards(CustomerAuthGuard)
export class CustomerPassesController {
  constructor(
    private readonly db: DbService,
    private readonly passes: VisitPassService,
  ) {}

  @Get('passes')
  list(@CurrentCustomer() me: CustomerPrincipal) {
    return this.db.withTenant(me.companyId, async (tx) => ({ ...(await this.passes.list(tx, me)), ...(await this.passes.options(tx, me)) }));
  }

  @Post('passes')
  create(@CurrentCustomer() me: CustomerPrincipal, @Body() body: unknown) {
    const b = parseBody(PassBody, body);
    return this.db.withTenant(me.companyId, (tx) => this.passes.create(tx, me, b));
  }

  /** Takes a visitor off the list: the gate asks again next time. The record is kept. */
  @Post('passes/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentCustomer() me: CustomerPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(me.companyId, (tx) => this.passes.cancel(tx, me, id));
  }

  /** "Let this visitor in next time", from a visitor already let in. The ID number and number plate are taken from that visit. */
  @Post('visits/:id/pass')
  fromVisit(@CurrentCustomer() me: CustomerPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(PassBody, body);
    return this.db.withTenant(me.companyId, (tx) => this.passes.createFromVisit(tx, me, id, b));
  }
}
