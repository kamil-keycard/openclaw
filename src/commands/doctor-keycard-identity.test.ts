import { describe, expect, it } from "vitest";
import { runKeycardIdentityDoctor } from "./doctor-keycard-identity.js";

const baseConfig = {
  gateway: { identity: { keycard: { zoneId: "zone-test" } } },
};

describe("runKeycardIdentityDoctor", () => {
  it("is a no-op when keycard identity is not configured", async () => {
    const result = await runKeycardIdentityDoctor({}, { platform: "darwin" });
    expect(result.configured).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("errors when the host is not macOS", async () => {
    const result = await runKeycardIdentityDoctor(baseConfig, {
      platform: "linux",
      socketExists: () => true,
    });
    expect(result.configured).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/only supported on macOS/u);
  });

  it("errors when the daemon socket is missing", async () => {
    const result = await runKeycardIdentityDoctor(baseConfig, {
      platform: "darwin",
      socketExists: () => false,
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/socket not found/u);
  });

  it("reports configured provider mappings when socket is present", async () => {
    const result = await runKeycardIdentityDoctor(baseConfig, {
      platform: "darwin",
      socketExists: () => true,
    });
    expect(result.errors).toEqual([]);
    const summary = result.infos.join("\n");
    expect(summary).toMatch(/anthropic=urn:secret:claude-api/u);
    expect(summary).toMatch(/openai=urn:secret:openai-api/u);
  });

  it("warns when deep discovery probe fails", async () => {
    const result = await runKeycardIdentityDoctor(baseConfig, {
      platform: "darwin",
      socketExists: () => true,
      deep: true,
      discoverMetadata: () => Promise.reject(new Error("boom")),
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/discovery failed/u);
  });

  it("reports the discovered token endpoint when the deep probe succeeds", async () => {
    const result = await runKeycardIdentityDoctor(baseConfig, {
      platform: "darwin",
      socketExists: () => true,
      deep: true,
      discoverMetadata: async () => ({ token_endpoint: "https://example/token" }),
    });
    expect(result.warnings).toEqual([]);
    expect(result.infos.some((line) => line.includes("https://example/token"))).toBe(true);
  });

  it("does not perform deep probes by default", async () => {
    let called = false;
    const result = await runKeycardIdentityDoctor(baseConfig, {
      platform: "darwin",
      socketExists: () => true,
      discoverMetadata: () => {
        called = true;
        return Promise.resolve({ token_endpoint: "x" });
      },
    });
    expect(called).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});
