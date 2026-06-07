/**
 * Test provenance stamping functionality in FileVaultStore.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileVaultStore } from "./file-store.js";
import type { VaultWriteOptions } from "./types.js";

describe("FileVaultStore provenance stamping", () => {
  let tmpDir: string;
  let store: FileVaultStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "awo-provenance-test-"));
    store = new FileVaultStore({ root: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stamps lastUpdatedBy and lastUpdatedAt when provided in write options", async () => {
    const tenantId = "test-tenant";
    const key = "test-page";
    const body = "Test content";
    const actorId = "test-actor-123";
    const timestamp = new Date().toISOString();

    const writeOptions: VaultWriteOptions = {
      lastUpdatedBy: actorId,
      lastUpdatedAt: timestamp,
    };

    await store.write(tenantId, key, body, writeOptions);

    const readResult = await store.read(tenantId, key);

    expect(readResult.existed).toBe(true);
    expect(readResult.body).toBe(body);
    expect(readResult.lastUpdatedBy).toBe(actorId);
    expect(readResult.lastUpdatedAt).toBe(timestamp);
  });

  it("preserves existing provenance metadata when not provided in write options", async () => {
    const tenantId = "test-tenant";
    const key = "test-page";
    const initialBody = "Initial content";
    const updatedBody = "Updated content";
    const actorId = "test-actor-123";
    const timestamp = new Date().toISOString();

    // First write with provenance
    const initialOptions: VaultWriteOptions = {
      lastUpdatedBy: actorId,
      lastUpdatedAt: timestamp,
    };

    await store.write(tenantId, key, initialBody, initialOptions);

    // Second write without provenance options (should preserve existing)
    // Note: This behavior might change based on requirements. Currently,
    // the implementation preserves existing metadata when not explicitly provided.
    await store.write(tenantId, key, updatedBody);

    const readResult = await store.read(tenantId, key);

    expect(readResult.existed).toBe(true);
    expect(readResult.body).toBe(updatedBody);
    // The current implementation preserves existing provenance when not provided
    expect(readResult.lastUpdatedBy).toBe(actorId);
    expect(readResult.lastUpdatedAt).toBe(timestamp);
  });

  it("overwrites existing provenance metadata when provided in write options", async () => {
    const tenantId = "test-tenant";
    const key = "test-page";
    const initialBody = "Initial content";
    const updatedBody = "Updated content";
    const initialActorId = "initial-actor-123";
    const updatedActorId = "updated-actor-456";

    // First write with initial provenance
    const initialOptions: VaultWriteOptions = {
      lastUpdatedBy: initialActorId,
      lastUpdatedAt: new Date().toISOString(),
    };

    await store.write(tenantId, key, initialBody, initialOptions);

    // Wait a bit to ensure different timestamp
    await new Promise(resolve => setTimeout(resolve, 10));

    // Second write with updated provenance
    const updatedTimestamp = new Date().toISOString();
    const updatedOptions: VaultWriteOptions = {
      lastUpdatedBy: updatedActorId,
      lastUpdatedAt: updatedTimestamp,
    };

    await store.write(tenantId, key, updatedBody, updatedOptions);

    const readResult = await store.read(tenantId, key);

    expect(readResult.existed).toBe(true);
    expect(readResult.body).toBe(updatedBody);
    expect(readResult.lastUpdatedBy).toBe(updatedActorId);
    expect(readResult.lastUpdatedAt).toBe(updatedTimestamp);
  });

  it("does not stamp provenance when actorId is not provided", async () => {
    const tenantId = "test-tenant";
    const key = "test-page";
    const body = "Test content";

    await store.write(tenantId, key, body);

    const readResult = await store.read(tenantId, key);

    expect(readResult.existed).toBe(true);
    expect(readResult.body).toBe(body);
    expect(readResult.lastUpdatedBy).toBeUndefined();
    expect(readResult.lastUpdatedAt).toBeUndefined();
  });

  it("handles append mode with provenance stamping", async () => {
    const tenantId = "test-tenant";
    const key = "test-page";
    const initialBody = "Initial content";
    const appendBody = "Appended content";
    const actorId = "test-actor-123";

    // Initial write
    await store.write(tenantId, key, initialBody);

    // Append with provenance
    const timestamp = new Date().toISOString();
    const appendOptions: VaultWriteOptions = {
      mode: "append",
      lastUpdatedBy: actorId,
      lastUpdatedAt: timestamp,
    };

    await store.write(tenantId, key, appendBody, appendOptions);

    const readResult = await store.read(tenantId, key);

    expect(readResult.existed).toBe(true);
    expect(readResult.body).toContain(initialBody);
    expect(readResult.body).toContain(appendBody);
    expect(readResult.lastUpdatedBy).toBe(actorId);
    expect(readResult.lastUpdatedAt).toBe(timestamp);
  });
});
