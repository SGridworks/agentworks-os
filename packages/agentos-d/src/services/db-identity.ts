import { join } from 'node:path';
import { promises as fsPromises } from 'fs';

export interface DbIdentity {
  device: number;
  inode: number;
  size: number;
  mtime: number;
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
    if (stored.device !== stats.dev || stored.inode !== stats.ino) {
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