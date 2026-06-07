/**
 * Vault lint — mechanical health checks over a tenant's vault.
 *
 * Ports the deterministic subset of the Hermes vault-lint skill into a
 * typed module: orphan pages, dead wikilinks, frontmatter gaps, empty
 * sections, kebab-case filename violations, source drift, contradictions,
 * confidence, page oversize, tag audit, log rotation. Semantic checks
 * (stale claims, missing cross-references, writing-style violations) stay
 * an agent's job — substrate provides the structure; agents do the
 * synthesis.
 *
 * Severity semantics (3-tier):
 *   - info    = static / cosmetic (page is fine, could be tidier)
 *   - warn    = guidance (page is functional, agent should probably look)
 *   - error   = trust-breaking (downstream page will be wrong if missed)
 *
 * The 5 originally-shipped check kinds keep their existing severities
 * (byte-stable) so callers and stored reports don't churn:
 *   orphan_page         info
 *   dead_link           warn
 *   frontmatter_gap     warn
 *   empty_section       info
 *   kebab_case_violation warn
 *
 * The 6 LLM-Wiki-v2 check kinds are added as:
 *   source_drift        error  (sha256 mismatch on a tracked raw-source)
 *   contradiction_flagged error (page has contested: true or non-empty
 *                               contradictions: frontmatter)
 *   confidence_low      warn   (single-source page or explicit
 *                               confidence: low)
 *   page_oversize       info   (page > 200 lines)
 *   tag_audit           info   (tag not in SCHEMA.md taxonomy)
 *   log_rotation_due    info   (log.md > 500 lines)
 *
 * Run pattern:
 *
 *   const report = await lintVault(vaultRoot, tenantId, {
 *     requiredFrontmatter: ["title", "type"],
 *     checks: ["source_drift", "page_oversize"], // opt-in subset
 *   });
 *   for (const f of report.findings) console.log(f.path, f.kind, f.message);
 */

import { createHash, type Hash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, relative, basename } from "node:path";

export type LintKind =
  | "orphan_page"
  | "dead_link"
  | "frontmatter_gap"
  | "empty_section"
  | "kebab_case_violation"
  | "source_drift"
  | "contradiction_flagged"
  | "confidence_low"
  | "page_oversize"
  | "tag_audit"
  | "log_rotation_due";

/**
 * Runtime array of all 11 LintKind values. Routes use this for Zod
 * enum validation so an unknown check name surfaces as a 400, not
 * a silently-ignored query param. Kept in sync with the `LintKind`
 * type above by hand — if you add a kind, add it to both.
 */
export const ALL_LINT_KINDS: readonly LintKind[] = [
  "orphan_page",
  "dead_link",
  "frontmatter_gap",
  "empty_section",
  "kebab_case_violation",
  "source_drift",
  "contradiction_flagged",
  "confidence_low",
  "page_oversize",
  "tag_audit",
  "log_rotation_due",
];

export type LintSeverity = "info" | "warn" | "error";

export interface LintFinding {
  kind: LintKind;
  severity: LintSeverity;
  path: string; // vault-relative
  message: string;
  /** Optional secondary identifier (e.g. drift source path, tag name). */
  detail?: string;
}

export interface LintReport {
  tenantId: string;
  ranAt: string;
  /** Stable id of this run; useful for diffing. sha256 of the findings JSON. */
  runId: string;
  pageCount: number;
  findings: LintFinding[];
  totals: Record<LintKind, number>;
  /** Which check kinds were actually executed (post-`checks` filter). */
  executed: LintKind[];
}

export interface LintOptions {
  /** Frontmatter fields a page must declare. Default: title, type. */
  requiredFrontmatter?: string[];
  /** Skip kebab-case checks for these basenames (e.g. README.md, index.md). */
  filenameWhitelist?: string[];
  /**
   * Opt into a subset of check kinds. Default: all 11. Useful for
   * ad-hoc smoke runs (e.g. "just page_oversize") and for incremental
   * rollout via the route's `checks` query param.
   */
  checks?: LintKind[];
  /** Override page-oversize threshold (default 200 lines). */
  pageOversizeLines?: number;
  /** Override log-rotation threshold (default 500 lines). */
  logRotationLines?: number;
  /**
   * Path to the manifest for source_drift detection. Typically
   * `<vaultRoot>/.manifest.json` (project-level, not per-tenant).
   * Default: `<vaultRoot>/.manifest.json`.
   */
  manifestPath?: string;
  /**
   * Path to SCHEMA.md for tag-audit. Default:
   * `<vaultRoot>/wiki/SCHEMA.md` (Karpathy's documented location).
   */
  schemaPath?: string;
}

