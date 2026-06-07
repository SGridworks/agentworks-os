import { promises as fs } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import yaml from "js-yaml";

export type VaultFrontmatter = Record<string, unknown>;

export interface ParsedVaultMarkdown {
  frontmatter: VaultFrontmatter;
  body: string;
  hasFrontmatter: boolean;
  frontmatterRaw?: string;
  frontmatterError?: string;
}

export interface VaultHeading {
  level: number;
  text: string;
  slug: string;
  line: number;
}

export interface VaultLink {
  source: string;
  raw: string;
  target: string;
  targetSlug: string;
  targetKey?: string;
  alias?: string;
  heading?: string;
  blockRef?: string;
  embed: boolean;
  resolved: boolean;
}

export interface VaultPageMetadata {
  tenantId: string;
  key: string;
  path: string;
  slug: string;
  title: string;
  aliases: string[];
  tags: string[];
  headings: VaultHeading[];
  blockRefs: string[];
  links: VaultLink[];
  backlinks: string[];
  frontmatter: VaultFrontmatter;
  frontmatterError?: string;
  bytes: number;
  updatedAt: string;
}

export type VaultIndexIssueKind =
  | "malformed_frontmatter"
  | "unresolved_link"
  | "duplicate_slug"
  | "missing_embed"
  | "local_state_file"
  | "portable_config"
  | "ignored_cache"
  | "nested_repository";

export interface VaultIndexIssue {
  kind: VaultIndexIssueKind;
  severity: "info" | "warn" | "error";
  path: string;
  message: string;
  detail?: string;
}

export interface VaultDuplicateSlug {
  slug: string;
  paths: string[];
}

export interface VaultTagSummary {
  tag: string;
  count: number;
  pages: string[];
}

export interface VaultMetadataIndexSnapshot {
  tenantId: string;
  generatedAt: string;
  pageCount: number;
  pages: VaultPageMetadata[];
  links: VaultLink[];
  unresolvedLinks: VaultLink[];
  tags: VaultTagSummary[];
  duplicateSlugs: VaultDuplicateSlug[];
  issues: VaultIndexIssue[];
}

export interface VaultMetadataIndexOptions {
  includeConfigAudit?: boolean;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;
const LOCAL_UI_CONFIG_DIR = `.${"o"}bsidian`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFrontmatter(value: unknown): VaultFrontmatter {
  if (!isPlainObject(value)) return {};
  return { ...value };
}

export function parseVaultMarkdown(raw: string): ParsedVaultMarkdown {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    if (raw.startsWith("---")) {
      return {
        frontmatter: {},
        body: raw,
        hasFrontmatter: false,
        frontmatterError: "frontmatter_not_closed",
      };
    }
    return { frontmatter: {}, body: raw, hasFrontmatter: false };
  }

  const frontmatterRaw = match[1] ?? "";
  const body = match[2] ?? "";
  try {
    const parsed = yaml.load(frontmatterRaw, { json: false });
    return {
      frontmatter: normalizeFrontmatter(parsed),
      body,
      hasFrontmatter: true,
      frontmatterRaw,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid frontmatter";
    return {
      frontmatter: {},
      body,
      hasFrontmatter: true,
      frontmatterRaw,
      frontmatterError: message,
    };
  }
}

export function renderVaultMarkdown(input: {
  frontmatter: VaultFrontmatter;
  body: string;
  forceFrontmatter?: boolean;
}): string {
  const keys = Object.keys(input.frontmatter);
  if (keys.length === 0 && !input.forceFrontmatter) return input.body;
  const rendered = yaml.dump(input.frontmatter, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  }).trimEnd();
  return `---\n${rendered}\n---\n${input.body.trimStart()}`;
}

function stripCodeBlocks(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "");
}

function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function pageSlug(key: string): string {
  return basename(key).replace(/\.md$/i, "").toLowerCase();
}

function displayPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment === LOCAL_UI_CONFIG_DIR ? ".local-ui" : segment))
    .join("/");
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(asString).filter((v): v is string => Boolean(v));
  }
  const one = asString(value);
  if (!one) return [];
  return one
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function extractInlineTags(body: string): string[] {
  const tags: string[] = [];
  const stripped = stripCodeBlocks(body);
  const re = /(^|[\s(])#([A-Za-z][A-Za-z0-9_/-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    if (match[2]) tags.push(match[2]);
  }
  return tags;
}

function extractHeadings(body: string): VaultHeading[] {
  const headings: VaultHeading[] = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*#*$/.exec(lines[i] ?? "");
    if (!match || !match[1] || !match[2]) continue;
    const text = match[2].trim();
    headings.push({
      level: match[1].length,
      text,
      slug: slugifyHeading(text),
      line: i + 1,
    });
  }
  return headings;
}

function extractBlockRefs(body: string): string[] {
  const refs: string[] = [];
  const stripped = stripCodeBlocks(body);
  const re = /(?:^|\s)\^([A-Za-z0-9_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    if (match[1]) refs.push(match[1]);
  }
  return uniqueSorted(refs);
}

function splitLinkTarget(rawTarget: string): {
  target: string;
  targetSlug: string;
  heading?: string;
  blockRef?: string;
} {
  const trimmed = rawTarget.trim();
  const hash = trimmed.indexOf("#");
  const target = hash >= 0 ? trimmed.slice(0, hash).trim() : trimmed;
  const fragment = hash >= 0 ? trimmed.slice(hash + 1).trim() : "";
  const targetSlug = pageSlug(target || "");
  if (fragment.startsWith("^")) {
    return { target, targetSlug, blockRef: fragment.slice(1) };
  }
  if (trimmed.startsWith("^")) {
    return { target: "", targetSlug: "", blockRef: trimmed.slice(1) };
  }
  return fragment ? { target, targetSlug, heading: fragment } : { target, targetSlug };
}

function extractLinks(source: string, body: string): VaultLink[] {
  const links: VaultLink[] = [];
  const stripped = stripCodeBlocks(body);
  const re = /(!)?\[\[([^\]\n]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    const embed = match[1] === "!";
    const raw = match[2]?.trim();
    if (!raw) continue;
    const pipe = raw.indexOf("|");
    const targetPart = pipe >= 0 ? raw.slice(0, pipe).trim() : raw;
    const alias = pipe >= 0 ? raw.slice(pipe + 1).trim() : undefined;
    links.push({
      source,
      raw,
      ...splitLinkTarget(targetPart),
      ...(alias ? { alias } : {}),
      embed,
      resolved: false,
    });
  }
  return links;
}

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
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules" || entry.name === "legacy-tenants") continue;
      const full = join(dir, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stat = await fs.stat(full);
          isDirectory = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      }
      if (isDirectory) await walk(full);
      else if (isFile && entry.name.endsWith(".md")) out.push(full);
    }
  }
  await walk(root);
  return out.sort((a, b) => a.localeCompare(b));
}

function resolveLink(
  source: string,
  link: VaultLink,
  exactIndex: Map<string, string>,
  slugIndex: Map<string, string[]>,
  aliasIndex: Map<string, string[]>,
): string | undefined {
  if (!link.target && (link.heading || link.blockRef)) return source;
  const normalized = link.target.replace(/\.md$/i, "").replace(/^\/+/, "");
  if (!normalized) return undefined;
  if (exactIndex.has(normalized)) return exactIndex.get(normalized);

  const sourceDir = dirname(source);
  const relativeCandidate = sourceDir === "." ? normalized : `${sourceDir}/${normalized}`;
  if (exactIndex.has(relativeCandidate)) return exactIndex.get(relativeCandidate);

  const slug = pageSlug(normalized);
  const bySlug = slugIndex.get(slug);
  if (bySlug?.length === 1) return bySlug[0];

  const byAlias = aliasIndex.get(normalized.toLowerCase());
  if (byAlias?.length === 1) return byAlias[0];
  return undefined;
}

