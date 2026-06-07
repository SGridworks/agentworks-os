#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const ignoreFile = ".public-releaseignore";
const selfAllowlist = new Set([
  "scripts/check-public-release-safety.mjs",
  "scripts/check-product-surface-references.mjs",
  ignoreFile,
]);

const defaultIgnores = [
  ".git/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  ".next/**",
  "coverage/**",
  "test-results/**",
  "site/**",
  "PLAN.md",
  "CLAUDE.md",
  "CLAUDE-ONBOARDING.md",
  "agents/**",
  "docs/internal-*",
  "docs/handoff-*",
  "docs/awos-local-*",
  "docs/sprint-*",
  "docs/plans/**",
  "docs/sgridworks-managed-service-tier.md",
  "docs/brand-naming-convention.md",
  "docs/agentic-memory-recommendations.md",
  "docs/rfc/**",
  "docs/rfcs/**",
  "tests/plans/**",
];

const ignorePatterns = [
  ...defaultIgnores,
  ...(existsSync(ignoreFile)
    ? readFileSync(ignoreFile, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
    : []),
];

const forbidden = [
  { label: "operator home path", pattern: "/Users/2agents" },
  { label: "operator username", pattern: "2agents" },
  { label: "current home path", pattern: homedir() },
  { label: "private temp path", pattern: "/private/tmp" },
  { label: "private var path", pattern: "/private/var" },
  { label: "macOS temp folder path", pattern: "/var/folders" },
  { label: "private project name", pattern: "Dynamic-Network-Model" },
  { label: "private project shorthand", pattern: "DNM" },
  { label: "private website repo", pattern: "sgridworks-website" },
  { label: "private tracker repo", pattern: "google-tracker" },
  { label: "private analysis repo", pattern: "strata-irp" },
  { label: "private tenant name", pattern: "Cash Money Trading" },
  { label: "private tenant name", pattern: "ProbeWorks" },
  { label: "private tenant name", pattern: "WaterWorks" },
  { label: "private runtime name", pattern: "Hermes" },
  { label: "prior internal project name", pattern: "paperclip" },
  { label: "private tenant slug", pattern: "sgridworks-local" },
  { label: "private vault key", pattern: "projects/sgridworks" },
  { label: "private workload name", pattern: "Sgridworks Wildfire" },
  { label: "private tenant UUID", pattern: "30184da8-d721-40a3-bb9f-326e616e9892" },
  { label: "private company UUID", pattern: "d63eb401-51b0-4069-a863-f093600996cd" },
];

function globToRegExp(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    const next = pattern[i + 1];
    if (ch === "*" && next === "*") {
      out += ".*";
      i += 1;
    } else if (ch === "*") {
      out += "[^/]*";
    } else {
      out += ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

const ignoreRegexes = ignorePatterns.map(globToRegExp);
function ignored(file) {
  return ignoreRegexes.some((re) => re.test(file));
}

function textFile(buffer) {
  if (buffer.includes(0)) return false;
  return true;
}

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean)
  .sort();

const findings = [];
let scanned = 0;
let skipped = 0;

for (const file of files) {
  if (selfAllowlist.has(file) || ignored(file)) {
    skipped += 1;
    continue;
  }
  if (!existsSync(file)) {
    skipped += 1;
    continue;
  }
  const stat = lstatSync(file);
  if (!stat.isFile()) {
    skipped += 1;
    continue;
  }
  const buf = readFileSync(file);
  if (!textFile(buf)) {
    skipped += 1;
    continue;
  }
  scanned += 1;
  const text = buf.toString("utf8");
  for (const rule of forbidden) {
    if (rule.pattern && text.includes(rule.pattern)) {
      findings.push(`${file}: forbidden ${rule.label} (${rule.pattern})`);
    }
  }
}

if (findings.length > 0) {
  console.error("Public-release safety check failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  console.error(`Scanned ${scanned} files, skipped ${skipped} files.`);
  process.exit(1);
}

console.log(`Public-release safety check passed (scanned ${scanned} files, skipped ${skipped} files).`);
