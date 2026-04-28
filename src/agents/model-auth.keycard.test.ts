import { afterEach, describe, expect, it, vi } from "vitest";
import { registerKeycardProviderLookup } from "./model-auth-runtime-shared.js";
import { resolveApiKeyForProvider } from "./model-auth.js";

describe("resolveApiKeyForProvider with Keycard lookup", () => {
  afterEach(() => {
    registerKeycardProviderLookup(undefined);
  });

  it("returns a Keycard-sourced credential when the lookup resolves", async () => {
    registerKeycardProviderLookup(async (provider) => {
      if (provider === "anthropic") {
        return {
          ok: true,
          apiKey: "kc-anthropic-token",
          source: "keycard:urn:secret:claude-api",
        };
      }
      return undefined;
    });
    const result = await resolveApiKeyForProvider({
      provider: "anthropic",
      cfg: { agent: {} as never } as never,
    });
    expect(result.apiKey).toBe("kc-anthropic-token");
    expect(result.mode).toBe("keycard");
    expect(result.source).toBe("keycard:urn:secret:claude-api");
  });

  it("falls through to the missing-auth error when Keycard returns ok=false", async () => {
    const lookup = vi.fn(async () => ({
      ok: false as const,
      reason: "no-mapping",
      message: "no mapping",
    }));
    registerKeycardProviderLookup(lookup);
    await expect(
      resolveApiKeyForProvider({
        provider: "anthropic-no-key",
        cfg: { agent: {} as never } as never,
      }),
    ).rejects.toThrow(/No API key found for provider "anthropic-no-key"/u);
    expect(lookup).toHaveBeenCalledWith("anthropic-no-key");
  });

  it("does not invoke the Keycard lookup when an env credential is already present", async () => {
    const lookup = vi.fn(async () => ({
      ok: true as const,
      apiKey: "kc-token",
      source: "keycard:urn:secret:claude-api",
    }));
    registerKeycardProviderLookup(lookup);
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "env-anthropic-key";
    try {
      const result = await resolveApiKeyForProvider({
        provider: "anthropic",
        cfg: { agent: {} as never } as never,
      });
      expect(result.apiKey).toBe("env-anthropic-key");
      expect(result.mode).toBe("api-key");
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = original;
      }
    }
  });
});
