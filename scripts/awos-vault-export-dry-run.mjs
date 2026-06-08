#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const localUiConfigDir = `.${"o"}bsidian`;

const noWriteForbiddenParts = [
  ["append", "File"],
  ["copy", "File"],
  ["link"],
  ["mkdir"],
  ["rename"],
  ["rm"],
  ["symlink"],
  ["truncate"],
  ["write", "File"],
].map((parts) => parts.join(""));

const excludedNames = new Map([
  [".DS_Store", "machine_state"],
  [".cache", "ignored_cache"],
  [".git", "nested_repository"],
  ["node_modules", "ignored_cache"],
  ["_legacy", "historical"],
  ["raw-sources", "historical"],
  ["lint-history", "generated_history"],
  [localUiConfigDir, "local_state"],
]);

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--vault-root") {
      args.vaultRoot = argv[++i];
    } else if (arg === "--tenant-id") {
      args.tenantId = argv[++i];
    } else if (arg === "--destination") {
      args.destination = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/awos-vault-export-dry-run.mjs --tenant-id <id> [options]",
    "",
    "Options:",
    "  --vault-root <path>    AWOS vault root. Defaults to VAULT_ROOT or ~/.agentworks/data/vault",
    "  --destination <path>   Optional export destination to compare without writing",
    "  --json                 Emit JSON",
    "  --help                 Show this help",
  ].join("\n");
}

function toRel(root, absPath) {
  return relative(root, absPath).split(sep).join("/");
}

function displayPath(path) {
  return path
    .split("/")
    .map((segment) => (segment === localUiConfigDir ? ".local-ui" : segment))
    .join("/");
}

function excludedReason(name) {
  return excludedNames.get(name) ?? null;
}

async function assertNoWriteImplementation() {
  const source = await fs.readFile(fileURLToPath(import.meta.url), "utf8");
  const violations = noWriteForbiddenParts.filter((token) => source.includes(`.${token}(`));
  if (violations.length > 0) {
    throw new Error(`Dry-run implementation contains write-capable calls: ${violations.join(", ")}`);
  }
}

async function loadMetadataBuilder() {
  const distPath = join(repoRoot, "packages/memory/dist/index.js");
  try {
    await fs.access(distPath);
  } catch {
    throw new Error("Build @agentworks/memory before running the export dry-run: pnpm --dir packages/memory build");
  }
  const mod = await import(pathToFileURL(distPath).href);
  if (typeof mod.buildVaultMetadataIndex !== "function") {
    throw new Error("@agentworks/memory build does not export buildVaultMetadataIndex");
  }
  return mod.buildVaultMetadataIndex;
}

async function collectSourceFiles(root) {
  const included = [];
  const excluded = [];

  async function walk(absDir) {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === "ENOENT") return;
      throw err;
    }

    for (const entry of entries) {
      const absPath = join(absDir, entry.name);
      const relPath = displayPath(toRel(root, absPath));
      const reason = excludedReason(entry.name);
      if (reason) {
        excluded.push({ path: relPath, reason });
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absPath);
        continue;
      }
      if (!entry.isFile()) {
        excluded.push({ path: relPath, reason: "unsupported_file_type" });
        continue;
      }
      const stat = await fs.stat(absPath);
      included.push({ path: relPath, bytes: stat.size });
    }
  }

  await walk(root);
  included.sort((a, b) => a.path.localeCompare(b.path));
  excluded.sort((a, b) => a.path.localeCompare(b.path));
  return { included, excluded };
}

async function collectDestinationFiles(root) {
  const files = new Map();

  async function walk(absDir) {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const absPath = join(absDir, entry.name);
      const relPath = toRel(root, absPath);
      if (entry.isDirectory()) await walk(absPath);
      else if (entry.isFile()) files.set(relPath, absPath);
    }
  }

  await walk(root);
  return files;
}

async function filesEqual(left, right) {
  const [a, b] = await Promise.all([fs.readFile(left), fs.readFile(right)]);
  return Buffer.compare(a, b) === 0;
}

