import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { CurrentGuard, GuardAuthGuard, GuardPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DutyService, Upload } from '../attendance/duty.service';
import { MAX_UPLOAD_BYTES } from '../storage/storage.service';
import { PinService } from './pin.service';
import { DbService } from '../db/db.service';
import { RosterService } from '../roster/roster.service';
import { sastDate } from '@onpar/rules';

const isoTime = z.string().datetime({ offset: true, message: 'Send times in ISO 8601 format.' }).transform((s) => new Date(s));

const DutyBody = z.object({
  eventId: z.string().uuid(),
  kind: z.enum(['duty_on', 'duty_from']),
  pin: z.string().regex(/^\d{4,6}$/, 'Your PIN is 4 to 6 digits.'),
  trustedAt: isoTime,
  deviceClock: isoTime,
});

const DeclarationBody = z.object({
  eventId: z.string().uuid(),
  dutyEventId: z.string().uuid(),
  accepted: z.array(z.boolean()),
  comment: z.string().max(2000).default(''),
  raiseEquipmentReport: z.boolean().default(false),
  /** The priority the guard picks when raising the comment as an equipment report. */
  equipmentReportPriority: z.enum(['green', 'amber', 'red']).default('green'),
  trustedAt: isoTime,
  deviceClock: isoTime,
  selfieToFollow: z.boolean().default(false),
  liveness: z.enum(['passed', 'not_passed']).nullable().default(null),
});

/**
 * What a signed-in guard does on the post device. Every call carries a unique
 * event ID made on the device, so the offline outbox can retry safely.
 */
@Controller('device')
@UseGuards(GuardAuthGuard)
export class GuardController {
  constructor(
    private readonly duty: DutyService,
    private readonly pins: PinService,
    private readonly db: DbService,
    private readonly roster: RosterService,
  ) {}

  @Get('me')
  me(@CurrentGuard() guard: GuardPrincipal) {
    return this.duty.guardState(guard);
  }

  /** My roster: today and the working days of the next four weeks (section 40). */
  @Get('roster')
  myRoster(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, (tx) => this.roster.guardRoster(tx, guard.employeeId, sastDate(new Date()), 28));
  }

  /** Duty On or Duty From. The PIN is required again (section 6.1). */
  @Post('duty')
  @HttpCode(200)
  async recordDuty(@CurrentGuard() guard: GuardPrincipal, @Body() body: unknown) {
    const input = parseBody(DutyBody, body);
    await this.pins.check(guard.companyId, { employeeId: guard.employeeId }, input.pin, guard.deviceId, null);
    return this.duty.recordDuty(guard, input);
  }

  /** "Let my partner go first" at shift change (D-33). Needs the guard's PIN. */
  @Post('relief/give-turn')
  @HttpCode(200)
  async giveTurn(@CurrentGuard() guard: GuardPrincipal, @Body() body: unknown) {
    const { pin } = parseBody(z.object({ pin: z.string().regex(/^\d{4,6}$/, 'Your PIN is 4 to 6 digits.') }), body);
    await this.pins.check(guard.companyId, { employeeId: guard.employeeId }, pin, guard.deviceId, null);
    return this.duty.giveTurn(guard);
  }

  /**
   * The declaration after Duty On or Duty From. JSON, or multipart with the
   * fields in `data` and the photo in `selfie`. When offline, the text may be
   * sent first with `selfieToFollow` and the photo later.
   */
  @Post('declarations')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('selfie', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  declaration(@CurrentGuard() guard: GuardPrincipal, @Body() body: Record<string, unknown>, @UploadedFile() selfie?: Upload) {
    let json: unknown = body;
    if (typeof body?.data === 'string') {
      try {
        json = JSON.parse(body.data);
      } catch {
        throw new BadRequestException('The declaration data could not be read.');
      }
    }
    return this.duty.recordDeclaration(guard, parseBody(DeclarationBody, json), selfie);
  }

  @Post('declarations/:id/selfie')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('selfie', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  selfie(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() selfie?: Upload) {
    if (!selfie) throw new BadRequestException('Attach the selfie.');
    return this.duty.attachSelfie(guard, id, selfie);
  }
}
