import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryRouter } from "./memory.js";
import type { Config } from "../config.js";
import { _resetVaultStoreForTesting } from "./memory.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const AGENT_1 = "704c0f26-757a-4e4d-922f-3695895bc95c";
const AGENT_2 = "8c3e9fa1-4b91-4c2a-9f12-6e8d4f2c1a03";

describe("Memory Routes - Usage Tracking", () => {
  let root: string;
  let originalVaultRoot: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-routes-usage-test-"));
    originalVaultRoot = process.env.VAULT_ROOT;
    process.env.VAULT_ROOT = root;
    _resetVaultStoreForTesting();
  });

  afterEach(() => {
    process.env.VAULT_ROOT = originalVaultRoot;
    _resetVaultStoreForTesting();
    rmSync(root, { recursive: true, force: true });
  });

  it("should track usage when reading with actorId", async () => {
    const router = createMemoryRouter({} as Config);
    
    // First, create a document
    const writeResponse = await fetch("http://localhost:7710/api/memory/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: TENANT_A,
        key: "test-page",
        body: "Test content for usage tracking",
      }),
    });
    
    expect(writeResponse.status).toBe(201);
    
    // Now read it with actorId
    const readResponse = await fetch("http://localhost:7710/api/memory/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: TENANT_A,
        key: "test-page",
        actorId: AGENT_1,
      }),
    });
    
    expect(readResponse.status).toBe(200);
    const readData = await readResponse.json();
    expect(readData.ok).toBe(true);
    expect(readData.data.existed).toBe(true);
    
    // Wait a bit for the usage tracker to flush
    await new Promise(resolve => setTimeout(resolve, 3500));
    
    // Read again to check if lastUsedBy was updated
    const checkResponse = await fetch("http://localhost:7710/api/memory/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: TENANT_A,
        key: "test-page",
      }),
    });
    
    expect(checkResponse.status).toBe(200);
    const checkData = await checkResponse.json();
    expect(checkData.ok).toBe(true);
    
    // The provenance endpoint should show the usage
    const provenanceResponse = await fetch(`http://localhost:7710/api/memory/provenance?tenantId=${TENANT_A}&key=test-page`);
    expect(provenanceResponse.status).toBe(200);
    
    const provenanceData = await provenanceResponse.json();
    expect(provenanceData.ok).toBe(true);
    expect(provenanceData.data.frontmatter.lastUsedBy).toBeDefined();
    expect(provenanceData.data.frontmatter.lastUsedBy).toHaveLength(1);
    expect(provenanceData.data.frontmatter.lastUsedBy[0].agentId).toBe(AGENT_1);
  });

  it("should not track usage when reading without actorId", async () => {
    const router = createMemoryRouter({} as Config);
    
    // First, create a document
    const writeResponse = await fetch("http://localhost:7710/api/memory/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: TENANT_A,
        key: "test-page-no-actor",
        body: "Test content without actor tracking",
      }),
    });
    
    expect(writeResponse.status).toBe(201);
    
    // Read it without actorId
    const readResponse = await fetch("http://localhost:7710/api/memory/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: TENANT_A,
        key: "test-page-no-actor",
        // No actorId provided
      }),
    });
    
    expect(readResponse.status).toBe(200);
    
    // Wait a bit for any potential usage tracking
    await new Promise(resolve => setTimeout(resolve, 3500));
    
    // Check provenance - should not have lastUsedBy
    const provenanceResponse = await fetch(`http://localhost:7710/api/memory/provenance?tenantId=${TENANT_A}&key=test-page-no-actor`);
    expect(provenanceResponse.status).toBe(200);
    
    const provenanceData = await provenanceResponse.json();
    expect(provenanceData.ok).toBe(true);
    expect(provenanceData.data.frontmatter.lastUsedBy).toBeUndefined();
  });

  it("should not track usage for non-existent documents", async () => {
    const router = createMemoryRouter({} as Config);
    
    // Try to read a non-existent document with actorId
    const readResponse = await fetch("http://localhost:7710/api/memory/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: TENANT_A,
        key: "non-existent-page",
        actorId: AGENT_1,
      }),
    });
    
    expect(readResponse.status).toBe(200);
    const readData = await readResponse.json();
    expect(readData.ok).toBe(true);
    expect(readData.data.existed).toBe(false);
    
    // Wait a bit for any potential usage tracking
    await new Promise(resolve => setTimeout(resolve, 3500));
    
    // Should not crash or create the document
    const checkResponse = await fetch("http://localhost:7710/api/memory/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: TENANT_A,
        key: "non-existent-page",
      }),
    });
    
    expect(checkResponse.status).toBe(200);
    const checkData = await checkResponse.json();
    expect(checkData.ok).toBe(true);
    expect(checkData.data.existed).toBe(false);
  });

  it("should handle multiple actors reading the same document", async () => {
    const router = createMemoryRouter({} as Config);
    
    // Create a document
    const writeResponse = await fetch("http://localhost:7710/api/memory/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: TENANT_A,
        key: "multi-actor-page",
        body: "Content for multiple actors",
      }),
    });
    
    expect(writeResponse.status).toBe(201);
    
    // Read with first actor
    await fetch("http://localhost:7710/api/memory/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: TENANT_A,
        key: "multi-actor-page",
        actorId: AGENT_1,
      }),
    });
    
    // Read with second actor
    await fetch("http://localhost:7710/api/memory/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: TENANT_A,
        key: "multi-actor-page",
        actorId: AGENT_2,
      }),
    });
    
    // Wait for flush
    await new Promise(resolve => setTimeout(resolve, 3500));
    
    // Check provenance
    const provenanceResponse = await fetch(`http://localhost:7710/api/memory/provenance?tenantId=${TENANT_A}&key=multi-actor-page`);
    expect(provenanceResponse.status).toBe(200);
    
    const provenanceData = await provenanceResponse.json();
    expect(provenanceData.ok).toBe(true);
    expect(provenanceData.data.frontmatter.lastUsedBy).toBeDefined();
    expect(provenanceData.data.frontmatter.lastUsedBy).toHaveLength(2);
    
    const agentIds = provenanceData.data.frontmatter.lastUsedBy.map((entry: any) => entry.agentId).sort();
    expect(agentIds).toEqual([AGENT_1, AGENT_2].sort());
  });
});