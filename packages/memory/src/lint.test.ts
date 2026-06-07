/**
 * Vault-lint tests.
 *
 *   - orphan_page: a page with no inbound wikilinks (and not whitelisted)
 *   - dead_link: an outbound wikilink whose target page does not exist
 *   - frontmatter_gap: required field missing or empty
 *   - empty_section: heading with no content beneath it
 *   - kebab_case_violation: filename slug not kebab-case
 *   - whitelist suppresses orphan + kebab checks for README.md / index.md
 *   - tenant isolation: lint(A) ignores B's pages
 *
 * Phase 3 (LLM-Wiki v2):
 *   - source_drift: sha256 mismatch on a manifest-tracked source
 *   - contradiction_flagged: page has contested: true or non-empty
 *     contradictions: frontmatter
 *   - confidence_low: explicit confidence: low/medium OR empty sources
 *   - page_oversize: page > threshold lines
 *   - tag_audit: tag not in SCHEMA.md backtick-tag list
 *   - log_rotation_due: log.md > threshold lines
 *
 * The 5 originally-shipped kinds keep their existing severities so
 * stored reports don't churn.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { lintVault } from "./lint.js";

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

let root: string;

function seed(rel: string, body: string): void {
  const abs = join(root, TENANT_A, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "awo-lint-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("lintVault", () => {
  it("flags orphan pages (no inbound wikilinks)", async () => {
    seed("alpha.md", `---\ntitle: alpha\ntype: note\n---\n\nlinks to [[beta]]\n`);
    seed("beta.md", `---\ntitle: beta\ntype: note\n---\n\nbody\n`);
    seed("orphan.md", `---\ntitle: orphan\ntype: note\n---\n\nbody\n`);

    const r = await lintVault(root, TENANT_A);
    const orphans = r.findings.filter((f) => f.kind === "orphan_page");
    const slugs = orphans.map((f) => f.path.replace(".md", ""));
    expect(slugs).toContain("orphan");
    expect(slugs).toContain("alpha"); // alpha has no inbound either
    expect(slugs).not.toContain("beta"); // beta is linked from alpha
  });

  it("flags dead wikilinks (target page missing)", async () => {
    seed(
      "page.md",
      `---\ntitle: page\ntype: note\n---\n\nrefs [[exists]] and [[missing]] and [[also-gone|alias]]\n`,
    );
    seed("exists.md", `---\ntitle: exists\ntype: note\n---\n\nbody\n`);

    const r = await lintVault(root, TENANT_A);
    const dead = r.findings
      .filter((f) => f.kind === "dead_link")
      .map((f) => f.message);
    expect(dead.some((m) => m.includes("[[missing]]"))).toBe(true);
    expect(dead.some((m) => m.includes("[[also-gone]]"))).toBe(true);
    expect(dead.some((m) => m.includes("[[exists]]"))).toBe(false);
  });

  it("flags missing frontmatter fields", async () => {
    seed("good.md", `---\ntitle: good\ntype: note\n---\n\nbody\n`);
    seed("bad.md", `---\ntitle: \n---\n\nbody\n`);
    seed("worse.md", `no frontmatter at all\n`);

    const r = await lintVault(root, TENANT_A);
    const gaps = r.findings.filter((f) => f.kind === "frontmatter_gap");
    expect(gaps.find((f) => f.path === "bad.md" && f.message.includes("title"))).toBeDefined();
    expect(gaps.find((f) => f.path === "bad.md" && f.message.includes("type"))).toBeDefined();
    expect(gaps.find((f) => f.path === "worse.md" && f.message.includes("title"))).toBeDefined();
    expect(gaps.find((f) => f.path === "good.md")).toBeUndefined();
  });

  it("flags empty sections (heading with no content)", async () => {
    seed(
      "page.md",
      `---\ntitle: page\ntype: note\n---\n\n## Has Content\nlorem\n\n## Empty\n\n## Another\nipsum\n`,
    );

    const r = await lintVault(root, TENANT_A);
    const empties = r.findings
      .filter((f) => f.kind === "empty_section")
      .map((f) => f.message);
    expect(empties.some((m) => m.includes("Empty"))).toBe(true);
    expect(empties.some((m) => m.includes("Has Content"))).toBe(false);
    expect(empties.some((m) => m.includes("Another"))).toBe(false);
  });

  it("flags kebab-case violations", async () => {
    seed("good-name.md", `---\ntitle: ok\ntype: note\n---\n\nbody\n`);
    seed("BadName.md", `---\ntitle: bad\ntype: note\n---\n\nbody\n`);
    seed("snake_case.md", `---\ntitle: snake\ntype: note\n---\n\nbody\n`);

    const r = await lintVault(root, TENANT_A);
    const violations = r.findings
      .filter((f) => f.kind === "kebab_case_violation")
      .map((f) => f.path);
    expect(violations).toContain("BadName.md");
    expect(violations).toContain("snake_case.md");
    expect(violations).not.toContain("good-name.md");
  });

  it("whitelist suppresses orphan + kebab checks for README.md and index.md", async () => {
    seed("README.md", `---\ntitle: readme\ntype: meta\n---\n\nentry\n`);
    seed("index.md", `---\ntitle: index\ntype: meta\n---\n\nentry\n`);

    const r = await lintVault(root, TENANT_A);
    const orphans = r.findings.filter((f) => f.kind === "orphan_page").map((f) => f.path);
    const kebab = r.findings.filter((f) => f.kind === "kebab_case_violation").map((f) => f.path);
    expect(orphans).not.toContain("README.md");
    expect(orphans).not.toContain("index.md");
    expect(kebab).not.toContain("README.md");
    expect(kebab).not.toContain("index.md");
  });

  it("tenant isolation — lint(A) does not see B's pages", async () => {
    seed("a-only.md", `---\ntitle: a\ntype: note\n---\n\nbody\n`);
    // Drop a file under tenant B with a deliberately-bad name; lint(A) must ignore it.
    const bDir = join(root, TENANT_B);
    mkdirSync(bDir, { recursive: true });
    writeFileSync(join(bDir, "BadInB.md"), `---\ntitle: b\ntype: note\n---\n\nbody\n`, "utf8");

    const ra = await lintVault(root, TENANT_A);
    expect(ra.pageCount).toBe(1);
    expect(ra.findings.find((f) => f.path.includes("BadInB"))).toBeUndefined();

    const rb = await lintVault(root, TENANT_B);
    expect(rb.pageCount).toBe(1);
    expect(rb.findings.find((f) => f.kind === "kebab_case_violation")).toBeDefined();
  });

  it("returns totals matching the findings array", async () => {
    seed("Bad_Name.md", `---\ntitle: bad\n---\n\n## Empty\n\n[[ghost]]\n`);

    const r = await lintVault(root, TENANT_A);
    let sum = 0;
    for (const k of Object.keys(r.totals) as Array<keyof typeof r.totals>) {
      sum += r.totals[k];
    }
    expect(sum).toBe(r.findings.length);
    expect(r.tenantId).toBe(TENANT_A);
    expect(r.ranAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("missing tenant directory returns zero pages without throwing", async () => {
    const r = await lintVault(root, "99999999-9999-9999-9999-999999999999");
    expect(r.pageCount).toBe(0);
    expect(r.findings).toEqual([]);
  });

  it("respects custom requiredFrontmatter list", async () => {
    seed("page.md", `---\ntitle: t\ntype: note\n---\n\nbody\n`);

    const r = await lintVault(root, TENANT_A, { requiredFrontmatter: ["title", "owner"] });
    const gaps = r.findings.filter((f) => f.kind === "frontmatter_gap");
    expect(gaps.find((f) => f.message.includes("owner"))).toBeDefined();
    expect(gaps.find((f) => f.message.includes("title"))).toBeUndefined();
  });
});

describe("lintVault — Phase 3 (LLM-Wiki v2 checks)", () => {
  it("contradiction_flagged: contested: true surfaces as error", async () => {
    seed("contested.md", `---\ntitle: c\ntype: note\ncontested: true\n---\n\nbody\n`);
    const r = await lintVault(root, TENANT_A);
    const f = r.findings.find((x) => x.kind === "contradiction_flagged");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error");
    expect(f!.path).toBe("contested.md");
  });

  it("contradiction_flagged: non-empty contradictions: frontmatter surfaces as error", async () => {
    seed(
      "fighting.md",
      `---\ntitle: f\ntype: note\ncontradictions: "[[a]] says X, [[b]] says Y"\n---\n\nbody\n`,
    );
    const r = await lintVault(root, TENANT_A);
    const f = r.findings.find((x) => x.kind === "contradiction_flagged");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error");
    expect(f!.detail).toContain("[[a]]");
  });

  it("contradiction_flagged: absent on a normal page", async () => {
    seed("normal.md", `---\ntitle: n\ntype: note\n---\n\nbody\n`);
    const r = await lintVault(root, TENANT_A);
    expect(r.findings.find((x) => x.kind === "contradiction_flagged")).toBeUndefined();
  });

  it("confidence_low: explicit confidence: low surfaces as warn", async () => {
    seed("thin.md", `---\ntitle: t\ntype: note\nconfidence: low\n---\n\nbody\n`);
    const r = await lintVault(root, TENANT_A);
    const f = r.findings.find((x) => x.kind === "confidence_low");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warn");
    expect(f!.detail).toBe("low");
  });

  it("confidence_low: empty sources field surfaces as warn (provenance gap)", async () => {
    seed("orphan-source.md", `---\ntitle: t\ntype: note\nsources: []\n---\n\nbody\n`);
    const r = await lintVault(root, TENANT_A);
    const f = r.findings.find((x) => x.kind === "confidence_low");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warn");
    expect(f!.message).toMatch(/no `sources`/);
  });

  it("page_oversize: page above threshold surfaces as info with line count", async () => {
    const body =
      `---\ntitle: b\ntype: note\n---\n\n` + Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n";
    seed("big.md", body);
    const r = await lintVault(root, TENANT_A, { pageOversizeLines: 30 });
    const f = r.findings.find((x) => x.kind === "page_oversize");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("info");
    expect(f!.detail).toBe("51"); // body lines: header(3) + blank(1) + 50 = 54, but trim trailing
  });

  it("page_oversize: not flagged below threshold", async () => {
    seed("small.md", `---\ntitle: s\ntype: note\n---\n\nbody\n`);
    const r = await lintVault(root, TENANT_A, { pageOversizeLines: 200 });
    expect(r.findings.find((x) => x.kind === "page_oversize")).toBeUndefined();
  });

  it("tag_audit: tag in SCHEMA.md is accepted; tag not in SCHEMA.md is flagged", async () => {
    // SCHEMA.md lives at <root>/wiki/SCHEMA.md by default.
    const schemaDir = join(root, "wiki");
    mkdirSync(schemaDir, { recursive: true });
    writeFileSync(join(schemaDir, "SCHEMA.md"), "Allowed tags: `#project` `#infra`\n", "utf8");

    seed("tagged.md", `---\ntitle: t\ntype: note\ntags: [project, banana]\n---\n\nbody\n`);
    const r = await lintVault(root, TENANT_A);
    const flagged = r.findings.filter((x) => x.kind === "tag_audit");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.detail).toBe("banana");
    expect(flagged[0]!.severity).toBe("info");
  });

  it("tag_audit: skipped silently if SCHEMA.md missing", async () => {
    seed("tagged.md", `---\ntitle: t\ntype: note\ntags: [banana]\n---\n\nbody\n`);
    // No SCHEMA.md written.
    const r = await lintVault(root, TENANT_A);
    expect(r.findings.find((x) => x.kind === "tag_audit")).toBeUndefined();
  });

  it("source_drift: missing file is reported as drift (error)", async () => {
    const manifest = {
      sources: {
        "raw-sources/articles/missing.md": {
          sha256: sha256(Buffer.from("payload")),
          bytes: 7,
        },
      },
    };
    writeFileSync(join(root, ".manifest.json"), JSON.stringify(manifest), "utf8");

    const r = await lintVault(root, TENANT_A);
    const f = r.findings.find((x) => x.kind === "source_drift");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error");
    expect(f!.detail).toBe("missing");
  });

  it("source_drift: changed file is reported as drift (error) with truncated hashes", async () => {
    const realFile = join(root, "raw-sources", "doc.md");
    mkdirSync(join(root, "raw-sources"), { recursive: true });
    writeFileSync(realFile, "original content", "utf8");
    const manifest = {
      sources: {
        "raw-sources/doc.md": { sha256: sha256(Buffer.from("ORIGINAL")), bytes: 9 },
      },
    };
    writeFileSync(join(root, ".manifest.json"), JSON.stringify(manifest), "utf8");

    const r = await lintVault(root, TENANT_A);
    const f = r.findings.find((x) => x.kind === "source_drift");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error");
    expect(f!.message).toMatch(/sha256 mismatch/);
  });

  it("source_drift: unchanged file is NOT reported", async () => {
    const realFile = join(root, "raw-sources", "doc.md");
    mkdirSync(join(root, "raw-sources"), { recursive: true });
    const content = "stable content";
    writeFileSync(realFile, content, "utf8");
    const manifest = {
      sources: {
        "raw-sources/doc.md": { sha256: sha256(Buffer.from(content)), bytes: content.length },
      },
    };
    writeFileSync(join(root, ".manifest.json"), JSON.stringify(manifest), "utf8");

    const r = await lintVault(root, TENANT_A);
    expect(r.findings.find((x) => x.kind === "source_drift")).toBeUndefined();
  });

  it("log_rotation_due: log.md above threshold surfaces as info with line count", async () => {
    const longLog = Array.from({ length: 12 }, (_, i) => `- entry ${i}`).join("\n") + "\n";
    mkdirSync(join(root, TENANT_A), { recursive: true });
    writeFileSync(join(root, TENANT_A, "log.md"), longLog, "utf8");

    const r = await lintVault(root, TENANT_A, { logRotationLines: 10 });
    const f = r.findings.find((x) => x.kind === "log_rotation_due");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("info");
    expect(f!.detail).toBe("12");
  });

  it("log_rotation_due: no log.md is not flagged", async () => {
    const r = await lintVault(root, TENANT_A, { logRotationLines: 1 });
    expect(r.findings.find((x) => x.kind === "log_rotation_due")).toBeUndefined();
  });

  it("checks filter limits which kinds are executed", async () => {
    seed("contested.md", `---\ntitle: c\ntype: note\ncontested: true\n---\n\nbody\n`);
    seed("orphan.md", `---\ntitle: o\ntype: note\n---\n\nbody\n`);

    const r = await lintVault(root, TENANT_A, {
      checks: ["contradiction_flagged"],
    });
    expect(r.findings.find((x) => x.kind === "contradiction_flagged")).toBeDefined();
    expect(r.findings.find((x) => x.kind === "orphan_page")).toBeUndefined();
    expect(r.executed).toEqual(["contradiction_flagged"]);
  });

  it("runId is stable across identical inputs", async () => {
    seed("a.md", `---\ntitle: a\ntype: note\n---\n\nbody\n`);
    const r1 = await lintVault(root, TENANT_A);
    const r2 = await lintVault(root, TENANT_A);
    expect(r1.runId).toBe(r2.runId);
    expect(r1.runId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("runId changes when a finding is added (severity-promoted page)", async () => {
    seed("contested.md", `---\ntitle: c\ntype: note\ncontested: true\n---\n\nbody\n`);
    const r1 = await lintVault(root, TENANT_A, { checks: ["contradiction_flagged"] });
    // Add a second contested page — should change the runId.
    seed("contested-2.md", `---\ntitle: c2\ntype: note\ncontested: true\n---\n\nbody\n`);
    const r2 = await lintVault(root, TENANT_A, { checks: ["contradiction_flagged"] });
    expect(r1.runId).not.toBe(r2.runId);
  });
});