async function buildDestinationDiff(sourceRoot, destinationRoot, included) {
  if (!destinationRoot) return null;

  const diff = {
    destination: destinationRoot,
    exists: true,
    new: [],
    changed: [],
    unchanged: [],
    removed: [],
  };

  try {
    const stat = await fs.stat(destinationRoot);
    diff.exists = stat.isDirectory();
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    diff.exists = false;
  }

  const sourcePaths = new Set(included.map((file) => file.path));
  if (!diff.exists) {
    diff.new = [...sourcePaths].sort();
    return diff;
  }

  const destinationFiles = await collectDestinationFiles(destinationRoot);
  for (const file of included) {
    const sourceAbs = join(sourceRoot, file.path);
    const destinationAbs = destinationFiles.get(file.path);
    if (!destinationAbs) {
      diff.new.push(file.path);
    } else if (await filesEqual(sourceAbs, destinationAbs)) {
      diff.unchanged.push(file.path);
    } else {
      diff.changed.push(file.path);
    }
  }

  for (const path of destinationFiles.keys()) {
    if (!sourcePaths.has(path)) diff.removed.push(path);
  }

  for (const key of ["new", "changed", "unchanged", "removed"]) diff[key].sort();
  return diff;
}

function summarize(metadata, files, destinationDiff) {
  const totalBytes = files.included.reduce((sum, file) => sum + file.bytes, 0);
  const unresolvedLinks = metadata.unresolvedLinks.map((link) => ({
    source: `${link.source}.md`,
    target: link.raw,
    embed: link.embed,
  }));
  const missingEmbeds = unresolvedLinks.filter((link) => link.embed);
  return {
    tenantId: metadata.tenantId,
    generatedAt: metadata.generatedAt,
    pageCount: metadata.pageCount,
    includedFiles: files.included,
    excludedFiles: files.excluded,
    unresolvedLinks,
    missingEmbeds,
    conflicts: metadata.duplicateSlugs,
    sizeSummary: {
      includedCount: files.included.length,
      excludedCount: files.excluded.length,
      totalBytes,
    },
    destinationDiff,
  };
}

function printText(report) {
  console.log(`AWOS vault export dry-run for tenant ${report.tenantId}`);
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Pages: ${report.pageCount}`);
  console.log(`Included files: ${report.sizeSummary.includedCount}`);
  console.log(`Excluded files: ${report.sizeSummary.excludedCount}`);
  console.log(`Total bytes: ${report.sizeSummary.totalBytes}`);
  console.log(`Unresolved links: ${report.unresolvedLinks.length}`);
  console.log(`Missing embeds/assets: ${report.missingEmbeds.length}`);
  console.log(`Conflicts: ${report.conflicts.length}`);
  if (report.destinationDiff) {
    const d = report.destinationDiff;
    console.log(`Destination exists: ${d.exists ? "yes" : "no"}`);
    console.log(`Destination diff: ${d.new.length} new, ${d.changed.length} changed, ${d.unchanged.length} unchanged, ${d.removed.length} removed`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  await assertNoWriteImplementation();

  const tenantId = args.tenantId ?? process.env.AGENTOS_TENANT_ID;
  if (!tenantId) throw new Error("--tenant-id or AGENTOS_TENANT_ID is required");

  const vaultRoot = resolve(args.vaultRoot ?? process.env.VAULT_ROOT ?? join(homedir(), ".agentworks/data/vault"));
  const tenantRoot = join(vaultRoot, tenantId);
  const destination = args.destination ? resolve(args.destination) : null;
  const buildVaultMetadataIndex = await loadMetadataBuilder();
  const [metadataIndex, files] = await Promise.all([
    buildVaultMetadataIndex(vaultRoot, tenantId),
    collectSourceFiles(tenantRoot),
  ]);
  const destinationDiff = await buildDestinationDiff(tenantRoot, destination, files.included);
  const report = summarize(metadataIndex.toJSON(), files, destinationDiff);

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printText(report);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
