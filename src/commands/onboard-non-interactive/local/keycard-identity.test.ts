import { describe, expect, it } from "vitest";
import { applyKeycardIdentityFromOptions, parseKeycardProviderFlags } from "./keycard-identity.js";

describe("parseKeycardProviderFlags", () => {
  it("ignores empty entries", () => {
    const result = parseKeycardProviderFlags(["", "  "]);
    expect(result.providers).toEqual({});
    expect(result.errors).toEqual([]);
  });

  it("parses provider=resource pairs and trims whitespace", () => {
    const result = parseKeycardProviderFlags([
      " anthropic = urn:secret:claude-api ",
      "openai=urn:secret:openai-api",
    ]);
    expect(result.providers).toEqual({
      anthropic: { resource: "urn:secret:claude-api" },
      openai: { resource: "urn:secret:openai-api" },
    });
    expect(result.errors).toEqual([]);
  });

  it("collects errors for malformed entries", () => {
    const result = parseKeycardProviderFlags(["anthropic", "=urn:foo", "openai="]);
    expect(result.providers).toEqual({});
    expect(result.errors).toHaveLength(3);
    for (const err of result.errors) {
      expect(err).toMatch(/Invalid --keycard-provider value/u);
    }
  });

  it("last duplicate wins", () => {
    const result = parseKeycardProviderFlags(["anthropic=urn:secret:a", "anthropic=urn:secret:b"]);
    expect(result.providers).toEqual({ anthropic: { resource: "urn:secret:b" } });
  });
});

describe("applyKeycardIdentityFromOptions", () => {
  it("ignores empty zone ids", () => {
    const config = applyKeycardIdentityFromOptions({}, { zoneId: "  " });
    expect(config).toEqual({});
  });

  it("writes zone id without providers when none are supplied (defaults applied at runtime)", () => {
    const config = applyKeycardIdentityFromOptions({}, { zoneId: "zone-x" });
    expect(config.gateway?.identity?.keycard).toEqual({ zoneId: "zone-x" });
  });

  it("merges supplied providers verbatim", () => {
    const config = applyKeycardIdentityFromOptions(
      {},
      {
        zoneId: " zone-y ",
        providers: {
          anthropic: { resource: " urn:secret:claude-api " },
          openai: { resource: "urn:secret:openai-api" },
        },
      },
    );
    expect(config.gateway?.identity?.keycard).toEqual({
      zoneId: "zone-y",
      providers: {
        anthropic: { resource: "urn:secret:claude-api" },
        openai: { resource: "urn:secret:openai-api" },
      },
    });
  });

  it("preserves unrelated gateway/identity keys", () => {
    const next = applyKeycardIdentityFromOptions(
      { gateway: { auth: { mode: "token", token: "tok" } } },
      { zoneId: "zone-z" },
    );
    expect(next.gateway?.auth).toEqual({ mode: "token", token: "tok" });
    expect(next.gateway?.identity?.keycard?.zoneId).toBe("zone-z");
  });
});
