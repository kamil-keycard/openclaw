import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getKeycardProviderLookup,
  registerKeycardProviderLookup,
} from "../../agents/model-auth-runtime-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setupKeycardIdentityForGateway } from "./gateway-startup.js";
import { clearActiveKeycardResolverForTests, getActiveKeycardResolver } from "./registry.js";

function makeLog() {
  const info: string[] = [];
  const warn: string[] = [];
  const debug: string[] = [];
  return {
    info,
    warn,
    debug,
    log: {
      info: (m: string) => info.push(m),
      warn: (m: string) => warn.push(m),
      debug: (m: string) => debug.push(m),
    },
  };
}

function makeConfig(keycard?: OpenClawConfig["gateway"] & object): OpenClawConfig {
  return {
    gateway: keycard,
  } as unknown as OpenClawConfig;
}

afterEach(() => {
  clearActiveKeycardResolverForTests();
  registerKeycardProviderLookup(undefined);
  vi.restoreAllMocks();
});

describe("setupKeycardIdentityForGateway", () => {
  it("returns not-configured when gateway.identity.keycard is missing", async () => {
    const { log } = makeLog();
    const result = await setupKeycardIdentityForGateway({
      config: makeConfig(),
      log,
    });
    expect(result.installed).toBe(false);
    expect(result.reason).toBe("not-configured");
    expect(getActiveKeycardResolver()).toBeUndefined();
    expect(getKeycardProviderLookup()).toBeUndefined();
  });

  it("returns not-configured when zoneId is empty", async () => {
    const { log } = makeLog();
    const result = await setupKeycardIdentityForGateway({
      config: makeConfig({ identity: { keycard: { zoneId: "  " } } }),
      log,
    });
    expect(result.installed).toBe(false);
    expect(result.reason).toBe("not-configured");
  });

  it("warns and skips wiring when off macOS", async () => {
    if (process.platform === "darwin") {
      // We cannot pretend to be off-darwin from here without monkey-patching
      // process.platform; rely on the cross-platform branch tests below.
      return;
    }
    const { log, warn } = makeLog();
    const result = await setupKeycardIdentityForGateway({
      config: makeConfig({ identity: { keycard: { zoneId: "zone-test" } } }),
      log,
    });
    expect(result.installed).toBe(false);
    expect(result.reason).toBe("not-darwin");
    expect(warn.some((m) => m.includes("only supported on macOS"))).toBe(true);
    expect(getActiveKeycardResolver()).toBeUndefined();
    expect(getKeycardProviderLookup()).toBeUndefined();
  });

  it("warns and skips wiring when platform is forced off-darwin", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const { log, warn } = makeLog();
      const result = await setupKeycardIdentityForGateway({
        config: makeConfig({ identity: { keycard: { zoneId: "zone-test" } } }),
        log,
      });
      expect(result.installed).toBe(false);
      expect(result.reason).toBe("not-darwin");
      expect(warn.some((m) => m.includes("only supported on macOS"))).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });
});
