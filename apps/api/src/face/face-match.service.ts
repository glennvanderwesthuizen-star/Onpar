import { Injectable, Logger } from '@nestjs/common';
import { faceVerdict, FaceCheckKind } from '@onpar/rules';
import { DbService, Tx } from '../db/db.service';
import { StorageService } from '../storage/storage.service';
import { FACE_MODEL, FaceEngine } from './face-engine';

/**
 * Runs the automatic face checks (D-36 stage 2) when a company has switched them on:
 * at enrolment (face photo against the ID document and the PSIRA card) and for every Duty On
 * and Duty From selfie (against the enrolment photo). Runs in the background after the request,
 * so a slow or failed check never holds up a guard. Only the result is stored.
 */
@Injectable()
export class FaceMatchService {
  private readonly log = new Logger('Faces');
  private pending = new Set<Promise<unknown>>();

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
  ) {}

  async enabled(tx: Tx): Promise<boolean> {
    const r = (await tx.query('SELECT face_matching FROM retention_settings')).rows[0];
    return !!r?.face_matching;
  }

  /** Background: the enrolment checks for one guard. */
  afterEnrolment(companyId: string, employeeId: string) {
    this.background(async () => {
      const photos = await this.db.withTenant(companyId, async (tx) => {
        if (!(await this.enabled(tx))) return null;
        return (await tx.query('SELECT kind, storage_key FROM employee_photos WHERE employee_id = $1', [employeeId])).rows as { kind: string; storage_key: string }[];
      });
      if (!photos) return;
      const key = (k: string) => photos.find((p) => p.kind === k)?.storage_key;
      const face = key('face');
      if (!face) return;
      const faceBuf = await this.storage.get(face);
      for (const [kind, other] of [
        ['enrolment_id_document', key('id_document')],
        ['enrolment_psira_card', key('psira_card')],
      ] as [FaceCheckKind, string | undefined][]) {
        if (!other) continue;
        const r = await FaceEngine.compare(faceBuf, await this.storage.get(other));
        await this.save(companyId, employeeId, kind, null, r);
      }
    });
  }

  /** Background: the selfie check for one declaration. */
  afterSelfie(companyId: string, declarationId: string) {
    this.background(async () => {
      const row = await this.db.withTenant(companyId, async (tx) => {
        if (!(await this.enabled(tx))) return null;
        return (
          await tx.query(
            `SELECT d.employee_id, d.selfie_key, p.storage_key AS face_key
               FROM declarations d JOIN employee_photos p ON p.employee_id = d.employee_id AND p.kind = 'face'
              WHERE d.id = $1 AND d.selfie_key IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM face_matches f WHERE f.declaration_id = d.id)`,
            [declarationId],
          )
        ).rows[0];
      });
      if (!row) return;
      const r = await FaceEngine.compare(await this.storage.get(row.face_key), await this.storage.get(row.selfie_key));
      await this.save(companyId, row.employee_id, 'duty_selfie', declarationId, r);
    });
  }

  /** Waits for checks still running (tests, and a tidy shutdown). */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private async save(companyId: string, employeeId: string, kind: FaceCheckKind, declarationId: string | null, r: { distance: number | null; facesA: number; facesB: number }) {
    await this.db.withTenant(companyId, (tx) =>
      tx.query(
        `INSERT INTO face_matches (company_id, employee_id, kind, declaration_id, distance, verdict, faces_found, model)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7)`,
        [employeeId, kind, declarationId, r.distance == null ? null : r.distance.toFixed(4), faceVerdict(r.distance), JSON.stringify({ first: r.facesA, second: r.facesB }), FACE_MODEL],
      ),
    );
  }

  private background(job: () => Promise<void>) {
    const p = job().catch((e) => this.log.error(`Face check failed: ${(e as Error).message}`));
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
  }
}
