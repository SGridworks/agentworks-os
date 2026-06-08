import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProfile, resolveProfilePath } from "./local-profile.js";

describe("local profile env fallback", () => {
  it("reports no JSON profile path when only env fallback exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "awos-profile-"));
    const profilePath = path.join(dir, "missing-profile.json");

    expect(resolveProfilePath({
      envOverrides: { AGENTWORKS_LOCAL_PROFILE: profilePath },
    })).toBeNull();
  });

  it("derives allowedFallbackModel from the bridge-required env value", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "awos-profile-"));
    const envPath = path.join(dir, "awos-local.env");
    await writeFile(
      envPath,
      [
        "AWOS_REPO_ROOT=/tmp/awos",
        "AGENTOS_DATA_DIR=/tmp/awos-data",
        "VAULT_ROOT=/tmp/vault",
        "AGENTOS_PORT=17710",
        "AWOS_ADMIN_UI_PORT=13000",
        "FALLBACK_MODEL=older-model",
        "AWOS_BRIDGE_REQUIRED_FALLBACK_MODEL=nemotron-3-nano:30b",
        "",
      ].join("\n"),
      "utf8",
    );

    const profile = await loadProfile({
      envFilePath: envPath,
      envOverrides: {},
    });

    expect(profile.allowedFallbackModel).toBe("nemotron-3-nano:30b");
    expect(profile.ports.api).toBe(17710);
    expect(profile.ports.admin).toBe(13000);
  });

  it("falls back to FALLBACK_MODEL when the bridge-required value is absent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "awos-profile-"));
    const envPath = path.join(dir, "awos-local.env");
    await writeFile(
      envPath,
      [
        "AWOS_REPO_ROOT=/tmp/awos",
        "AGENTOS_DATA_DIR=/tmp/awos-data",
        "VAULT_ROOT=/tmp/vault",
        "FALLBACK_MODEL=local-fallback-model",
        "",
      ].join("\n"),
      "utf8",
    );

    const profile = await loadProfile({
      envFilePath: envPath,
      envOverrides: {},
    });

    expect(profile.allowedFallbackModel).toBe("local-fallback-model");
  });
});
