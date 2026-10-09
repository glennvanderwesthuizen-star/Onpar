import { BadRequestException, GoneException, Inject, Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CONFIG, Config } from '../config';
import { onRollback } from '../common/tx-files';

/** Where the encrypted bytes live: the server's disk in development, S3 in production. */
export interface StorageDriver {
  write(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

export class LocalDriver implements StorageDriver {
  private readonly root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }
  async write(key: string, data: Buffer) {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
  read(key: string) {
    return readFile(this.pathFor(key));
  }
  async remove(key: string) {
    await unlink(this.pathFor(key)).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
  private pathFor(key: string): string {
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + '/')) throw new Error('Invalid storage key');
    return path;
  }
}

/** Amazon S3 (Cape Town region for POPIA), with the bucket's own server-side encryption on top. */
export class S3Driver implements StorageDriver {
  constructor(
    private readonly client: Pick<S3Client, 'send'>,
    private readonly bucket: string,
    private readonly kmsKeyId?: string,
  ) {}
  async write(key: string, data: Buffer) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: 'application/octet-stream',
        ...(this.kmsKeyId ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.kmsKeyId } : { ServerSideEncryption: 'AES256' }),
      }),
    );
  }
  async read(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** Files written by On Par start with this marker, then the IV, the tag and the encrypted bytes. */
const MAGIC = Buffer.from('OPF1');

/** What the first bytes of each allowed file type must be, so a renamed file cannot pass as a photo. */
const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  '.jpg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  '.pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  // BOLO voice notes and videos: MP4/M4A/3GP share the ISO "ftyp" box; the others by their own headers.
  '.mp4': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
  '.m4a': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
  '.3gp': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
  '.webm': (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
  '.ogg': (b) => b.subarray(0, 4).toString('latin1') === 'OggS',
  '.mp3': (b) => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  '.aac': (b) => b[0] === 0xff && (b[1] & 0xf6) === 0xf0,
};

export function matchesType(data: Buffer, ext: string): boolean {
  return !!SIGNATURES[ext]?.(data);
}

/**
 * Stores photos and certificates, encrypted with AES-256-GCM before they leave
 * the application, so neither the disk nor the bucket ever holds a readable copy.
 */
@Injectable()
export class StorageService {
  private readonly key: Buffer;
  private driver: StorageDriver;

  constructor(@Inject(CONFIG) config: Config) {
    this.key = Buffer.from(hkdfSync('sha256', config.dataKey, Buffer.alloc(0), 'onpar-files', 32));
    this.driver =
      config.storage?.driver === 's3'
        ? new S3Driver(new S3Client({ region: config.storage.region }), config.storage.bucket, config.storage.kmsKeyId)
        : new LocalDriver(config.uploadDir);
  }

  /** Replaces the driver (used by tests). */
  useDriver(driver: StorageDriver) {
    this.driver = driver;
  }

  async put(companyId: string, folder: string, data: Buffer, ext: string): Promise<string> {
    if (!matchesType(data, ext)) throw new BadRequestException('This file is not the kind it claims to be. Please choose the original file.');
    const key = `${companyId}/${folder}/${randomUUID()}${ext}`;
    const stored = KEEP_ORIGINAL.test(folder) ? data : await shrinkImage(data, ext);
    await this.driver.write(key, this.seal(stored));
    // Inside a database step: removed again if that step fails.
    onRollback(() => this.remove(key));
    return key;
  }

  async get(key: string): Promise<Buffer> {
    let raw: Buffer;
    try {
      raw = await this.driver.read(key);
    } catch (e) {
      const err = e as { code?: string; name?: string };
      if (err.code === 'ENOENT' || err.name === 'NoSuchKey') throw new GoneException('This photo is no longer kept (removed under the retention policy). The record itself is kept.');
      throw e;
    }
    // Files stored before encryption was added (development only) are returned as they are.
    return raw.subarray(0, 4).equals(MAGIC) ? this.open(raw) : raw;
  }

  /**
   * Runs work that stores files and writes the database together. If the work
   * fails (so the database rolls back), the files it stored are removed again.
   */
  async together<T>(work: (put: StorageService['put']) => Promise<T>): Promise<T> {
    const stored: string[] = [];
    const put: StorageService['put'] = async (...args) => {
      const key = await this.put(...args);
      stored.push(key);
      return key;
    };
    try {
      return await work(put);
    } catch (e) {
      await Promise.all(stored.map((k) => this.remove(k).catch(() => undefined)));
      throw e;
    }
  }

  remove(key: string): Promise<void> {
    return this.driver.remove(key);
  }

  private seal(data: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
  }

  private open(blob: Buffer): Buffer {
    const decipher = createDecipheriv('aes-256-gcm', this.key, blob.subarray(4, 16));
    decipher.setAuthTag(blob.subarray(16, 32));
    return Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]);
  }
}

/**
 * HR notices and disciplinary files are kept exactly as uploaded: they may be evidence (owner's
 * decision left to us, 9 Oct 2026). Every other photo is made smaller when it is large.
 */
export const KEEP_ORIGINAL = /^(discipline|notices|hr)(\/|$)/;
/** The longest side a stored photo keeps; readable on any screen, a fraction of a camera photo. */
export const MAX_IMAGE_SIDE = 1600;
const shrinkLog = new Logger('Photos');

/**
 * A photo larger than 1600 pixels, or carrying hidden details such as where it was taken, is
 * stored at most 1600 pixels on its longest side, in the same format, upright, with those details
 * removed. Phone photos are already small and are stored as they are. If anything goes wrong the
 * original is kept: an upload never fails because of this.
 */
export async function shrinkImage(data: Buffer, ext: string): Promise<Buffer> {
  if (!['.jpg', '.png', '.webp'].includes(ext)) return data;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sharp = require('sharp');
    const meta = await sharp(data).metadata();
    const big = Math.max(meta.width ?? 0, meta.height ?? 0) > MAX_IMAGE_SIDE;
    if (!big && !meta.exif) return data;
    let img = sharp(data).rotate().resize({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE, fit: 'inside', withoutEnlargement: true });
    img = ext === '.jpg' ? img.jpeg({ quality: 82, mozjpeg: true }) : ext === '.png' ? img.png({ compressionLevel: 9 }) : img.webp({ quality: 80 });
    return await img.toBuffer();
  } catch (e) {
    shrinkLog.warn(`Kept a photo at its original size: ${(e as Error).message}`);
    return data;
  }
}

export const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
export const CERTIFICATE_TYPES: Record<string, string> = { ...IMAGE_TYPES, 'application/pdf': '.pdf' };
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** BOLO voice notes and short videos (up to 30 seconds). */
export const AUDIO_TYPES: Record<string, string> = { 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/webm': '.webm', 'audio/3gpp': '.3gp' };
export const VIDEO_TYPES: Record<string, string> = { 'video/mp4': '.mp4', 'video/3gpp': '.3gp', 'video/webm': '.webm' };
export const MAX_VIDEO_BYTES = 40 * 1024 * 1024;