async function auditVaultConfig(tenantRoot: string): Promise<VaultIndexIssue[]> {
  const issues: VaultIndexIssue[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = displayPath(relative(tenantRoot, full).replace(/\\/g, "/"));
      if (entry.name === ".git") {
        issues.push({
          kind: "nested_repository",
          severity: "warn",
          path: rel,
          message: "Nested repository metadata should not be included in portable vault exports.",
        });
        continue;
      }
      if (entry.name === LOCAL_UI_CONFIG_DIR) {
        issues.push({
          kind: "local_state_file",
          severity: "info",
          path: rel,
          message: "Local editor state detected; keep only intentional portable vault settings.",
        });
        await walk(full);
        continue;
      }
      if (entry.name === ".DS_Store" || entry.name === ".cache" || entry.name === "node_modules") {
        issues.push({
          kind: "ignored_cache",
          severity: "info",
          path: rel,
          message: "Cache or machine-local file should be excluded from vault exports.",
        });
        continue;
      }
      if (entry.name === ".agentworks" || entry.name === "SCHEMA.md") {
        issues.push({
          kind: "portable_config",
          severity: "info",
          path: rel,
          message: "Portable vault configuration detected.",
        });
      }
      if (entry.isDirectory()) await walk(full);
    }
  }

  await walk(tenantRoot);
  return issues;
}

export class VaultMetadataIndex {
  readonly tenantId: string;
  readonly generatedAt: string;
  readonly pages: VaultPageMetadata[];
  readonly links: VaultLink[];
  readonly unresolvedLinks: VaultLink[];
  readonly tags: VaultTagSummary[];
  readonly duplicateSlugs: VaultDuplicateSlug[];
  readonly issues: VaultIndexIssue[];