interface PageSnapshot {
  /** Absolute filesystem path. */
  absPath: string;
  /** Vault-relative path (relative to <root>/<tenantId>). */
  relPath: string;
  /** Filename without extension — used as wikilink target. */
  slug: string;
  /** Parsed frontmatter (top-level keys only). */
  frontmatter: Record<string, string>;
  /** Outbound wikilinks (the [[Target]] strings, unresolved). */
  outboundLinks: string[];
  /** Has a `## Heading` with no non-empty content under it. */
  emptySections: string[];
  /** Full body text (for line-count + length-based checks). */
  body: string;
  /** Line count of the body (1-indexed; trailing blank trimmed). */
  lineCount: number;
  /** Tags list parsed from `tags: [a, b, c]` frontmatter. */
  tags: string[];
}

interface VaultSnapshot {
  pages: PageSnapshot[];
  /** slug → page paths that contain at least one wikilink to that slug. */
  inboundIndex: Map<string, string[]>;
}

const DEFAULT_REQUIRED_FRONTMATTER = ["title", "type"];
const DEFAULT_WHITELIST = ["README.md", "index.md", "log.md"];

const ALL_KINDS_INTERNAL: readonly LintKind[] = [
  "orphan_page",
  "dead_link",
  "frontmatter_gap",
  "empty_section",
  "kebab_case_violation",
  "source_drift",
  "contradiction_flagged",
  "confidence_low",
  "page_oversize",
  "tag_audit",
  "log_rotation_due",
];

// Walk a directory recursively, returning all .md files.
  // Follows symbolic links (so the prod tenant's `wiki -> ../wiki` resolves
  // shared vault content). Cycle-safe via realpath dedup.
async function findMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  async function walk(dir: string): Promise<void> {
    let real: string;
    try {
      real = await fs.realpath(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (seen.has(real)) return;
    seen.add(real);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // skip .manifest.json, .git, etc.
      const p = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = await fs.stat(p);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // broken symlink
        }
      }
      if (isDir) await walk(p);
      else if (isFile && entry.name.endsWith(".md")) out.push(p);
    }
  }
  await walk(root);
  return out;
}

function parseFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fm) return { frontmatter: {}, body: text };
  const frontmatter: Record<string, string> = {};
  for (const line of (fm[1] ?? "").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (m && m[1]) frontmatter[m[1]] = (m[2] ?? "").trim();
  }
  return { frontmatter, body: fm[2] ?? "" };
}

function parseTags(fm: Record<string, string>): string[] {
  const raw = fm["tags"];
  if (!raw) return [];
  // Accepts: [a, b, c] | [a,b,c] | a, b, c
  const inner = raw.replace(/^\[|]$/g, "");
  return inner
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function stripCodeBlocks(body: string): string {
  // Drop fenced ```...``` blocks and inline `code` spans before extracting
  // wikilinks. Doc/template files commonly contain example wikilinks like
  // [[page-name]] or [[project-slug]] inside fences; those aren't real links
  // and shouldn't surface as dead-link warnings.
  return body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "");
}

function extractWikilinks(body: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]\n]+)\]\]/g;
  let m: RegExpExecArray | null;
  const stripped = stripCodeBlocks(body);
  while ((m = re.exec(stripped)) !== null) {
    if (!m[1]) continue;
    // Stripping any "|alias" — wikilinks can be [[Target|alias]]
    const target = m[1].split("|")[0]?.trim() ?? "";
    if (target) out.push(target);
  }
  return out;
}

