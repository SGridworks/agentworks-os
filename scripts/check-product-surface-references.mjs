#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const forbiddenTerms = [/paperclip/i, /obsidian/i, /hermes/i];

const targetPaths = [
  "packages",
  "apps",
  "scripts",
  "tests",
  "docs",
  "n8n-nodes-packages",
  "rule-packs",
  "AGENTS.md",
  ".env.local.example",
  "CLAUDE.md",
  "CLAUDE-ONBOARDING.md",
  "PLAN.md",
  "README.md",
  "docker-compose.dev.yml",
  "docker-compose.yml",
  "mkdocs.yml",
  "package.json",
  "playwright.config.ts",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "vitest.config.ts",
  "vitest.shared.ts",
];

const allowedExact = new Set([
  "scripts/check-product-surface-references.mjs",
  "scripts/check-public-release-safety.mjs",
  "apps/installer/tests/scaffold-workspace.test.sh",
]);

const allowedPrefixes = [];

const ignoredPathSegments = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
  "playwright-report",
  "test-results",
  "_legacy",
  "raw-sources",
  "lint-history",
]);

const scannableExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".sh",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

function toRepoPath(absPath) {
  return relative(repoRoot, absPath).split(sep).join("/");
}

function isAllowed(relPath) {
  if (allowedExact.has(relPath)) return true;
  return allowedPrefixes.some((prefix) => relPath.startsWith(prefix));
}

function shouldSkip(relPath) {
  if (!relPath) return false;
  if (isAllowed(relPath)) return true;
  const segments = relPath.split("/");
  return segments.some((segment) => ignoredPathSegments.has(segment));
}

function isScannable(relPath) {
  const ext = extname(relPath);
  return scannableExtensions.has(ext);
}

function sanitize(value) {
  let out = value;
  for (const term of forbiddenTerms) out = out.replace(term, "[external]");
  return out;
}

async function collectFiles(targetAbs, out) {
  const rel = toRepoPath(targetAbs);
  if (shouldSkip(rel)) return;

  let stat;
  try {
    stat = await fs.stat(targetAbs);
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  }

  if (stat.isDirectory()) {
    const entries = await fs.readdir(targetAbs, { withFileTypes: true });
    for (const entry of entries) {
      await collectFiles(join(targetAbs, entry.name), out);
    }
    return;
  }

  if (stat.isFile() && isScannable(rel)) out.push(targetAbs);
}

async function main() {
  const files = [];
  for (const target of targetPaths) {
    await collectFiles(join(repoRoot, target), files);
  }

  const findings = [];
  for (const absPath of files.sort()) {
    const relPath = toRepoPath(absPath);
    const text = await fs.readFile(absPath, "utf8");
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (forbiddenTerms.some((term) => term.test(lines[index] ?? ""))) {
        findings.push(`${sanitize(relPath)}:${index + 1}`);
      }
    }
  }

  if (findings.length > 0) {
    console.error("Forbidden external references found in product surfaces:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Product-surface forbidden-reference check passed (${files.length} files scanned).`);
}

main().catch((err) => {
  console.error("Product-surface forbidden-reference check failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
