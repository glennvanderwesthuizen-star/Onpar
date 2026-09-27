import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { CONFIG, Config } from '../config';

/**
 * Stores photos and certificates. Local disk for development; production will
 * swap this for encrypted S3 storage in the Cape Town region behind the same methods.
 */
@Injectable()
export class StorageService {
  private readonly root: string;

  constructor(@Inject(CONFIG) config: Config) {
    this.root = resolve(config.uploadDir);
  }

  async put(companyId: string, folder: string, data: Buffer, ext: string): Promise<string> {
    const key = `${companyId}/${folder}/${randomUUID()}${ext}`;
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return key;
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  private pathFor(key: string): string {
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + '/')) throw new Error('Invalid storage key');
    return path;
  }
}

export const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
export const CERTIFICATE_TYPES: Record<string, string> = { ...IMAGE_TYPES, 'application/pdf': '.pdf' };
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
