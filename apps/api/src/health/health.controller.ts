import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG, Config } from '../config';
import { DbService } from '../db/db.service';

/** Above this the disk is reported as a problem, so the outside monitor alerts the owner. */
export const DISK_ALERT_PERCENT = 85;
/** The nightly backup runs at 02:15; older than this means last night's failed. */
export const BACKUP_ALERT_HOURS = 30;

/**
 * What the outside monitor checks every minute (optimisation review, phase 0). It answers 503 when
 * something needs the owner: the database is down, the disk is nearly full, or last night's
 * backup did not happen. It names the problem and nothing else, as it is open to the internet.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DbService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /** Is it running? Used by the server's own start-up checks; a new server has no backup yet. */
  @Get()
  async health(@Res({ passthrough: true }) res: Response) {
    const problems = await this.database();
    if (problems.length) res.status(503);
    return { ok: problems.length === 0, problems };
  }

  /** The full check for the outside monitor (UptimeRobot): the database, the disk and last night's backup. */
  @Get('monitor')
  async monitor(@Res({ passthrough: true }) res: Response) {
    const problems = await this.database();
    try {
      const s = await statfs(this.config.uploadDir);
      // The same sum as `df`: space used out of the space this server may use.
      const usedBlocks = Number(s.blocks) - Number(s.bfree);
      const used = Math.round((usedBlocks / (usedBlocks + Number(s.bavail))) * 100);
      if (used >= DISK_ALERT_PERCENT) problems.push(`disk ${used}% full`);
    } catch {
      // No upload folder yet (a fresh install): nothing to report.
    }
    const backups = process.env.BACKUP_DIR;
    if (backups) {
      const newest = await newestBackup(backups);
      if (newest === null) problems.push('no backup found');
      else if (Date.now() - newest > BACKUP_ALERT_HOURS * 3600_000) problems.push(`last backup ${Math.round((Date.now() - newest) / 3600_000)} hours ago`);
    }
    if (problems.length) res.status(503);
    return { ok: problems.length === 0, problems };
  }

  private async database(): Promise<string[]> {
    try {
      await this.db.query('SELECT 1');
      return [];
    } catch {
      return ['database not answering'];
    }
  }
}

async function newestBackup(dir: string): Promise<number | null> {
  try {
    const names = (await readdir(dir)).filter((n) => n.startsWith('onpar-') && n.endsWith('.tar.enc'));
    if (!names.length) return null;
    const times = await Promise.all(names.map(async (n) => (await stat(join(dir, n))).mtimeMs));
    return Math.max(...times);
  } catch {
    return null;
  }
}
