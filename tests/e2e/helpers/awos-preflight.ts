import * as fs from 'node:fs';
import * as path from 'node:path';

export const DAEMON_URL = process.env.AWOS_DAEMON_URL || 'http://127.0.0.1:7710';
export const ADMIN_UI_URL = process.env.AWOS_E2E_BASE_URL || 'http://127.0.0.1:3000';
export const ARTIFACTS_DIR = process.env.AWOS_E2E_ARTIFACTS_DIR || 'test-results/awos-browser-e2e';

export const EXPECTED_COMPANIES = [
  'AgentWorks',
  'E2E-Test-Company',
];

export interface PreflightResult {
  timestamp: string;
  daemonUrl: string;
  adminUiUrl: string;
  daemonReachable: boolean;
  adminUiReachable: boolean;
  trustStatus: {
    reachable: boolean;
    data?: Record<string, unknown>;
    error?: string;
  };
  companies: {
    reachable: boolean;
    count: number;
    names: string[];
    error?: string;
  };
  dbIdentityMatched: boolean;
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal as RequestInit['signal'] });
    clearTimeout(timer);
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 0, body: null };
  }
}

export async function runPreflight(): Promise<PreflightResult> {
  const result: PreflightResult = {
    timestamp: new Date().toISOString(),
    daemonUrl: DAEMON_URL,
    adminUiUrl: ADMIN_UI_URL,
    daemonReachable: false,
    adminUiReachable: false,
    trustStatus: { reachable: false },
    companies: { reachable: false, count: 0, names: [] },
    dbIdentityMatched: false,
  };

  // Check daemon health
  const healthRes = await fetchJson(`${DAEMON_URL}/api/health`);
  result.daemonReachable = healthRes.ok;

  // Check admin UI responds
  const uiRes = await fetchJson(`${ADMIN_UI_URL}/mission-control`);
  result.adminUiReachable = uiRes.ok || uiRes.status === 200 || uiRes.status === 304;

  // Trust status — DB identity lives here
  const trustRes = await fetchJson(`${DAEMON_URL}/api/admin/trust`);
  result.trustStatus.reachable = trustRes.ok;
  if (trustRes.ok && trustRes.body) {
    result.trustStatus.data = trustRes.body as Record<string, unknown>;
    const td = trustRes.body as Record<string, unknown>;
    result.dbIdentityMatched = Boolean(td?.database && td?.database !== 'mismatch');
  } else {
    result.trustStatus.error = `HTTP ${trustRes.status}`;
  }

  // Companies list — validate expected names are present
  const companiesRes = await fetchJson(`${DAEMON_URL}/api/admin/companies`);
  result.companies.reachable = companiesRes.ok;
  if (companiesRes.ok && companiesRes.body) {
    const arr = companiesRes.body as Array<{ name?: string }>;
    result.companies.names = arr.map((c) => c.name ?? '').filter(Boolean);
    result.companies.count = arr.length;
    const companyNamesSet = new Set(result.companies.names);
    result.dbIdentityMatched = EXPECTED_COMPANIES.every((n) => companyNamesSet.has(n));
  } else {
    result.companies.error = `HTTP ${companiesRes.status}`;
  }

  return result;
}

export function savePreflight(result: PreflightResult): string {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const filePath = path.join(ARTIFACTS_DIR, 'preflight.json');
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
  return filePath;
}

export function preflightMustPass(result: PreflightResult): void {
  const errors: string[] = [];

  if (!result.daemonReachable) {
    errors.push(`Daemon unreachable at ${result.daemonUrl}`);
  }
  if (!result.adminUiReachable) {
    errors.push(`Admin UI unreachable at ${result.adminUiUrl}`);
  }
  if (!result.trustStatus.reachable) {
    errors.push(`Trust endpoint unreachable: ${result.trustStatus.error}`);
  }
  if (!result.companies.reachable) {
    errors.push(`Companies endpoint unreachable: ${result.companies.error}`);
  }
  if (result.dbIdentityMatched === false) {
    const missing = EXPECTED_COMPANIES.filter((n) => !result.companies.names.includes(n));
    errors.push(`DB identity mismatch — missing companies: ${missing.join(', ')}`);
  }

  if (errors.length > 0) {
    throw new Error(`PREFLIGHT FAILED:\n${errors.join('\n')}`);
  }
}
