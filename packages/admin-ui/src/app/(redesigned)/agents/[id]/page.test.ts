import { describe, test, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Agent Detail Page Changes', () => {
  test('preserves the current agent detail page sections', () => {
    const filePath = path.join(__dirname, 'page.tsx');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('OPERATE · AGENT');
    expect(content).toContain('Configuration');
    expect(content).toContain('Runtime state');
    expect(content).toContain('Budget &amp; activity');
    expect(content).toContain('Instructions');
    expect(content).toContain('Inbox ·');
    expect(content).toContain('Revisions ·');
    expect(content).toContain('Wakeups ·');
    expect(content).toContain('Task sessions ·');
  });
});
