import { join } from 'node:path';
import { promises as fsPromises } from 'fs';

export interface DbIdentity {
  device: number;
  inode: number;
  size: number;
  mtime: number;
  birthtime: number;
}

export interface IdentityResult {
  matched: boolean;
  mismatchType?: string;
  details?: string;
}

class DBIdentityService {
  private store = new Map<string, DbIdentity>();

  async captureIdentity(dbPath: string): Promise<DbIdentity> {
    const stats = await fsPromises.stat(dbPath);
    const identity: DbIdentity = {
      device: stats.dev,
      inode: stats.ino,
      size: stats.size,
      mtime: stats.mtimeMs,
      birthtime: stats.birthtimeMs,
    };
    this.store.set(dbPath, identity);
    return identity;
  }

  async verifyIdentity(dbPath: string): Promise<IdentityResult> {
    const stored = this.store.get(dbPath);
    if (!stored) {
      return { matched: false, mismatchType: 'unknown', details: 'No stored identity' };
    }
    const stats = await fsPromises.stat(dbPath);
    // Detect an unlink+recreate at the same path. Comparing only (device, inode)
    // is not portable: Linux ext4 reuses a freed inode for the next file, so a
    // replacement keeps the same inode and would go undetected. birthtime
    // (creation time) changes on recreate but not on in-place writes, so it
    // catches the swap without false-positiving on a DB that legitimately grows.
    // It is purely additive — on a filesystem that does not report birthtime,
    // both values are equal and the (device, inode) check still applies.
    if (
      stored.device !== stats.dev ||
      stored.inode !== stats.ino ||
      stored.birthtime !== stats.birthtimeMs
    ) {
      return {
        matched: false,
        mismatchType: 'path_replaced',
        details: 'Path replacement',
      };
    }
    return { matched: true };
  }
}

export const dbIdentityService = new DBIdentityService();
