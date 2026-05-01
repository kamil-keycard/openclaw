import { describe, expect, it } from "vitest";
import { buildSecretInputSchema } from "../plugin-sdk/secret-input-schema.js";
import { SecretProviderSchema, SecretRefSchema } from "./zod-schema.core.js";

const PluginSdkSecretInputSchema = buildSecretInputSchema();

describe("SecretRefSchema (plugin arm)", () => {
  it("accepts a well-formed plugin SecretRef", () => {
    const result = SecretRefSchema.safeParse({
      source: "plugin",
      provider: "keycard",
      id: "openai-api-key",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty id", () => {
    const result = SecretRefSchema.safeParse({
      source: "plugin",
      provider: "keycard",
      id: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a provider that breaks the alias pattern", () => {
    const result = SecretRefSchema.safeParse({
      source: "plugin",
      provider: "Has-Caps",
      id: "openai-api-key",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown source values", () => {
    const result = SecretRefSchema.safeParse({
      source: "wat",
      provider: "keycard",
      id: "openai-api-key",
    });
    expect(result.success).toBe(false);
  });
});

describe("SDK SecretInput schema (plugin arm)", () => {
  it("accepts a plugin-sourced SecretInput", () => {
    const result = PluginSdkSecretInputSchema.safeParse({
      source: "plugin",
      provider: "keycard",
      id: "telegram-bot",
    });
    expect(result.success).toBe(true);
  });
});

describe("SecretProviderSchema (plugin envelope)", () => {
  it("accepts a minimal plugin provider entry", () => {
    const result = SecretProviderSchema.safeParse({
      source: "plugin",
      plugin: "keycard-identity",
    });
    expect(result.success).toBe(true);
  });

  it("preserves opaque plugin payload via passthrough", () => {
    const result = SecretProviderSchema.safeParse({
      source: "plugin",
      plugin: "keycard-identity",
      resources: { "openai-api-key": { resource: "https://api.openai.com" } },
      arbitraryField: { nested: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.resources).toBeDefined();
      expect(data.arbitraryField).toEqual({ nested: true });
    }
  });

  it("rejects entries missing the plugin field", () => {
    const result = SecretProviderSchema.safeParse({
      source: "plugin",
    });
    expect(result.success).toBe(false);
  });

  it("rejects plugin field violating the kebab-case pattern", () => {
    const result = SecretProviderSchema.safeParse({
      source: "plugin",
      plugin: "Keycard_Identity",
    });
    expect(result.success).toBe(false);
  });
});
