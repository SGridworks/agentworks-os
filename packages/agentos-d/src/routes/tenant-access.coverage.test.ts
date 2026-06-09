import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE_DIR = new URL(".", import.meta.url);

function source(file: string): string {
  return readFileSync(join(ROUTE_DIR.pathname, file), "utf8");
}

function countCalls(text: string, fnName: string): number {
  return text.match(new RegExp(`${fnName}\\(`, "g"))?.length ?? 0;
}

describe("tenant-scoped route coverage", () => {
  it.each([
    { file: "memory.ts", minTenantChecks: 15 },
    { file: "mcp.ts", minTenantChecks: 7 },
    { file: "approval-queue.ts", minTenantChecks: 4 },
    { file: "dispatch.ts", minTenantChecks: 7 },
    { file: "compliance.ts", minTenantChecks: 2 },
  ])("$file calls assertTenantAllowed at each tenant-scoped surface", ({ file, minTenantChecks }) => {
    const text = source(file);
    expect(text).toContain("assertTenantAllowed");
    expect(countCalls(text, "assertTenantAllowed")).toBeGreaterThanOrEqual(minTenantChecks);
  });
});
