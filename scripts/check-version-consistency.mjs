#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const expected = readFileSync("VERSION", "utf8").trim();
if (!expected) {
  console.error("VERSION is empty");
  process.exit(1);
}

const files = execFileSync("rg", ["--files", "-g", "package.json"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean)
  .sort();

const failures = [];
for (const file of files) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  if (pkg.version && pkg.version !== expected) {
    failures.push(`${file}: ${pkg.version} != ${expected}`);
  }
}

if (failures.length > 0) {
  console.error("Version consistency check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Version consistency check passed (${files.length} package manifests at ${expected}).`);
