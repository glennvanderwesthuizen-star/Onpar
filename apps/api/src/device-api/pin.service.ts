import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { verifySecret } from '../common/crypto';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';

/** Five wrong PINs lock the account until a supervisor resets it (section 6.1). */
export const PIN_LOCKOUT_ATTEMPTS = 5;

export interface PinEmployee {
  id: string;
  name: string;
  employeeNumber: string;
  tsfNumber: string | null;
}

/**
 * Checks a guard's PIN with the lockout rule. Used at login and again at
 * Duty On and Duty From. Throws 401 for a wrong PIN and 423 when locked.
 */
@Injectable()
export class PinService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async check(
    companyId: string,
    who: { employeeNumber: string } | { employeeId: string } | { tsfNumber: string },
    pin: string,
    deviceId: string,
    successAction: string | null,
  ): Promise<PinEmployee> {
    const [column, value] =
      'employeeId' in who
        ? ['id', who.employeeId]
        : 'tsfNumber' in who
          ? ['tsf_number', who.tsfNumber]
          : ['employee_number', who.employeeNumber];
    const e = await this.db.withTenant(companyId, async (tx) => {
      return (
        await tx.query(
          `SELECT id, full_name, employee_number, tsf_number, pin_hash, pin_locked_at, status FROM employees WHERE ${column} = $1`,
          [value],
        )
      ).rows[0];
    });
    const deny = () => new UnauthorizedException('employeeId' in who ? 'That PIN is incorrect.' : 'ID card or PIN is incorrect.');
    if (!e || e.status !== 'active' || !e.pin_hash) throw deny();
    if (e.pin_locked_at) throw locked();

    const ok = await verifySecret(e.pin_hash, pin);
    const actor = { actorType: 'employee' as const, actorId: e.id, actorLabel: e.full_name };

    const result = await this.db.withTenant(companyId, async (tx) => {
      if (ok) {
        // Only succeeds if nobody locked the account since it was read.
        const r = await tx.query('UPDATE employees SET pin_failed_attempts = 0 WHERE id = $1 AND pin_locked_at IS NULL', [e.id]);
        if (!r.rowCount) return 'locked' as const;
        if (successAction) await this.audit.record(tx, { ...actor, action: successAction, entityType: 'device', entityId: deviceId });
        return 'ok' as const;
      }
      // Increment atomically so parallel attempts cannot slip past the limit.
      const r = (
        await tx.query(
          `UPDATE employees SET pin_failed_attempts = pin_failed_attempts + 1,
                  pin_locked_at = CASE WHEN pin_failed_attempts + 1 >= $2 THEN now() ELSE pin_locked_at END
            WHERE id = $1 RETURNING pin_failed_attempts, pin_locked_at`,
          [e.id, PIN_LOCKOUT_ATTEMPTS],
        )
      ).rows[0];
      await this.audit.record(tx, {
        ...actor,
        action: r.pin_locked_at ? 'guard.locked_out' : 'guard.login_failed',
        entityType: 'device',
        entityId: deviceId,
        after: { failedAttempts: r.pin_failed_attempts },
      });
      return r.pin_locked_at ? ('locked' as const) : ('wrong' as const);
    });

    if (result === 'locked') throw locked();
    if (result === 'wrong') throw deny();
    return { id: e.id, name: e.full_name, employeeNumber: e.employee_number, tsfNumber: e.tsf_number };
  }
}

function locked() {
  return new HttpException('Too many wrong PINs. Your account is locked. Ask your supervisor to reset it.', HttpStatus.LOCKED);
}
