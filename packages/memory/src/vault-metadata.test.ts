import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VaultMetadataIndex,
  parseVaultMarkdown,
  renderVaultMarkdown,
} from "./vault-metadata.js";
import { FileVaultStore } from "./file-store.js";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";

describe("vault metadata", () => {
  it("parses YAML frontmatter with arrays, nested maps, quoted strings, dates, and unknown keys", () => {
    const parsed = parseVaultMarkdown(`---
title: "Alpha Note"
tags:
  - ops
  - release
nested:
  owner: "agent"
date: 2026-06-06
customUnknown: keep-me
---
Body text.
`);

    expect(parsed.frontmatter.title).toBe("Alpha Note");
    expect(parsed.frontmatter.tags).toEqual(["ops", "release"]);
    expect(parsed.frontmatter.nested).toEqual({ owner: "agent" });
    expect(parsed.frontmatter.date).toBeInstanceOf(Date);
    expect(parsed.frontmatter.customUnknown).toBe("keep-me");

    const rendered = renderVaultMarkdown({
      frontmatter: { ...parsed.frontmatter, summary: "Added later" },
      body: parsed.body,
    });
    const reparsed = parseVaultMarkdown(rendered);
    expect(reparsed.frontmatter.customUnknown).toBe("keep-me");
    expect(reparsed.frontmatter.summary).toBe("Added later");
  });

  it("reports malformed frontmatter without dropping the markdown body", () => {
    const parsed = parseVaultMarkdown(`---
title: [unterminated
---
Body stays readable.
`);

    expect(parsed.frontmatterError).toMatch(/missed comma|unexpected|bad indentation|end of the stream/i);
    expect(parsed.body).toContain("Body stays readable.");
  });

  it("extracts links, aliases, embeds, headings, block refs, duplicate slugs, and unresolved links", async () => {
    const root = mkdtempSync(join(tmpdir(), "awo-vault-index-"));
    try {
      const tenantRoot = join(root, TENANT_ID);
      mkdirSync(join(tenantRoot, "folder"), { recursive: true });
      mkdirSync(join(tenantRoot, "other"), { recursive: true });
      writeFileSync(
        join(tenantRoot, "alpha.md"),
        `---
title: Alpha
aliases:
  - Entry
tags: [ops]
---
# Top
Links to [[folder/beta#Details|Beta details]], [[Entry]], [[ghost]], and ![[missing-asset]].
Same page [[#Top]] and block [[folder/beta#^b1]].
`,
      );
      writeFileSync(
        join(tenantRoot, "folder", "beta.md"),
        `---
title: Beta
---
# Details
Paragraph ^b1

#field
`,
      );
      writeFileSync(
        join(tenantRoot, "other", "beta.md"),
        `---
title: Other Beta
---
Duplicate slug.
`,
      );

      const index = await VaultMetadataIndex.build(root, TENANT_ID, { includeConfigAudit: false });
      const snapshot = index.toJSON();
      expect(snapshot.pageCount).toBe(3);
      expect(snapshot.duplicateSlugs).toEqual([{ slug: "beta", paths: ["folder/beta.md", "other/beta.md"] }]);
      expect(snapshot.tags.map((tag) => tag.tag)).toEqual(["field", "ops"]);
      expect(snapshot.unresolvedLinks.map((link) => link.raw).sort()).toEqual(["ghost", "missing-asset"]);

      const beta = snapshot.pages.find((page) => page.key === "folder/beta");
      expect(beta?.headings[0]?.text).toBe("Details");
      expect(beta?.blockRefs).toEqual(["b1"]);
      expect(beta?.backlinks).toEqual(["alpha"]);

      const headingLink = snapshot.links.find((link) => link.target === "folder/beta" && link.heading === "Details");
      expect(headingLink?.targetKey).toBe("folder/beta");
      expect(headingLink?.heading).toBe("Details");

      const aliasLink = snapshot.links.find((link) => link.raw === "Entry");
      expect(aliasLink?.targetKey).toBe("alpha");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves unknown frontmatter keys through FileVaultStore writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "awo-vault-roundtrip-"));
    try {
      const tenantRoot = join(root, TENANT_ID);
      mkdirSync(tenantRoot, { recursive: true });
      writeFileSync(
        join(tenantRoot, "page.md"),
        `---
customUnknown: keep-me
nested:
  owner: agent
---
Initial body.
`,
      );

      const store = new FileVaultStore({ root });
      await store.write(TENANT_ID, "page", "Updated body.", {
        summary: "New summary",
      });

      const raw = readFileSync(join(tenantRoot, "page.md"), "utf8");
      const parsed = parseVaultMarkdown(raw);
      expect(parsed.frontmatter.customUnknown).toBe("keep-me");
      expect(parsed.frontmatter.nested).toEqual({ owner: "agent" });
      expect(parsed.frontmatter.summary).toBe("New summary");
      expect(parsed.body).toBe("Updated body.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
