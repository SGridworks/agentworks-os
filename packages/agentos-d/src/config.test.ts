import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig legacy bridge env", () => {
  it("uses AWOS-native legacy bridge env vars", () => {
    const config = loadConfig({
      AWOS_LEGACY_BRIDGE_URL: "http://127.0.0.1:7777",
      AWOS_LEGACY_BRIDGE_API_KEY: "new-key",
      AWOS_LEGACY_BRIDGE_ENABLED: "true",
    });

    expect(config.legacyBridgeUrl).toBe("http://127.0.0.1:7777");
    expect(config.legacyBridgeApiKey).toBe("new-key");
    expect(config.legacyBridgeEnabled).toBe(true);
  });

  it("keeps deprecated aliases working for the transition release", () => {
    const priorProduct = "PAPER" + "CLIP";
    const config = loadConfig({
      [`${priorProduct}_API_URL`]: "http://127.0.0.1:8888",
      [`${priorProduct}_API_KEY`]: "old-key",
      [`AGENTOS_${priorProduct}_COMPAT_ENABLED`]: "true",
    });

    expect(config.legacyBridgeUrl).toBe("http://127.0.0.1:8888");
    expect(config.legacyBridgeApiKey).toBe("old-key");
    expect(config.legacyBridgeEnabled).toBe(true);
  });
});