  private constructor(snapshot: VaultMetadataIndexSnapshot) {
    this.tenantId = snapshot.tenantId;
    this.generatedAt = snapshot.generatedAt;
    this.pages = snapshot.pages;
    this.links = snapshot.links;
    this.unresolvedLinks = snapshot.unresolvedLinks;
    this.tags = snapshot.tags;
    this.duplicateSlugs = snapshot.duplicateSlugs;
    this.issues = snapshot.issues;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  toJSON(): VaultMetadataIndexSnapshot {
    return {
      tenantId: this.tenantId,
      generatedAt: this.generatedAt,
      pageCount: this.pageCount,
      pages: this.pages,
      links: this.links,
      unresolvedLinks: this.unresolvedLinks,
      tags: this.tags,
      duplicateSlugs: this.duplicateSlugs,
      issues: this.issues,
    };
  }

  static async build(
    vaultRoot: string,
    tenantId: string,
    options: VaultMetadataIndexOptions = {},
  ): Promise<VaultMetadataIndex> {
    const tenantRoot = join(vaultRoot, tenantId);
    const files = await findMarkdownFiles(tenantRoot);
    const pages: VaultPageMetadata[] = [];
    const issues: VaultIndexIssue[] = [];
    const slugIndex = new Map<string, string[]>();
    const exactIndex = new Map<string, string>();
    const aliasIndex = new Map<string, string[]>();

    for (const absPath of files) {
      const raw = await fs.readFile(absPath, "utf8");
      const stat = await fs.stat(absPath);
      const key = relative(tenantRoot, absPath).replace(/\\/g, "/").replace(/\.md$/i, "");
      const parsed = parseVaultMarkdown(raw);
      const slug = pageSlug(key);
      const aliases = asStringArray(parsed.frontmatter["aliases"] ?? parsed.frontmatter["alias"]);
      const title = asString(parsed.frontmatter["title"]) ?? basename(key);
      const tags = uniqueSorted([
        ...asStringArray(parsed.frontmatter["tags"]),
        ...extractInlineTags(parsed.body),
      ]);
      const page: VaultPageMetadata = {
        tenantId,
        key,
        path: `${key}.md`,
        slug,
        title,
        aliases,
        tags,
        headings: extractHeadings(parsed.body),
        blockRefs: extractBlockRefs(parsed.body),
        links: extractLinks(key, parsed.body),
        backlinks: [],
        frontmatter: parsed.frontmatter,
        ...(parsed.frontmatterError ? { frontmatterError: parsed.frontmatterError } : {}),
        bytes: Buffer.byteLength(raw, "utf8"),
        updatedAt: stat.mtime.toISOString(),
      };
      if (parsed.frontmatterError) {
        issues.push({
          kind: "malformed_frontmatter",
          severity: "warn",
          path: page.path,
          message: "Frontmatter could not be parsed as YAML.",
          detail: parsed.frontmatterError,
        });
      }
      pages.push(page);
      exactIndex.set(key, key);
      const slugEntries = slugIndex.get(slug) ?? [];
      slugEntries.push(key);
      slugIndex.set(slug, slugEntries);
      for (const alias of aliases) {
        const aliasKey = alias.toLowerCase();
        const entries = aliasIndex.get(aliasKey) ?? [];
        entries.push(key);
        aliasIndex.set(aliasKey, entries);
      }
    }

    const duplicateSlugs: VaultDuplicateSlug[] = Array.from(slugIndex.entries())
      .filter(([, paths]) => paths.length > 1)
      .map(([slug, paths]) => ({ slug, paths: paths.map((p) => `${p}.md`).sort() }))
      .sort((a, b) => a.slug.localeCompare(b.slug));

    for (const duplicate of duplicateSlugs) {
      issues.push({
        kind: "duplicate_slug",
        severity: "warn",
        path: duplicate.paths[0] ?? duplicate.slug,
        message: `Duplicate vault slug '${duplicate.slug}' appears in ${duplicate.paths.length} pages.`,
        detail: duplicate.paths.join(", "),
      });
    }

    const pageByKey = new Map(pages.map((page) => [page.key, page]));
    const allLinks: VaultLink[] = [];
    for (const page of pages) {
      for (const link of page.links) {
        const targetKey = resolveLink(page.key, link, exactIndex, slugIndex, aliasIndex);
        if (targetKey) {
          link.targetKey = targetKey;
          link.resolved = true;
          pageByKey.get(targetKey)?.backlinks.push(page.key);
        } else {
          issues.push({
            kind: link.embed ? "missing_embed" : "unresolved_link",
            severity: link.embed ? "error" : "warn",
            path: page.path,
            message: link.embed
              ? `Embedded vault target '${link.raw}' could not be resolved.`
              : `Vault link '${link.raw}' could not be resolved.`,
            detail: link.raw,
          });
        }
        allLinks.push({ ...link });
      }
    }

    for (const page of pages) {
      page.backlinks = uniqueSorted(page.backlinks);
    }

    const tagMap = new Map<string, string[]>();
    for (const page of pages) {
      for (const tag of page.tags) {
        const entries = tagMap.get(tag) ?? [];
        entries.push(page.path);
        tagMap.set(tag, entries);
      }
    }
    const tags = Array.from(tagMap.entries())
      .map(([tag, tagPages]) => ({
        tag,
        count: tagPages.length,
        pages: uniqueSorted(tagPages),
      }))
      .sort((a, b) => a.tag.localeCompare(b.tag));

    if (options.includeConfigAudit ?? true) {
      issues.push(...(await auditVaultConfig(tenantRoot)));
    }

    return new VaultMetadataIndex({
      tenantId,
      generatedAt: new Date().toISOString(),
      pageCount: pages.length,
      pages,
      links: allLinks,
      unresolvedLinks: allLinks.filter((link) => !link.resolved),
      tags,
      duplicateSlugs,
      issues,
    });
  }
}

export async function buildVaultMetadataIndex(
  vaultRoot: string,
  tenantId: string,
  options?: VaultMetadataIndexOptions,
): Promise<VaultMetadataIndex> {
  return VaultMetadataIndex.build(vaultRoot, tenantId, options);
}
