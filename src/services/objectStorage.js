import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config/index.js';

/**
 * Every stored file of the app, addressed by a key, kept either on this server's disk
 * (under UPLOAD_DIR) or in an S3 bucket, chosen by STORAGE_DRIVER:
 *   attachments/<ab>/<key>     chat photos, videos, voice notes, documents, stickers, GIFs, previews
 *   avatars/<name>             profile and group photos
 *   wallpapers/<name>          chat wallpapers
 *   recordings/<yyyy>/<mm>/…   call recordings
 * The keys are the same on disk and in S3, so the local layout is unchanged.
 * Every driver offers:
 *   put(key, filePath, contentType)     store a finished local file (the file is moved/removed)
 *   putBuffer(key, buffer, contentType) store bytes held in memory
 *   stat(key)                           { size }; a missing file throws { code: 'ENOENT' }
 *   read(key, { start, end })           a readable stream of the whole file or a byte range (end inclusive)
 *   remove(key)                         delete; a missing file is not an error
 */
const KEY_PATTERN = /^[a-z0-9]+(?:[/_.-][a-z0-9]+)*$/;

function checkKey(key) {
  if (typeof key !== 'string' || key.length > 500 || !KEY_PATTERN.test(key)) throw new Error('Invalid storage key');
  return key;
}

const notFound = () => Object.assign(new Error('Stored file not found'), { code: 'ENOENT' });

export function createLocalStorage(root) {
  const pathFor = (key) => path.join(root, ...checkKey(key).split('/'));
  return {
    name: 'local',
    async put(key, filePath) {
      const target = pathFor(key); // validates the key before touching any file
      await fsp.mkdir(path.dirname(target), { recursive: true });
      try {
        await fsp.rename(filePath, target);
      } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        await fsp.copyFile(filePath, target); // temp folder on another disk
        await fsp.unlink(filePath);
      }
    },
    async putBuffer(key, buffer) {
      const target = pathFor(key);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, buffer);
    },
    async stat(key) {
      try {
        return { size: (await fsp.stat(pathFor(key))).size };
      } catch (error) {
        if (error.code === 'ENOENT') throw notFound();
        throw error;
      }
    },
    async read(key, range) {
      const file = pathFor(key);
      await fsp.access(file).catch(() => {
        throw notFound();
      });
      return fs.createReadStream(file, range ? { start: range.start, end: range.end } : {});
    },
    async remove(key) {
      await fsp.unlink(pathFor(key)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    },
  };
}

/** `client` is an S3Client (injected in tests). Objects are private and encrypted at rest (SSE-S3). */
export function createS3Storage({ bucket, prefix = '', client }) {
  const objectKey = (key) => `${prefix}${checkKey(key)}`;
  return {
    name: 's3',
    async put(key, filePath, contentType) {
      const Key = objectKey(key);
      const { size } = await fsp.stat(filePath);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key,
          Body: fs.createReadStream(filePath),
          ContentLength: size, // a single PUT takes up to 5 GB; recordings are capped far below
          ContentType: contentType,
          ServerSideEncryption: 'AES256',
        }),
      );
      await fsp.unlink(filePath).catch(() => {});
    },
    async putBuffer(key, buffer, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: objectKey(key), Body: buffer, ContentLength: buffer.length, ContentType: contentType, ServerSideEncryption: 'AES256' }),
      );
    },
    async stat(key) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey(key) }));
        return { size: Number(head.ContentLength) };
      } catch (error) {
        if (error.name === 'NotFound' || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) throw notFound();
        throw error;
      }
    },
    async read(key, range) {
      try {
        const result = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: objectKey(key), Range: range ? `bytes=${range.start}-${range.end}` : undefined }),
        );
        return result.Body;
      } catch (error) {
        if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) throw notFound();
        throw error;
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(key) }));
    },
  };
}

const drivers = new Map();
let currentName = config.storage.driver;

export const objectStorage = {
  /** The driver new files go to. */
  get current() {
    return this.driver(currentName);
  },

  /** A driver by name; files stored earlier keep the driver they were written with. */
  driver(name) {
    if (!drivers.has(name)) {
      if (name === 'local') drivers.set(name, createLocalStorage(config.uploads.dir));
      else if (name === 's3') {
        const { bucket, region, prefix, endpoint, forcePathStyle } = config.storage.s3;
        if (!bucket) throw new Error('S3 storage is not configured (S3_BUCKET)');
        // Credentials come from the EC2 instance role (or the standard AWS_* variables).
        drivers.set(name, createS3Storage({ bucket, prefix, client: new S3Client({ region, endpoint, forcePathStyle }) }));
      } else throw new Error(`Unknown storage driver "${name}"`);
    }
    return drivers.get(name);
  },

  /**
   * Where a file is: the current driver, or, after switching from disk to S3, the disk
   * (files stored before the switch keep working). Returns { storage, size }.
   */
  async locate(key) {
    try {
      return { storage: this.current, size: (await this.current.stat(key)).size };
    } catch (error) {
      if (error.code !== 'ENOENT' || currentName === 'local') throw error;
      const local = this.driver('local');
      return { storage: local, size: (await local.stat(key)).size };
    }
  },

  /** Delete a file wherever it is (current driver, and the disk for files from before a switch). */
  async removeEverywhere(key) {
    await this.current.remove(key);
    if (currentName !== 'local') await this.driver('local').remove(key);
  },

  /** Tests: remember the drivers in use, to put them back with restore(). */
  snapshot: () => ({ currentName, drivers: new Map(drivers) }),
  restore(state) {
    drivers.clear();
    for (const [name, storage] of state.drivers) drivers.set(name, storage);
    currentName = state.currentName;
  },

  /** Tests: use `storage` for driver `name` (and, with `current`, store new files there). */
  useDriver(name, storage, { current = false } = {}) {
    if (storage) drivers.set(name, storage);
    else drivers.delete(name);
    if (current) currentName = name;
  },
};
