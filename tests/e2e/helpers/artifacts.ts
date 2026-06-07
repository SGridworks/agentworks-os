import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page, ConsoleMessage, Request } from '@playwright/test';
import { ARTIFACTS_DIR } from './awos-preflight.js';

export interface Artifacts {
  screenshotPath: string;
  tracePath?: string;
  consoleLogPath: string;
  networkLogPath: string;
  pageHtmlPath: string;
}

function ensureArtifactsDir(): string {
  const dir = ARTIFACTS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeStringify(val: any, depth = 0): string {
  if (depth > 3) return '...';
  if (typeof val === 'string') return val;
  if (val === null || val === undefined) return String(val);
  if (typeof val === 'function') return val.toString();
  if (Array.isArray(val)) {
    return '[' + val.map((v) => safeStringify(v, depth + 1)).join(', ') + ']';
  }
  if (typeof val === 'object') {
    const entries = Object.entries(val as Record<string, unknown>);
    return '{' + entries.map(([k, v]) => `${k}: ${safeStringify(v, depth + 1)}`).join(', ') + '}';
  }
  return String(val);
}

export async function captureArtifacts(
  page: Page,
  testName: string,
  consoleLogs: ConsoleMessage[],
  networkRequests: Request[]
): Promise<Artifacts> {
  const dir = ensureArtifactsDir();
  const prefix = sanitizeFilename(testName);

  // Screenshot
  const screenshotPath = path.join(dir, `${prefix}-failure.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  // Console log
  const consolePath = path.join(dir, `${prefix}-console.log`);
  const consoleLines = consoleLogs.map((msg) => {
    const loc = msg.location();
    return `[${msg.type()}] ${msg.text()}${loc.url ? ` (${loc.url}:${loc.lineNumber})` : ''}`;
  });
  fs.writeFileSync(consolePath, consoleLines.join('\n') + '\n');

  // Network log
  const networkPath = path.join(dir, `${prefix}-network.json`);
  const networkEntries = await Promise.all(
    networkRequests.map(async (req) => {
      const res = await req.response().catch(() => null);
      return {
        url: req.url(),
        method: req.method(),
        status: res?.status(),
        resourceType: req.resourceType(),
        failure: req.failure()?.errorText,
        timestamp: req.timing()?.startTime,
      };
    })
  );
  fs.writeFileSync(networkPath, JSON.stringify(networkEntries, null, 2));

  // Page HTML
  const pageHtmlPath = path.join(dir, `${prefix}-page.html`);
  const html = await page.content().catch(() => '<html><body><p>Could not capture HTML</p></body></html>');
  fs.writeFileSync(pageHtmlPath, html);

  return {
    screenshotPath,
    consoleLogPath: consolePath,
    networkLogPath: networkPath,
    pageHtmlPath,
  };
}

function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function capturePreflightArtifacts(
  result: unknown,
  testName: string
): Promise<void> {
  const dir = ensureArtifactsDir();
  const prefix = sanitizeFilename(testName);
  writeJson(path.join(dir, `${prefix}-preflight.json`), result);
}
