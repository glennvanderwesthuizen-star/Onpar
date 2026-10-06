import { Injectable } from '@nestjs/common';
import { Tx } from '../db/db.service';
import type { UserPrincipal } from '../common/auth';

export interface AuditEntry {
  actorType: 'user' | 'employee' | 'device' | 'system' | 'customer';
  actorId?: string | null;
  actorLabel?: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** Fields never copied into the audit log. */
const REDACT = new Set(['password_hash', 'pin_hash', 'id_number_enc', 'id_number_hmac', 'token_hash', 'idNumber', 'pin', 'password']);

function redact(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !REDACT.has(k))
        .map(([k, v]) => [k, redact(v)]),
    );
  }
  return value;
}

@Injectable()
export class AuditService {
  /** Writes one entry in the caller's transaction, so it commits or rolls back with the change. */
  async record(tx: Tx, e: AuditEntry): Promise<void> {
    await tx.query(
      `INSERT INTO audit_log (company_id, actor_type, actor_id, actor_label, action, entity_type, entity_id, before, after, reason)
       VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        e.actorType,
        e.actorId ?? null,
        e.actorLabel ?? '',
        e.action,
        e.entityType,
        e.entityId ?? null,
        e.before === undefined ? null : JSON.stringify(redact(e.before)),
        e.after === undefined ? null : JSON.stringify(redact(e.after)),
        e.reason ?? null,
      ],
    );
  }

  /** By whoever is signed in: a member of staff or a customer. */
  byAccount(tx: Tx, who: UserPrincipal | { kind: 'customer'; customerId: string; name: string }, e: Omit<AuditEntry, 'actorType' | 'actorId' | 'actorLabel'>) {
    return who.kind === 'customer'
      ? this.record(tx, { ...e, actorType: 'customer', actorId: who.customerId, actorLabel: who.name })
      : this.byUser(tx, who, e);
  }

  byUser(tx: Tx, user: UserPrincipal, e: Omit<AuditEntry, 'actorType' | 'actorId' | 'actorLabel'>) {
    return this.record(tx, { ...e, actorType: 'user', actorId: user.userId, actorLabel: user.name });
  }
}
