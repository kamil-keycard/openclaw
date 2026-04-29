import { describe, expect, it } from "vitest";
import { describeKeycardMappingForProvider, providerHasKeycardMapping } from "./types.js";

describe("providerHasKeycardMapping", () => {
  it("returns false when keycard config is missing", () => {
    expect(providerHasKeycardMapping(undefined, "anthropic")).toBe(false);
    expect(providerHasKeycardMapping({}, "anthropic")).toBe(false);
    expect(providerHasKeycardMapping({ gateway: {} }, "anthropic")).toBe(false);
  });

  it("returns false when zoneId is empty", () => {
    expect(
      providerHasKeycardMapping(
        { gateway: { identity: { keycard: { zoneId: "  " } } } },
        "anthropic",
      ),
    ).toBe(false);
  });

  it("returns true for built-in default mappings when zoneId is set", () => {
    const config = { gateway: { identity: { keycard: { zoneId: "zone-1" } } } };
    expect(providerHasKeycardMapping(config, "anthropic")).toBe(true);
    expect(providerHasKeycardMapping(config, "openai")).toBe(true);
  });

  it("returns false for unmapped providers without explicit config", () => {
    const config = { gateway: { identity: { keycard: { zoneId: "zone-1" } } } };
    expect(providerHasKeycardMapping(config, "groq")).toBe(false);
  });

  it("honors explicit per-provider mappings", () => {
    const config = {
      gateway: {
        identity: {
          keycard: {
            zoneId: "zone-1",
            providers: { custom: { resource: "urn:secret:custom" } },
          },
        },
      },
    };
    expect(providerHasKeycardMapping(config, "custom")).toBe(true);
  });

  it("returns false when provider id is missing", () => {
    expect(
      providerHasKeycardMapping(
        { gateway: { identity: { keycard: { zoneId: "zone-1" } } } },
        undefined,
      ),
    ).toBe(false);
  });
});

describe("describeKeycardMappingForProvider", () => {
  it("returns the trimmed zone id and resource for a mapped provider", () => {
    const result = describeKeycardMappingForProvider(
      { gateway: { identity: { keycard: { zoneId: " zone-1 " } } } },
      "anthropic",
    );
    expect(result).toEqual({ zoneId: "zone-1", resource: "urn:secret:claude-api" });
  });

  it("returns undefined when no mapping applies", () => {
    expect(
      describeKeycardMappingForProvider(
        { gateway: { identity: { keycard: { zoneId: "zone-1" } } } },
        "groq",
      ),
    ).toBeUndefined();
  });
});
