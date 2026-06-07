import { execSync } from 'child_process';
import { describe, it, expect } from 'vitest';

describe('Build Test', () => {
  it('should build successfully', () => {
    try {
      execSync('npm run build', { stdio: 'pipe' });
      expect(true).toBe(true);
    } catch (error) {
      expect.fail(`Build failed: ${error}`);
    }
  });
});