function findEmptyHeadings(body: string): string[] {
  const lines = body.split("\n");
  const headings: { idx: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]?.match(/^(#{1,6})\s+(.+)$/);
    if (m && m[2]) headings.push({ idx: i, text: m[2].trim() });
  }
  const empties: string[] = [];
  for (let h = 0; h < headings.length; h++) {
    const start = headings[h]!.idx + 1;
    const end = h + 1 < headings.length ? headings[h + 1]!.idx : lines.length;
    const between = lines.slice(start, end).filter((l) => l.trim().length > 0);
    if (between.length === 0) empties.push(headings[h]!.text);
  }
  return empties;
}

function countLines(body: string): number {
  // Trailing blank lines are noise. Count non-empty trailing tail.
  const lines = body.split("\n");
  let n = lines.length;
  while (n > 0 && lines[n - 1]?.trim() === "") n--;
  return n;
}

async function snapshotVault(root: string, tenantId: string): Promise<VaultSnapshot> {
  const tenantRoot = join(root, tenantId);
  const files = await findMarkdownFiles(tenantRoot);
  const pages: PageSnapshot[] = [];

  for (const absPath of files) {
    const relPath = relative(tenantRoot, absPath);
    const text = await fs.readFile(absPath, "utf8");
    const { frontmatter, body } = parseFrontmatter(text);
    pages.push({
      absPath,
      relPath,
      slug: basename(absPath, ".md"),
      frontmatter,
      outboundLinks: extractWikilinks(body),
      emptySections: findEmptyHeadings(body),
      body,
      lineCount: countLines(body),
      tags: parseTags(frontmatter),
    });
  }

  // inboundIndex: which pages link to each slug
  const inboundIndex = new Map<string, string[]>();
  for (const page of pages) {
    for (const link of page.outboundLinks) {
      const list = inboundIndex.get(link) ?? [];
      list.push(page.relPath);
      inboundIndex.set(link, list);
    }
  }

  return { pages, inboundIndex };
}

function isKebabCase(name: string): boolean {
  // basename without extension; allow lowercase letters, digits, hyphens.
  // No uppercase, no underscores, no spaces, no leading/trailing/double hyphens.
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

function newTotals(): Record<LintKind, number> {
  return ALL_KINDS_INTERNAL.reduce(
    (acc, k) => {
      acc[k] = 0;
      return acc;
    },
    {} as Record<LintKind, number>,
  );
}

/**
 * Load the set of allowed tags from SCHEMA.md by scanning for inline
 * backtick-tag literals (e.g. `` `#project` ``). The blockquote / table
 * style varies; the backtick form is the most stable across authors.
 *
 * Returns null if SCHEMA.md doesn't exist (caller decides: skip
 * tag_audit or surface as info).
 */
async function loadAllowedTags(schemaPath: string): Promise<Set<string> | null> {
  let text: string;
  try {
    text = await fs.readFile(schemaPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const tags = new Set<string>();
  // Match `#tag-name` (kebab-case) inside backticks. This is what
  // authors actually write; we don't try to parse markdown tables.
  const re = /`#([a-z0-9]+(?:-[a-z0-9]+)*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) tags.add(m[1]);
  }
  return tags;
}

interface ManifestShape {
  sources?: Record<
    string,
    { sha256?: string; bytes?: number; md5?: string; mime?: string }
  >;
}

async function loadManifest(
  manifestPath: string,
): Promise<ManifestShape | null> {
  try {
    const text = await fs.readFile(manifestPath, "utf8");
    return JSON.parse(text) as ManifestShape;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function sha256OfBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function makeRunId(findings: LintFinding[]): string {
  // Deterministic, stable per (tenant, finding-set). Diffing the report
  // against the previous runId surfaces "nothing changed" cheaply.
  const h: Hash = createHash("sha256");
  for (const f of findings) {
    h.update(f.kind);
    h.update("\0");
    h.update(f.path);
    h.update("\0");
    h.update(f.severity);
    h.update("\0");
    h.update(f.message);
    h.update("\0");
    h.update(f.detail ?? "");
    h.update("\n");
  }
  return h.digest("hex").slice(0, 16);
}

export async function lintVault(
  root: string,
  tenantId: string,
  opts: LintOptions = {},
): Promise<LintReport> {
  const required = opts.requiredFrontmatter ?? DEFAULT_REQUIRED_FRONTMATTER;
  const whitelist = new Set(opts.filenameWhitelist ?? DEFAULT_WHITELIST);
  const allowed = opts.checks ?? ALL_LINT_KINDS;
  const allowedSet = new Set<LintKind>(allowed);
  const oversizeThreshold = opts.pageOversizeLines ?? 200;
  const logRotThreshold = opts.logRotationLines ?? 500;
  const manifestPath = opts.manifestPath ?? join(root, ".manifest.json");
  const schemaPath = opts.schemaPath ?? join(root, "wiki", "SCHEMA.md");

  const snapshot = await snapshotVault(root, tenantId);
  const findings: LintFinding[] = [];
  const totals = newTotals();
  const pageSlugs = new Set(snapshot.pages.map((p) => p.slug));
  // Path-style targets: each page is reachable both by its bare slug
  // ([[profile]]) and by any unambiguous tail of its relPath
  // ([[me/profile]] or [[wiki/me/profile]]). Strip the .md extension and
  // normalize to forward slashes so wikilinks authored with either separator
  // resolve.
  const pagePaths = new Set<string>();
  for (const p of snapshot.pages) {
    const rel = p.relPath.replace(/\\/g, "/").replace(/\.md$/i, "");
    pagePaths.add(rel);
  }
  function resolves(link: string): boolean {
    if (pageSlugs.has(link)) return true;
    const norm = link.replace(/\\/g, "/").replace(/\.md$/i, "");
    if (pagePaths.has(norm)) return true;
    // Match in either direction:
    //   [[me/profile]] → wiki/me/profile.md (page path ends with link)
    //   [[<tenantId>/me/profile]] or [[wiki/me/profile]] → me/profile.md
    //     (link ends with page path — strips a prefix the author included)
    for (const path of pagePaths) {
      if (path === norm) return true;
      if (path.endsWith("/" + norm)) return true;
      if (norm.endsWith("/" + path)) return true;
    }
    return false;
  }

  // ── Pre-load shared data for new checks ────────────────────────────────

  const allowedTags =
    allowedSet.has("tag_audit") ? await loadAllowedTags(schemaPath) : null;
  const manifest =
    allowedSet.has("source_drift") ? await loadManifest(manifestPath) : null;

  for (const page of snapshot.pages) {
    // Orphan: no inbound wikilinks
    if (allowedSet.has("orphan_page")) {
      const inbound = snapshot.inboundIndex.get(page.slug) ?? [];
      if (inbound.length === 0 && !whitelist.has(basename(page.relPath))) {
        findings.push({
          kind: "orphan_page",
          severity: "info",
          path: page.relPath,
          message: `No inbound wikilinks point to [[${page.slug}]]`,
        });
        totals.orphan_page++;
      }
    }

    // Dead links: outbound wikilinks that don't resolve to a page
    if (allowedSet.has("dead_link")) {
      for (const link of page.outboundLinks) {
        if (!resolves(link)) {
          findings.push({
            kind: "dead_link",
            severity: "warn",
            path: page.relPath,
            message: `Wikilink [[${link}]] does not resolve to a vault page`,
          });
          totals.dead_link++;
        }
      }
    }

    // Frontmatter gaps
    if (allowedSet.has("frontmatter_gap")) {
      for (const field of required) {
        if (!page.frontmatter[field] || page.frontmatter[field] === "") {
          findings.push({
            kind: "frontmatter_gap",
            severity: "warn",
            path: page.relPath,
            message: `Missing required frontmatter field: ${field}`,
          });
          totals.frontmatter_gap++;
        }
      }
    }

    // Empty sections
    if (allowedSet.has("empty_section")) {
      for (const heading of page.emptySections) {
        findings.push({
          kind: "empty_section",
          severity: "info",
          path: page.relPath,
          message: `Heading '## ${heading}' has no content below it`,
        });
        totals.empty_section++;
      }
    }

    // kebab-case filename
    if (allowedSet.has("kebab_case_violation")) {
      const fname = basename(page.relPath);
      if (!whitelist.has(fname) && !isKebabCase(page.slug)) {
        findings.push({
          kind: "kebab_case_violation",
          severity: "warn",
          path: page.relPath,
          message: `Filename '${fname}' is not kebab-case`,
        });
        totals.kebab_case_violation++;
      }
    }

    // contradiction_flagged: page declares contested: true OR
    // non-empty contradictions: frontmatter. Trust-breaking: an agent
    // reading this page without seeing the flag will pick a side
    // without knowing there's a fight.
    if (allowedSet.has("contradiction_flagged")) {
      const contested = (page.frontmatter["contested"] ?? "").toLowerCase();
      const contradictions = (page.frontmatter["contradictions"] ?? "").trim();
      const flagged =
        contested === "true" || contested === "yes" || contradictions.length > 0;
      if (flagged) {
        findings.push({
          kind: "contradiction_flagged",
          severity: "error",
          path: page.relPath,
          message: contradictions.length > 0
            ? `Page declares ${contradictions.split(/\s+/).length} contradiction(s) in frontmatter`
            : "Page is marked contested: true in frontmatter",
          detail: contradictions.length > 0 ? contradictions : "contested",
        });
        totals.contradiction_flagged++;
      }
    }

    // confidence_low: explicit confidence: low/medium OR a page with
    // an empty `sources:` field and only 1 inbound-source reference
    // (best-effort). The empty-sources check is the cheap surrogate
    // for "thin evidence".
    if (allowedSet.has("confidence_low")) {
      const conf = (page.frontmatter["confidence"] ?? "").toLowerCase();
      const sources = (page.frontmatter["sources"] ?? "").trim();
      if (conf === "low" || conf === "medium") {
        findings.push({
          kind: "confidence_low",
          severity: "warn",
          path: page.relPath,
          message: `Page declares confidence: ${conf}`,
          detail: conf,
        });
        totals.confidence_low++;
      } else if (sources === "" || sources === "[]") {
        // Surrogate: no `sources` field at all = agent has no provenance
        // to weight. Surfaced as warn so it's visible in reports but
        // doesn't trip the error tier.
        findings.push({
          kind: "confidence_low",
          severity: "warn",
          path: page.relPath,
          message: "Page has no `sources` frontmatter — agent has no provenance to weight",
        });
        totals.confidence_low++;
      }
    }

    // page_oversize: > oversizeThreshold lines. Pure info — split
    // decisions are content work, not lint work.
    if (allowedSet.has("page_oversize")) {
      if (page.lineCount > oversizeThreshold) {
        findings.push({
          kind: "page_oversize",
          severity: "info",
          path: page.relPath,
          message: `Page is ${page.lineCount} lines (threshold: ${oversizeThreshold})`,
          detail: String(page.lineCount),
        });
        totals.page_oversize++;
      }
    }

    // tag_audit: tag listed in `tags:` frontmatter that isn't in
    // SCHEMA.md's backtick-tag list. If SCHEMA.md is missing, skip
    // silently (a missing taxonomy isn't a tag violation).
    if (allowedSet.has("tag_audit") && allowedTags) {
      for (const tag of page.tags) {
        if (!allowedTags.has(tag)) {
          findings.push({
            kind: "tag_audit",
            severity: "info",
            path: page.relPath,
            message: `Tag '${tag}' is not in the SCHEMA.md taxonomy`,
            detail: tag,
          });
          totals.tag_audit++;
        }
      }
    }
  }

  // source_drift: per-tracked-source in manifest, recompute sha256
  // and compare. Trust-breaking (error): downstream pages silently
  // lie about facts. Skipped if manifest absent or unreadable.
  if (allowedSet.has("source_drift") && manifest?.sources) {
    for (const [rawPath, entry] of Object.entries(manifest.sources)) {
      const expected = entry.sha256;
      if (!expected) continue; // v1 entry, no sha256 recorded; skip silently
      const abs = join(root, rawPath);
      let actual: string | null = null;
      try {
        const buf = await fs.readFile(abs);
        actual = sha256OfBuffer(buf);
      } catch {
        // File missing — surface as drift (the source was tracked and
        // is now gone).
        findings.push({
          kind: "source_drift",
          severity: "error",
          path: rawPath,
          message: `Tracked source is missing (manifest expected sha256 ${expected.slice(0, 12)}…)`,
          detail: "missing",
        });
        totals.source_drift++;
        continue;
      }
      if (actual !== expected) {
        findings.push({
          kind: "source_drift",
          severity: "error",
          path: rawPath,
          message: `sha256 mismatch: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
          detail: `${expected.slice(0, 12)}->${actual.slice(0, 12)}`,
        });
        totals.source_drift++;
      }
    }
  }

  // log_rotation_due: log.md > logRotThreshold lines. Pure info —
  // rotation is a separate project.
  if (allowedSet.has("log_rotation_due")) {
    const logPath = join(root, tenantId, "log.md");
    try {
      const logText = await fs.readFile(logPath, "utf8");
      const lc = countLines(logText);
      if (lc > logRotThreshold) {
        findings.push({
          kind: "log_rotation_due",
          severity: "info",
          path: "log.md",
          message: `log.md is ${lc} lines (threshold: ${logRotThreshold})`,
          detail: String(lc),
        });
        totals.log_rotation_due++;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  // Stable per-run id: a sha256 of the canonicalized finding set.
  // Diffing runId surfaces "nothing changed" cheaply and gives the
  // /lint/diff route a stable handle.
  const runId = makeRunId(findings);

  return {
    tenantId,
    ranAt: new Date().toISOString(),
    runId,
    pageCount: snapshot.pages.length,
    findings,
    totals,
    executed: ALL_LINT_KINDS.filter((k) => allowedSet.has(k)),
  };
}
