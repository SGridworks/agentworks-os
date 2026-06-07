import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'node:path';
import { dbIdentityService } from './db-identity';

describe('DbIdentityService', () => {
  const tempDir = join(process.cwd(), 'tmp-test-db-identity');

  beforeEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir);
  });

  it('captures identity on initial DB open', async () => {
    const dbPath = join(tempDir, 'test.db');
    await fs.writeFile(dbPath, '');
    const identity = await dbIdentityService.captureIdentity(dbPath);
    expect(identity).toBeDefined();
    expect(identity).toHaveProperty('device');
    expect(identity).toHaveProperty('inode');
    expect(identity).toHaveProperty('size');
    expect(identity).toHaveProperty('mtime');
  });

  it('detects path replacement when file is replaced', async () => {
    const dbPath = join(tempDir, 'replaced.db');
    const originalContent = 'original content';

    // Create original file
    await fs.writeFile(dbPath, originalContent);
    await dbIdentityService.captureIdentity(dbPath);

    // Delete original file
    await fs.unlink(dbPath);
    // Create new file at same path with replacement content
    await fs.writeFile(dbPath, 'replacement content');

    const result = await dbIdentityService.verifyIdentity(dbPath);
    expect(result.matched).toBe(false);
    expect(result.mismatchType).toBe('path_replaced');
    expect(result.details).toContain('Path replacement');
  });
});