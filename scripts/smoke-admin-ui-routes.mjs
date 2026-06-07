#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const adminRoot = path.join(repoRoot, "packages", "admin-ui");
const appRoot = path.join(adminRoot, "src", "app");
const baseUrl = process.env.ADMIN_UI_BASE_URL || "http://127.0.0.1:3000";
const timeoutMs = Number.parseInt(process.env.ADMIN_UI_SMOKE_TIMEOUT_MS || "10000", 10);
const companyId =
  process.env.ADMIN_UI_SMOKE_COMPANY_ID || "00000000-0000-4000-8000-000000000002";
const issueId =
  process.env.ADMIN_UI_SMOKE_ISSUE_ID || "6bf46049-be20-4a8b-9bf1-52fb5eb335e8";

const routes = [
  { path: "/", statuses: new Set([200, 307, 308]), label: "root" },
  { path: "/mission-control", statuses: new Set([200]), label: "mission control" },
  {
    path: `/mission-control/${companyId}`,
    statuses: new Set([200]),
    label: "mission control company",
  },
  {
    path: `/mission-control/${companyId}/issues/${issueId}/activity`,
    statuses: new Set([200]),
    label: "live issue activity",
  },
  { path: "/automations", statuses: new Set([200]), label: "automations" },
  { path: "/issues", statuses: new Set([200]), label: "issues" },
];

const forbiddenDocumentFile = /^_document\.(js|jsx|ts|tsx)$/;

async function listForbiddenAppRouterFiles(dir) {
  const matches = [];

  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (forbiddenDocumentFile.test(entry.name)) {
        matches.push(entryPath);
      }
    }
  }

  await walk(dir);
  return matches;
}

function hasNextErrorPayload(status, body) {
  if (status >= 500) return true;
  return (
    body.includes('"page":"/_error"') ||
    body.includes('"statusCode":500') ||
    body.includes("Server Error") ||
    body.includes("Cannot find module './") ||
    body.includes("Cannot find module") ||
    body.includes("Module not found")
  );
}

function excerpt(body) {
  return body
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

async function fetchRoute(route) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(new URL(route.path, baseUrl), {
      redirect: "manual",
      signal: controller.signal,
    });
    const body = await response.text();
    return { route, status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const forbiddenFiles = await listForbiddenAppRouterFiles(appRoot);
  if (forbiddenFiles.length > 0) {
    console.error("Admin UI smoke failed: Next _document files are not valid under src/app.");
    for (const file of forbiddenFiles) {
      console.error(`- ${path.relative(repoRoot, file)}`);
    }
    process.exit(1);
  }

  const failures = [];
  for (const route of routes) {
    try {
      const result = await fetchRoute(route);
      const badStatus = !route.statuses.has(result.status);
      const nextError = hasNextErrorPayload(result.status, result.body);

      if (badStatus || nextError) {
        failures.push({
          route,
          status: result.status,
          detail: excerpt(result.body) || "empty response",
        });
      } else {
        console.log(`ok ${route.path} ${result.status}`);
      }
    } catch (error) {
      failures.push({
        route,
        status: "request_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failures.length > 0) {
    console.error(`Admin UI route smoke failed for ${failures.length} route(s):`);
    for (const failure of failures) {
      console.error(`- ${failure.route.path} (${failure.route.label}) -> ${failure.status}: ${failure.detail}`);
    }
    console.error(`Base URL: ${baseUrl}`);
    process.exit(1);
  }

  console.log(`Admin UI route smoke passed at ${baseUrl}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
